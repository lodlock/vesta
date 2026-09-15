// "What time is it in Norway?" answered from the device, not from the model.
//
// Vesta used to reply that it had no live data access and suggest a world
// clock. That answer is wrong twice over: the device knows the current instant,
// and Android ships the IANA tz database — the same one java.time reads, with
// DST rules and historical transitions, updated by the OS. Converting an
// instant into another zone is a lookup, not a fact to be recalled, and a 4B
// model recalling UTC offsets is exactly the kind of confident wrongness this
// project exists to avoid.
//
// So the conversion is done here, with Intl (ICU-backed, the same tzdata), and
// the model is never asked for an offset. `now` is always injected, so every
// answer is reproducible and the tests run on a fixed clock.
//
// Ambiguity policy, matching the rest of Vesta: a country that genuinely spans
// zones gets a question, not a guess. See lib/time/zones.ts.

import type { Language } from "../orchestrator/types";
import { resolveZone, zoneLabel } from "./zones";

export type TimeQuestionKind =
  | "time" // what time is it (there)
  | "date" // what day/date is it (there)
  | "zone" // which zone am I in
  | "difference"; // how far apart are two places

export interface TimeQuestion {
  kind: TimeQuestionKind;
  /** The place asked about, or null for "here". */
  place: string | null;
  /** The second place, for a difference question. */
  other?: string | null;
  /**
   * The utterance this was parsed from, with the place still in it. Used to
   * build the resume text when the place turns out to be ambiguous.
   */
  source?: string;
}

export type TimeAnswer =
  | { status: "resolved"; text: string }
  | {
      status: "ambiguous";
      question: string;
      /**
       * The question with the ambiguous place removed, so the user's one-word
       * follow-up completes it: "what time is it in" + "Chicago". Absent when
       * the utterance cannot be rewritten that way (a two-place difference
       * question), in which case the follow-up is a fresh turn.
       *
       * The point is that answering "which city?" must not mean saying the
       * whole question again — the same courtesy the scheduling parser's
       * clarifications already get.
       */
      resume?: string;
    };

// ── Asking ──────────────────────────────────────────────────────────────────

// Kept tight on purpose. This runs before the model on every utterance, so a
// loose pattern here would swallow real questions ("what time should I leave?")
// and answer them with a clock reading. Anything not matched falls through
// untouched, exactly as before.
const PATTERNS: { kind: TimeQuestionKind; re: RegExp; lang: Language }[] = [
  // ── English ──
  // "what time is it (in X)", "what's the time (in X)", "current time in X"
  {
    kind: "time",
    lang: "en",
    re: /^(?:hey\s+)?(?:what(?:'s| is)?\s+(?:the\s+)?time|what\s+time\s+is\s+it|tell\s+me\s+the\s+time|current\s+time|the\s+time)(?:\s+(?:right\s+)?now)?(?:\s+(?:in|at|over\s+in)\s+(?<place>.+?))?\s*\??$/i,
  },
  // "what day/date is it (in X)"
  {
    kind: "date",
    lang: "en",
    re: /^(?:what(?:'s| is)?\s+(?:the\s+)?(?:date|day)|what\s+(?:day|date)\s+is\s+it|today(?:'s)?\s+date)(?:\s+(?:of\s+the\s+week\s+)?(?:is\s+it\s+)?)?(?:\s*(?:in|at)\s+(?<place>.+?))?\s*\??$/i,
  },
  // "what's my timezone", "what timezone am I in"
  {
    kind: "zone",
    lang: "en",
    re: /^(?:what(?:'s| is)?\s+(?:my|the)\s+(?:current\s+)?time\s?zone|what\s+time\s?zone\s+(?:am\s+i\s+in|is\s+this|are\s+we\s+in)|which\s+time\s?zone\s+am\s+i\s+in)\s*\??$/i,
  },
  // "time difference between here and London"
  {
    kind: "difference",
    lang: "en",
    re: /^(?:what(?:'s| is)?\s+the\s+)?time\s+(?:difference|gap)\s+between\s+(?<place>.+?)\s+and\s+(?<other>.+?)\s*\??$/i,
  },
  // "how many hours ahead/behind is Tokyo"
  {
    kind: "difference",
    lang: "en",
    re: /^how\s+(?:many\s+hours|far)\s+(?:ahead|behind|apart)\s+(?:is|are)\s+(?<place>.+?)(?:\s+(?:from|of|than)\s+(?<other>.+?))?\s*\??$/i,
  },
  // ── Italian ──
  {
    kind: "time",
    lang: "it",
    re: /^(?:che\s+(?:ore\s+sono|ora\s+(?:è|e))|dimmi\s+l'?ora|ora\s+attuale)(?:\s+(?:in|a|ad)\s+(?<place>.+?))?\s*\??$/i,
  },
  {
    kind: "date",
    lang: "it",
    re: /^(?:che\s+(?:giorno\s+(?:è|e)|data\s+(?:è|e))|in\s+che\s+giorno\s+siamo|che\s+giorno\s+siamo)(?:\s+(?:oggi)?)?(?:\s*(?:in|a|ad)\s+(?<place>.+?))?\s*\??$/i,
  },
  {
    kind: "zone",
    lang: "it",
    re: /^(?:qual\s+(?:è|e)\s+(?:il\s+)?mio\s+fuso\s+orario|in\s+che\s+fuso\s+orario\s+sono|che\s+fuso\s+orario\s+(?:è|e)\s+questo)\s*\??$/i,
  },
  {
    kind: "difference",
    lang: "it",
    re: /^(?:qual\s+(?:è|e)\s+(?:la\s+)?)?differenza\s+(?:di\s+)?(?:orario|fuso)\s+tra\s+(?<place>.+?)\s+e\s+(?<other>.+?)\s*\??$/i,
  },
];

/** Words meaning "where I am", which resolve to the device zone. */
const HERE = /^(?:here|my\s+(?:location|place)|home|local|qui|qua|casa)$/i;

function cleanPlace(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/[?!.]+$/u, "").trim();
  if (!trimmed || HERE.test(trimmed)) return null;
  return trimmed;
}

/**
 * The time/date question this utterance is, or null.
 *
 * Null is the common case and means "not one of ours" — the utterance carries
 * on to the model untouched.
 */
export function parseTimeQuestion(text: string, lang: Language): TimeQuestion | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  // Both languages are tried: the recognizer's language is not always the app's.
  const ordered = [
    ...PATTERNS.filter((p) => p.lang === lang),
    ...PATTERNS.filter((p) => p.lang !== lang),
  ];
  for (const { kind, re } of ordered) {
    const match = re.exec(normalized);
    if (!match) continue;
    const groups = match.groups ?? {};
    return {
      kind,
      place: cleanPlace(groups.place),
      other: cleanPlace(groups.other),
      source: normalized,
    };
  }
  return null;
}

// ── Answering ───────────────────────────────────────────────────────────────

/** The device's own zone. Isolated so tests can inject one. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface ZoneParts {
  hour: number;
  minute: number;
  year: number;
  month: number;
  day: number;
  weekday: string;
  /** The zone's short name at this instant — "CEST", "GMT+2". */
  abbreviation: string;
}

/**
 * The wall-clock fields of `instant` in `zone`.
 *
 * Via Intl rather than arithmetic: the offset for an instant depends on that
 * zone's DST rules on that date, which is precisely the thing not to
 * reimplement. `formatToParts` gives the numbers ICU computed from tzdata.
 */
export function partsIn(instant: Date, zone: string, locale = "en-GB"): ZoneParts {
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    timeZoneName: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday ?? "",
    abbreviation: parts.timeZoneName ?? "",
  };
}

/** True when `zone` is one this device's ICU data actually knows. */
export function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes `zone` is offset from UTC at `instant`, DST included. */
export function offsetMinutes(instant: Date, zone: string): number {
  const p = partsIn(instant, zone);
  // Reconstruct the zone's wall clock as if it were UTC, then compare. Both
  // sides are whole minutes, so the difference is the offset.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const actual = Math.floor(instant.getTime() / 60000) * 60000;
  return Math.round((asUtc - actual) / 60000);
}

function hhmm(p: ZoneParts): string {
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "3 hours ahead" / "90 minutes behind" / "the same time". */
function describeDelta(minutes: number, lang: Language): string {
  if (minutes === 0) return lang === "it" ? "la stessa ora" : "the same time";
  const ahead = minutes > 0;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(lang === "it" ? `${h} ${h === 1 ? "ora" : "ore"}` : `${h} ${h === 1 ? "hour" : "hours"}`);
  if (m > 0) parts.push(lang === "it" ? `${m} minuti` : `${m} minutes`);
  const span = parts.join(lang === "it" ? " e " : " and ");
  if (lang === "it") return `${span} ${ahead ? "avanti" : "indietro"}`;
  return `${span} ${ahead ? "ahead" : "behind"}`;
}

/** Same calendar day, one day on, one day back — relative to `reference`. */
function dayRelation(there: ZoneParts, here: ZoneParts): -1 | 0 | 1 {
  const a = there.year * 10000 + there.month * 100 + there.day;
  const b = here.year * 10000 + here.month * 100 + here.day;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function localeFor(lang: Language): string {
  return lang === "it" ? "it-IT" : "en-GB";
}

/**
 * Answers a parsed question against a fixed instant.
 *
 * `homeZone` is injected rather than read, so a test can pin the device zone
 * and a caller can pass whatever the platform reports.
 */
export function answerTimeQuestion(
  question: TimeQuestion,
  now: Date,
  homeZone: string,
  lang: Language,
): TimeAnswer {
  const locale = localeFor(lang);
  const it = lang === "it";

  // "What time is it in the United States?" → "What time is it in", so the
  // follow-up "Chicago" completes it. Only for the single-place forms: a
  // difference question has two slots and no unambiguous place to append to.
  const resumeFor = (place: string): string | undefined => {
    if (question.kind === "difference") return undefined;
    const source = question.source;
    if (!source) return undefined;
    const at = source.toLowerCase().lastIndexOf(place.toLowerCase());
    if (at <= 0) return undefined;
    const head = source.slice(0, at).replace(/[?!.,\s]+$/u, "").trim();
    return head || undefined;
  };

  const lookup = (place: string): TimeAnswer | { zone: string; label: string } => {
    const found = resolveZone(place);
    if (found.status === "ambiguous") {
      const list = found.examples.join(", ");
      return {
        status: "ambiguous",
        question: it
          ? `${found.place} ha più fusi orari. Quale città? Per esempio ${list}.`
          : `${found.place} spans several time zones. Which city — ${list}?`,
        resume: resumeFor(place),
      };
    }
    if (found.status === "unknown" || !isKnownZone(found.zone)) {
      return {
        status: "ambiguous",
        question: it
          ? `Non conosco il fuso orario di "${place}". Puoi dirmi una città?`
          : `I don't know the time zone for "${place}". Which city do you mean?`,
        resume: resumeFor(place),
      };
    }
    return { zone: found.zone, label: found.label };
  };

  if (question.kind === "zone") {
    const p = partsIn(now, homeZone, locale);
    const offset = offsetMinutes(now, homeZone);
    const sign = offset >= 0 ? "+" : "−";
    const oh = Math.floor(Math.abs(offset) / 60);
    const om = Math.abs(offset) % 60;
    const utc = `UTC${sign}${oh}${om ? `:${String(om).padStart(2, "0")}` : ""}`;
    return {
      status: "resolved",
      text: it
        ? `Sei in ${homeZone} (${p.abbreviation}, ${utc}). Ora sono le ${hhmm(p)}.`
        : `You're in ${homeZone} (${p.abbreviation}, ${utc}). It's ${hhmm(p)}.`,
    };
  }

  if (question.kind === "difference") {
    const fromPlace = question.place;
    const toPlace = question.other;
    const from = fromPlace ? lookup(fromPlace) : { zone: homeZone, label: it ? "qui" : "here" };
    if ("status" in from) return from;
    const to = toPlace ? lookup(toPlace) : { zone: homeZone, label: it ? "qui" : "here" };
    if ("status" in to) return to;

    const delta = offsetMinutes(now, to.zone) - offsetMinutes(now, from.zone);
    const there = partsIn(now, to.zone, locale);
    return {
      status: "resolved",
      text: it
        ? `${to.label} è ${describeDelta(delta, lang)} rispetto a ${from.label}. Lì sono le ${hhmm(there)}.`
        : `${to.label} is ${describeDelta(delta, lang)} of ${from.label}. It's ${hhmm(there)} there.`,
    };
  }

  // time / date, here or elsewhere.
  const target = question.place
    ? lookup(question.place)
    : { zone: homeZone, label: it ? "qui" : "here" };
  if ("status" in target) return target;

  const there = partsIn(now, target.zone, locale);
  const here = partsIn(now, homeZone, locale);
  const dateText = new Intl.DateTimeFormat(locale, {
    timeZone: target.zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  if (question.kind === "date") {
    if (!question.place) {
      return { status: "resolved", text: it ? `Oggi è ${dateText}.` : `Today is ${dateText}.` };
    }
    return {
      status: "resolved",
      text: it
        ? `A ${target.label} è ${dateText}.`
        : `In ${target.label} it's ${dateText}.`,
    };
  }

  if (!question.place) {
    return {
      status: "resolved",
      text: it ? `Sono le ${hhmm(there)}.` : `It's ${hhmm(there)}.`,
    };
  }

  // Elsewhere: say the time, and say so when it isn't even the same day —
  // "It's 01:15 in Tokyo" is misleading on its own when here it's still
  // yesterday afternoon.
  const relation = dayRelation(there, here);
  const dayNote =
    relation === 0
      ? ""
      : relation === 1
        ? it
          ? ` — già ${there.weekday}, il giorno dopo rispetto a qui`
          : ` — already ${there.weekday}, the next day`
        : it
          ? ` — ancora ${there.weekday}, il giorno prima rispetto a qui`
          : ` — still ${there.weekday}, the previous day`;

  const delta = offsetMinutes(now, target.zone) - offsetMinutes(now, homeZone);
  const deltaNote =
    delta === 0 ? "" : it ? ` (${describeDelta(delta, lang)})` : ` (${describeDelta(delta, lang)})`;

  return {
    status: "resolved",
    text: it
      ? `A ${target.label} sono le ${hhmm(there)}${deltaNote}${dayNote}.`
      : `It's ${hhmm(there)} in ${target.label}${deltaNote}${dayNote}.`,
  };
}

/**
 * The whole path in one call: utterance in, answer out, null when it wasn't a
 * time question. `now` and `homeZone` are injected for reproducibility.
 */
export function answerIfTimeQuestion(
  text: string,
  lang: Language,
  now: Date = new Date(),
  homeZone: string = deviceZone(),
): TimeAnswer | null {
  const question = parseTimeQuestion(text, lang);
  if (!question) return null;
  return answerTimeQuestion(question, now, homeZone, lang);
}
