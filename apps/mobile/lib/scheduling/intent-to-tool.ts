// Maps a resolved ScheduleIntent onto the EXISTING tool call, and writes the
// confirmation the user sees. Nothing here talks to the device: the call goes
// through the same tool-dispatcher → SystemActionsModule path as a model-routed
// call, so validation, the confirmation gate and the Android intents are
// unchanged. The parser only decides WHAT to ask for, never how it runs.

import { localDateStr, pad2, addDays } from "../orchestrator/date-utils";
import type { Language } from "../orchestrator/types";
import type { AmbiguityReason, ScheduleIntent } from "./parse";

export interface ResolvedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
  message: string;
}

// "YYYY-MM-DDTHH:MM:SS" in LOCAL time — what the tool schemas specify and what
// the native side parses as a local datetime.
function localIso(d: Date): string {
  return `${localDateStr(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDuration(seconds: number, lang: Language): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  const unit = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (lang === "it") {
    if (h) parts.push(unit(h, "ora", "ore"));
    if (m) parts.push(unit(m, "minuto", "minuti"));
    if (s) parts.push(unit(s, "secondo", "secondi"));
    return parts.join(" e ");
  }
  if (h) parts.push(unit(h, "hour", "hours"));
  if (m) parts.push(unit(m, "minute", "minutes"));
  if (s) parts.push(unit(s, "second", "seconds"));
  return parts.join(" ");
}

// The day, relative to `now`, in words the user just used.
function dayPhrase(target: Date, now: Date, lang: Language): string {
  const t = localDateStr(target);
  if (t === localDateStr(now)) return lang === "it" ? "oggi" : "today";
  if (t === localDateStr(addDays(now, 1))) return lang === "it" ? "domani" : "tomorrow";
  return t;
}

// Android's AlarmClock.ACTION_SET_ALARM cannot schedule a specific date: it
// always arms the next occurrence of the time. When the parsed date IS that
// next occurrence the alarm is exactly what the user asked for; when it isn't,
// say so rather than confirming something Android won't do.
function alarmCaveat(time: string, date: string | undefined, now: Date, lang: Language): string {
  if (!date) return "";
  const [h, m] = time.split(":").map(Number);
  const todayAt = new Date(now);
  todayAt.setHours(h, m, 0, 0);
  const next = todayAt.getTime() > now.getTime() ? todayAt : addDays(todayAt, 1);
  if (localDateStr(next) === date) return "";
  return lang === "it"
    ? ` (Android imposta la prossima occorrenza di questo orario, non il ${date}.)`
    : ` (Android arms the next occurrence of this time, not ${date}.)`;
}

export function intentToToolCall(
  intent: ScheduleIntent,
  now: Date,
  lang: Language,
): ResolvedToolCall {
  switch (intent.kind) {
    case "timer": {
      const pretty = formatDuration(intent.durationSeconds, lang);
      return {
        tool: "set_timer",
        // set_timer's schema is in minutes; a sub-minute timer is a fraction,
        // which the native bridge converts back to whole seconds.
        parameters: {
          minutes: intent.durationSeconds / 60,
          ...(intent.label ? { label: intent.label } : {}),
        },
        message:
          lang === "it"
            ? `Timer di ${pretty}${intent.label ? ` (${intent.label})` : ""}`
            : `Timer set for ${pretty}${intent.label ? ` (${intent.label})` : ""}`,
      };
    }
    case "alarm": {
      const when = intent.date
        ? ` ${dayPhrase(new Date(`${intent.date}T00:00:00`), now, lang)}`
        : "";
      return {
        tool: "set_alarm",
        parameters: {
          time: intent.time,
          ...(intent.date ? { date: intent.date } : {}),
          ...(intent.label ? { label: intent.label } : {}),
        },
        message:
          (lang === "it"
            ? `Sveglia alle ${intent.time}${when}`
            : `Alarm set for ${intent.time}${when}`) +
          alarmCaveat(intent.time, intent.date, now, lang),
      };
    }
    case "reminder": {
      const when = `${dayPhrase(intent.dateTime, now, lang)} ${hhmm(intent.dateTime)}`;
      return {
        tool: "set_reminder",
        parameters: { text: intent.text, datetime: localIso(intent.dateTime) },
        message:
          lang === "it"
            ? `Promemoria ${when}: ${intent.text}`
            : `Reminder ${when}: ${intent.text}`,
      };
    }
    case "calendarEvent": {
      const when = `${dayPhrase(intent.start, now, lang)} ${hhmm(intent.start)}`;
      return {
        tool: "create_event",
        parameters: {
          title: intent.title,
          start: localIso(intent.start),
          ...(intent.end ? { end: localIso(intent.end) } : {}),
        },
        message:
          lang === "it"
            ? `Evento "${intent.title}" ${when}`
            : `Event "${intent.title}" ${when}`,
      };
    }
  }
}

// What to ask when the command was recognized but not safely resolvable. These
// are questions, never a best guess: the whole point of returning `ambiguous`
// is that arming the wrong time is worse than one more exchange.
export function clarificationFor(
  reason: AmbiguityReason,
  lang: Language,
): string {
  const en: Record<AmbiguityReason, string> = {
    "missing-duration": "How long should the timer be?",
    "missing-time": "What time should I set it for?",
    "missing-subject": "What should I remind you about?",
    "ambiguous-meridiem": "Do you mean 12 noon or 12 midnight?",
    "compound-request":
      "That sounded like two things at once — which should I set first?",
    "out-of-range": "That duration doesn't look right — how long should it be?",
    "time-in-past": "That time has already passed — when should I set it for?",
  };
  const it: Record<AmbiguityReason, string> = {
    "missing-duration": "Di quanto deve essere il timer?",
    "missing-time": "A che ora lo imposto?",
    "missing-subject": "Cosa devo ricordarti?",
    "ambiguous-meridiem": "Intendi mezzogiorno o mezzanotte?",
    "compound-request":
      "Mi sembrano due cose insieme — quale imposto per prima?",
    "out-of-range": "Quella durata non torna — di quanto deve essere?",
    "time-in-past": "Quell'orario è già passato — per quando lo imposto?",
  };
  return lang === "it" ? it[reason] : en[reason];
}
