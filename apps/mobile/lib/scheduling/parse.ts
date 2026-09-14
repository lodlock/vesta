// Deterministic parser for spoken scheduling commands.
//
// Scope is deliberately narrow: timers, alarms, reminders and calendar events,
// expressed as a small structured type. It is NOT a general NLU layer — an
// utterance it doesn't confidently recognize returns `none` and the LLM handles
// it exactly as before. What it buys is that the high-frequency, high-risk
// commands (the ones that arm a device alarm) resolve the same way every time,
// with no model in the loop and no sampling variance.
//
// Safety rule, applied everywhere below: prefer asking over guessing. A
// recognized scheduling command whose value is missing, conflicting or
// genuinely two-way ambiguous returns `ambiguous` with a reason, which the
// caller turns into a question. Silently choosing 19:00 when the user may have
// meant 07:00 is the failure mode this exists to prevent.
//
// Pure and unit-tested: `now` is always injected, never read from the clock.

import { localDateStr, addDays, pad2 } from "../orchestrator/date-utils";
import type { Language } from "../orchestrator/types";
import { normalizeUtterance } from "./normalize";

export type ScheduleIntent =
  | { kind: "timer"; durationSeconds: number; label?: string }
  // HH:MM (+ optional YYYY-MM-DD) rather than a Date: this is what Android's
  // AlarmClock intent takes, and the date is advisory (see intent-to-tool).
  | { kind: "alarm"; time: string; date?: string; label?: string }
  | { kind: "reminder"; dateTime: Date; text: string }
  | { kind: "calendarEvent"; start: Date; end?: Date; title: string };

export type AmbiguityReason =
  | "missing-duration"
  | "missing-time"
  | "missing-subject"
  | "ambiguous-meridiem"
  | "compound-request"
  | "out-of-range"
  | "time-in-past";

export type ScheduleParse =
  | { status: "resolved"; intent: ScheduleIntent; normalized: string }
  | { status: "ambiguous"; reason: AmbiguityReason; normalized: string }
  | { status: "none" };

type Family = "timer" | "alarm" | "reminder" | "calendar";

// ── Vocabulary ──────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<Language, Record<string, number>> = {
  en: {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  },
  it: {
    un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6,
    sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12,
    tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17,
    diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40,
    cinquanta: 50, sessanta: 60,
  },
};

const UNITS: Record<Language, Record<string, number>> = {
  en: {
    second: 1, seconds: 1, sec: 1, secs: 1,
    minute: 60, minutes: 60, min: 60, mins: 60,
    hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
  },
  it: {
    secondo: 1, secondi: 1, sec: 1,
    minuto: 60, minuti: 60, min: 60,
    ora: 3600, ore: 3600,
  },
};

const TRIGGERS: Record<Language, Record<Family, string[]>> = {
  en: {
    timer: ["timer", "countdown", "time me"],
    alarm: ["alarm", "wake me", "wake up", "set an alarm"],
    reminder: ["remind me", "reminder", "remind"],
    calendar: ["schedule", "appointment", "meeting", "calendar", "book"],
  },
  it: {
    timer: ["timer", "conto alla rovescia"],
    alarm: ["sveglia", "svegliami", "sveglie"],
    reminder: ["ricordami", "promemoria", "ricordamelo"],
    calendar: ["appuntamento", "evento", "agenda", "calendario", "fissa"],
  },
};

// "give me forty-five minutes" is a timer even without the word "timer" — but
// only when a duration follows, so "give me a hand" is not. Kept deliberately
// tiny: every phrase here can also open an unrelated sentence, and a false
// positive turns a normal request into a spurious compound-request question.
const IMPLICIT_TIMER: Record<Language, string[]> = {
  en: ["give me"],
  it: ["dammi"],
};

// Openers that make the utterance a question about scheduling rather than a
// command to schedule ("when is my meeting", "what reminders do I have").
const QUESTION_OPENERS: Record<Language, string[]> = {
  en: ["what", "when", "where", "who", "why", "how", "do", "does", "did", "is", "are", "was", "can", "could", "should", "would", "will", "have", "has"],
  it: ["cosa", "che", "quando", "dove", "chi", "perché", "come", "quanto", "quali", "quale", "ho", "hai"],
};

const TODAY_WORDS: Record<Language, string[]> = { en: ["today"], it: ["oggi"] };
const TOMORROW_WORDS: Record<Language, string[]> = {
  en: ["tomorrow"],
  it: ["domani"],
};
const WEEKDAYS: Record<Language, string[]> = {
  en: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  it: ["domenica", "lunedì", "lunedi", "martedì", "martedi", "mercoledì", "mercoledi", "giovedì", "giovedi", "venerdì", "venerdi", "sabato"],
};

// Parts of day that settle a bare 12-hour clock reading.
const AM_HINTS: Record<Language, string[]> = {
  en: ["morning", "am", "a m"],
  it: ["mattina", "mattino"],
};
const PM_HINTS: Record<Language, string[]> = {
  en: ["afternoon", "evening", "tonight", "night", "pm", "p m"],
  it: ["pomeriggio", "sera", "stasera", "stanotte", "notte"],
};

// Tokens that can never be part of a label / title / reminder subject.
const STOPWORDS: Record<Language, string[]> = {
  en: ["set", "a", "an", "the", "for", "at", "on", "in", "me", "my", "to", "of", "please", "and", "with", "up", "start", "give", "make", "put", "new", "add", "create", "about", "that", "this", "it", "s", "o", "clock", "timer", "alarm", "reminder", "remind", "wake", "schedule", "appointment", "meeting", "calendar", "book", "countdown", "something", "anything", "thing"],
  it: ["imposta", "metti", "un", "uno", "una", "il", "la", "lo", "le", "i", "gli", "per", "alle", "alla", "all", "a", "di", "da", "mi", "me", "e", "ed", "con", "fai", "fammi", "dammi", "crea", "aggiungi", "nuovo", "nuova", "che", "su", "timer", "sveglia", "svegliami", "promemoria", "ricordami", "appuntamento", "evento", "agenda", "calendario", "fissa", "ricorda", "qualcosa"],
};

// Connectors that mark a second, separate request in the same utterance.
const ALSO_WORDS: Record<Language, string[]> = {
  en: ["also", "too", "as well", "and also"],
  it: ["anche", "pure"],
};

// A timer longer than this is almost certainly a misparse (a 25-hour countdown
// is an alarm or an event, not a timer).
const MAX_TIMER_SECONDS = 24 * 3600;

// ── Small helpers ───────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number; // exclusive
}

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${phrase.replace(/ /g, " ")}( |$)`).test(text);
}

// A number starting at `i`: digits, a number word, or a tens+units pair
// ("forty five"). Returns null when the token isn't numeric.
function readNumber(
  tokens: string[],
  i: number,
  lang: Language,
): { value: number; next: number } | null {
  const words = NUMBER_WORDS[lang];
  const tok = tokens[i];
  if (tok === undefined) return null;

  if (/^\d{1,4}$/.test(tok)) return { value: Number(tok), next: i + 1 };

  const first = words[tok];
  if (first === undefined) return null;

  // Tens followed by a unit: "forty five" → 45. Only for 20..90 + 1..9.
  if (first >= 20 && first % 10 === 0) {
    const second = words[tokens[i + 1] ?? ""];
    if (second !== undefined && second >= 1 && second <= 9) {
      return { value: first + second, next: i + 2 };
    }
  }
  return { value: first, next: i + 1 };
}

// ── Duration ────────────────────────────────────────────────────────────────

interface DurationHit {
  seconds: number;
  spans: Span[];
}

// Sums every `<number> <unit>` pair in the token list, so "an hour and thirty
// minutes" is 5400. Also handles the fixed idioms ("half an hour").
export function scanDuration(
  tokens: string[],
  lang: Language,
): DurationHit | null {
  const units = UNITS[lang];
  let seconds = 0;
  const spans: Span[] = [];
  let found = false;

  for (let i = 0; i < tokens.length; i++) {
    // "half an hour" / "mezz ora" / "mezza ora"
    if (
      (lang === "en" && tokens[i] === "half" && tokens[i + 1] === "an" && units[tokens[i + 2] ?? ""] === 3600) ||
      (lang === "it" && /^mezz[ao]?$/.test(tokens[i]) && units[tokens[i + 1] ?? ""] === 3600)
    ) {
      seconds += 1800;
      spans.push({ start: i, end: lang === "en" ? i + 3 : i + 2 });
      i = (lang === "en" ? i + 3 : i + 2) - 1;
      found = true;
      continue;
    }
    // "a quarter of an hour" / "un quarto d ora"
    if (
      (lang === "en" && tokens[i] === "quarter" && tokens[i + 1] === "of" && units[tokens[i + 3] ?? ""] === 3600) ||
      (lang === "it" && tokens[i] === "quarto" && tokens[i + 1] === "d" && units[tokens[i + 2] ?? ""] === 3600)
    ) {
      const end = lang === "en" ? i + 4 : i + 3;
      seconds += 900;
      spans.push({ start: i, end });
      i = end - 1;
      found = true;
      continue;
    }

    const num = readNumber(tokens, i, lang);
    if (!num) continue;
    const unit = units[tokens[num.next] ?? ""];
    if (unit === undefined) continue;
    // "an hour and a half"
    let end = num.next + 1;
    let value = num.value * unit;
    if (
      unit === 3600 &&
      ((lang === "en" && tokens[end] === "and" && tokens[end + 1] === "a" && tokens[end + 2] === "half") ||
        (lang === "it" && tokens[end] === "e" && /^mezz[ao]$/.test(tokens[end + 1] ?? "")))
    ) {
      value += 1800;
      end += lang === "en" ? 3 : 2;
    }
    seconds += value;
    spans.push({ start: i, end });
    i = end - 1;
    found = true;
  }

  return found ? { seconds, spans } : null;
}

// ── Clock time ──────────────────────────────────────────────────────────────

interface ClockHit {
  hour: number; // as spoken: 0-23
  minute: number;
  // Whether the hour is already unambiguous (24h reading, or an explicit
  // am/pm). When false the caller must settle 7 vs 19.
  explicit: boolean;
  spans: Span[];
}

function readMeridiem(tokens: string[], i: number, lang: Language): "am" | "pm" | null {
  if (lang !== "en") return null;
  const t = tokens[i];
  if (t === "am") return "am";
  if (t === "pm") return "pm";
  // Punctuation stripping turns "a.m." into "a m".
  if (t === "a" && tokens[i + 1] === "m") return "am";
  if (t === "p" && tokens[i + 1] === "m") return "pm";
  return null;
}

// Finds the LAST clock time in the token list (a stammered "eight eight thirty"
// has already been collapsed by the normalizer, so a second hit here is a real
// second time, and the later one is the operative one).
export function scanClock(tokens: string[], lang: Language): ClockHit | null {
  let best: ClockHit | null = null;

  for (let i = 0; i < tokens.length; i++) {
    // HH:MM as a single token.
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(tokens[i]);
    if (hhmm) {
      const h = Number(hhmm[1]);
      const m = Number(hhmm[2]);
      if (h > 23 || m > 59) continue;
      let end = i + 1;
      let explicit = h === 0 || h > 12;
      let hour = h;
      const mer = readMeridiem(tokens, end, lang);
      if (mer) {
        hour = to24(h, mer);
        explicit = true;
        end += tokens[end] === "am" || tokens[end] === "pm" ? 1 : 2;
      }
      best = { hour, minute: m, explicit, spans: [{ start: i, end }] };
      continue;
    }

    // "half past seven" / "quarter past seven" / "quarter to eight"
    if (lang === "en" && (tokens[i] === "half" || tokens[i] === "quarter")) {
      const rel = tokens[i + 1];
      if (rel === "past" || rel === "to") {
        const num = readNumber(tokens, i + 2, lang);
        if (num && num.value >= 1 && num.value <= 12) {
          const offset = tokens[i] === "half" ? 30 : 15;
          let hour = num.value;
          let minute = offset;
          if (rel === "to") {
            hour = hour - 1 === 0 ? 12 : hour - 1;
            minute = 60 - offset;
          }
          let end = num.next;
          let explicit = false;
          const mer = readMeridiem(tokens, end, lang);
          if (mer) {
            hour = to24(hour, mer);
            explicit = true;
            end += tokens[end] === "am" || tokens[end] === "pm" ? 1 : 2;
          }
          best = { hour, minute, explicit, spans: [{ start: i, end }] };
          i = end - 1;
          continue;
        }
      }
    }

    // Italian "alle sette e mezza" / "e un quarto" / "e trenta"
    if (lang === "it") {
      const num = readNumber(tokens, i, lang);
      const isDuration = num !== null && UNITS[lang][tokens[num.next] ?? ""] !== undefined;
      if (num && !isDuration && num.value >= 0 && num.value <= 23) {
        let hour = num.value;
        let minute = 0;
        let end = num.next;
        let matched = i > 0 && /^(alle|all|le|ore)$/.test(tokens[i - 1] ?? "");
        if (tokens[end] === "e") {
          if (/^mezz[ao]$/.test(tokens[end + 1] ?? "")) {
            minute = 30;
            end += 2;
            matched = true;
          } else if (tokens[end + 1] === "un" && tokens[end + 2] === "quarto") {
            minute = 15;
            end += 3;
            matched = true;
          } else {
            const mins = readNumber(tokens, end + 1, lang);
            if (mins && mins.value < 60) {
              minute = mins.value;
              end = mins.next;
              matched = true;
            }
          }
        }
        if (matched) {
          best = { hour, minute, explicit: hour > 12 || hour === 0, spans: [{ start: i, end }] };
          i = end - 1;
          continue;
        }
      }
    }

    // "<hour> [<minute>] [o'clock] [am|pm]" — needs an anchoring preposition so
    // a bare number in "remind me in 5" isn't read as a clock. A segment that
    // OPENS with the number also counts: a self-correction restates the time
    // bare ("…no, eight thirty tomorrow").
    const num = readNumber(tokens, i, lang);
    if (!num) continue;
    // "ten minutes" is a duration, never 10:00.
    if (UNITS[lang][tokens[num.next] ?? ""] !== undefined) continue;
    const prev = tokens[i - 1] ?? "";
    const anchored =
      i === 0 ||
      (lang === "en" && /^(at|by|around|for)$/.test(prev)) ||
      (lang === "it" && /^(alle|all|le|ore|verso)$/.test(prev));
    if (!anchored) continue;
    if (num.value > 23) continue;

    let hour = num.value;
    let minute = 0;
    let end = num.next;
    let explicit = hour > 12 || hour === 0;

    // "seven fifteen" — a following bare number under 60 is the minutes, but
    // only when it isn't itself the start of a unit phrase ("five minutes").
    const mins = readNumber(tokens, end, lang);
    if (
      mins &&
      mins.value < 60 &&
      UNITS[lang][tokens[mins.next] ?? ""] === undefined &&
      hour <= 12
    ) {
      minute = mins.value;
      end = mins.next;
    }
    if (tokens[end] === "o" && tokens[end + 1] === "clock") end += 2;

    const mer = readMeridiem(tokens, end, lang);
    if (mer) {
      hour = to24(hour, mer);
      explicit = true;
      end += tokens[end] === "am" || tokens[end] === "pm" ? 1 : 2;
    }

    best = { hour, minute, explicit, spans: [{ start: i, end }] };
    i = end - 1;
  }

  return best;
}

function to24(hour12: number, meridiem: "am" | "pm"): number {
  if (meridiem === "am") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

// ── Day hints ───────────────────────────────────────────────────────────────

type DayHit =
  | { kind: "today"; spans: Span[] }
  | { kind: "tomorrow"; spans: Span[] }
  | { kind: "weekday"; weekday: number; spans: Span[] };

export function scanDay(tokens: string[], lang: Language): DayHit | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (TODAY_WORDS[lang].includes(t) || (lang === "en" && t === "tonight") || (lang === "it" && (t === "stasera" || t === "stanotte"))) {
      return { kind: "today", spans: [{ start: i, end: i + 1 }] };
    }
    if (TOMORROW_WORDS[lang].includes(t)) {
      return { kind: "tomorrow", spans: [{ start: i, end: i + 1 }] };
    }
    const wd = WEEKDAYS[lang].indexOf(t);
    if (wd >= 0) {
      // The IT list has two spellings per accented day; map back to 0-6.
      const weekday = lang === "it" ? itWeekdayIndex(t) : wd;
      return { kind: "weekday", weekday, spans: [{ start: i, end: i + 1 }] };
    }
  }
  return null;
}

function itWeekdayIndex(word: string): number {
  const map: Record<string, number> = {
    domenica: 0, lunedì: 1, lunedi: 1, martedì: 2, martedi: 2,
    mercoledì: 3, mercoledi: 3, giovedì: 4, giovedi: 4,
    venerdì: 5, venerdi: 5, sabato: 6,
  };
  return map[word] ?? 0;
}

// ── Intent detection ────────────────────────────────────────────────────────

function detectFamilies(text: string, lang: Language): Family[] {
  const found: Family[] = [];
  for (const family of ["timer", "alarm", "reminder", "calendar"] as Family[]) {
    if (TRIGGERS[lang][family].some((p) => hasPhrase(text, p))) found.push(family);
  }
  return found;
}

function isQuestion(raw: string, text: string, lang: Language): boolean {
  if (raw.includes("?")) return true;
  const firstWord = text.split(" ")[0] ?? "";
  // "what time is my alarm" is a question; "when you get a chance" isn't a
  // scheduling command either — both are safest left to the model.
  return QUESTION_OPENERS[lang].includes(firstWord);
}

// ── Label / subject extraction ──────────────────────────────────────────────

function removeSpans(tokens: string[], spans: Span[]): string[] {
  const drop = new Set<number>();
  for (const s of spans) for (let i = s.start; i < s.end; i++) drop.add(i);
  return tokens.filter((_, i) => !drop.has(i));
}

// Whatever survives after the time/duration spans, the trigger words and the
// stopwords. Returns null when nothing meaningful is left — callers must not
// invent a label out of filler.
function leftoverPhrase(
  tokens: string[],
  spans: Span[],
  lang: Language,
): string | null {
  const stop = new Set(STOPWORDS[lang]);
  const rest = removeSpans(tokens, spans)
    .filter((t) => !stop.has(t))
    .filter((t) => !AM_HINTS[lang].includes(t) && !PM_HINTS[lang].includes(t))
    .filter((t) => !TODAY_WORDS[lang].includes(t) && !TOMORROW_WORDS[lang].includes(t))
    .filter((t) => !WEEKDAYS[lang].includes(t));
  if (rest.length === 0) return null;
  return rest.join(" ");
}

// Leading/trailing filler only — internal words are the user's phrasing and
// must survive ("take the bread out" is not "take bread out").
function trimPhrase(tokens: string[], lang: Language): string | null {
  const stop = new Set(STOPWORDS[lang]);
  let start = 0;
  let end = tokens.length;
  while (start < end && stop.has(tokens[start])) start++;
  while (end > start && stop.has(tokens[end - 1])) end--;
  const rest = tokens.slice(start, end);
  return rest.length > 0 ? rest.join(" ") : null;
}

// "remind me to call mum" → "call mum". The subject is taken from the FIRST
// segment that has one: a correction usually restates the time, not the task.
function reminderSubject(
  segments: string[],
  lang: Language,
): string | null {
  const marker = lang === "it" ? /(?:^| )(?:di|che) (.+)$/ : /(?:^| )to (.+)$/;
  for (const seg of segments) {
    const m = marker.exec(seg);
    if (!m) continue;
    const tokens = m[1].split(" ").filter(Boolean);
    const clockHit = scanClock(tokens, lang);
    const durHit = scanDuration(tokens, lang);
    const spans = [...(clockHit?.spans ?? []), ...(durHit?.spans ?? [])];
    const phrase = trimPhrase(removeSpans(tokens, spans), lang);
    if (phrase) return phrase;
  }
  return null;
}

// ── Resolution ──────────────────────────────────────────────────────────────

function dateForHit(hit: DayHit | null, now: Date): Date | null {
  if (!hit) return null;
  if (hit.kind === "today") return new Date(now);
  if (hit.kind === "tomorrow") return addDays(now, 1);
  // Next occurrence of that weekday, never today (saying "Friday" on a Friday
  // means the coming Friday to most people; a same-day intent says "today").
  const delta = (hit.weekday - now.getDay() + 7) % 7 || 7;
  return addDays(now, delta);
}

function atTime(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Settles a bare 12-hour reading.
//
// Explicit am/pm and 24-hour readings pass through unchanged. A part-of-day
// word ("tonight", "in the morning") decides it. A wake-up trigger means
// morning. Otherwise the DAYTIME rule applies: 7-11 is morning, 1-6 is
// afternoon/evening — "at four" is 16:00, "at nine" is 09:00.
//
// The daytime rule is deliberately independent of the current time. Picking
// "the soonest future reading" instead would make the same sentence mean
// 04:00 or 16:00 depending on when it was said, which is exactly the kind of
// surprise an alarm must not have. 12 stays genuinely two-way and asks.
function settleHour(
  clock: ClockHit,
  text: string,
  lang: Language,
  preferAm: boolean,
): { hour: number } | { ambiguous: "ambiguous-meridiem" } {
  if (clock.explicit) return { hour: clock.hour };

  if (AM_HINTS[lang].some((w) => hasPhrase(text, w))) {
    return { hour: clock.hour === 12 ? 0 : clock.hour };
  }
  if (PM_HINTS[lang].some((w) => hasPhrase(text, w))) {
    return { hour: clock.hour === 12 ? 12 : (clock.hour % 12) + 12 };
  }
  if (clock.hour === 12) return { ambiguous: "ambiguous-meridiem" };
  if (preferAm) return { hour: clock.hour };
  return { hour: clock.hour <= 6 ? clock.hour + 12 : clock.hour };
}

export interface ParseOptions {
  now: Date;
  lang: Language;
}

export function parseSchedulingCommand(
  raw: string,
  opts: ParseOptions,
): ScheduleParse {
  const { now, lang } = opts;
  const norm = normalizeUtterance(raw, lang);
  if (!norm.text) return { status: "none" };

  const text = norm.text;
  const families = detectFamilies(text, lang);
  const tokens = text.split(" ").filter(Boolean);

  // An implicit timer ("give me forty-five minutes") counts only with a
  // duration. Detected even when another family already matched: that is
  // precisely the compound case ("45 minutes, but remind me 5 before").
  const implicitTimer =
    !families.includes("timer") &&
    IMPLICIT_TIMER[lang].some((p) => hasPhrase(text, p)) &&
    scanDuration(tokens, lang) !== null;
  if (implicitTimer) families.push("timer");

  if (families.length === 0) return { status: "none" };
  if (isQuestion(raw, text, lang)) return { status: "none" };

  // Two different actions in one utterance ("a 45 minute timer, but remind me
  // 5 minutes before too"). One turn executes one action, and picking which is
  // exactly the guess this parser must not make.
  const alsoConnector = ALSO_WORDS[lang].some((w) => hasPhrase(text, w));
  if (families.length > 1 || (alsoConnector && families.length >= 1 && norm.segments.length > 1)) {
    if (families.length > 1) {
      return { status: "ambiguous", reason: "compound-request", normalized: text };
    }
  }

  const family = families[0];

  // Values are read from the LAST segment that states one: a self-correction
  // supersedes everything before it. A qualifier the correction didn't restate
  // (typically the day) still carries over from the earlier segment.
  const segmentTokens = norm.segments.map((s) => s.split(" ").filter(Boolean));
  const pickLast = <T,>(fn: (t: string[]) => T | null): { hit: T; tokens: string[] } | null => {
    for (let i = segmentTokens.length - 1; i >= 0; i--) {
      const hit = fn(segmentTokens[i]);
      if (hit) return { hit, tokens: segmentTokens[i] };
    }
    return null;
  };

  const duration = pickLast((t) => scanDuration(t, lang));
  const clock = pickLast((t) => scanClock(t, lang));
  const day = pickLast((t) => scanDay(t, lang));

  if (family === "timer") {
    if (!duration) {
      // "set a timer" with no length, or only a clock time ("timer at 7"),
      // which is an alarm the user phrased loosely — ask rather than arm.
      return { status: "ambiguous", reason: "missing-duration", normalized: text };
    }
    if (duration.hit.seconds <= 0 || duration.hit.seconds > MAX_TIMER_SECONDS) {
      return { status: "ambiguous", reason: "out-of-range", normalized: text };
    }
    const label = leftoverPhrase(duration.tokens, duration.hit.spans, lang);
    return {
      status: "resolved",
      normalized: text,
      intent: {
        kind: "timer",
        durationSeconds: duration.hit.seconds,
        ...(label ? { label } : {}),
      },
    };
  }

  if (family === "alarm") {
    if (!clock) return { status: "ambiguous", reason: "missing-time", normalized: text };
    const preferAm = hasPhrase(text, "wake me") || hasPhrase(text, "wake up") || hasPhrase(text, "svegliami");
    const targetDay = dateForHit(day?.hit ?? null, now);
    const settled = settleHour(clock.hit, text, lang, preferAm);
    if ("ambiguous" in settled) {
      return { status: "ambiguous", reason: settled.ambiguous, normalized: text };
    }
    const time = `${pad2(settled.hour)}:${pad2(clock.hit.minute)}`;
    const label = leftoverPhrase(clock.tokens, clock.hit.spans, lang);
    return {
      status: "resolved",
      normalized: text,
      intent: {
        kind: "alarm",
        time,
        ...(targetDay ? { date: localDateStr(targetDay) } : {}),
        ...(label ? { label } : {}),
      },
    };
  }

  if (family === "reminder") {
    const subject = reminderSubject(norm.segments, lang);
    if (!subject) {
      return { status: "ambiguous", reason: "missing-subject", normalized: text };
    }
    // "remind me in 10 minutes" — a duration means an offset from now.
    if (duration && !clock) {
      if (duration.hit.seconds <= 0) {
        return { status: "ambiguous", reason: "out-of-range", normalized: text };
      }
      return {
        status: "resolved",
        normalized: text,
        intent: {
          kind: "reminder",
          dateTime: new Date(now.getTime() + duration.hit.seconds * 1000),
          text: subject,
        },
      };
    }
    if (!clock) return { status: "ambiguous", reason: "missing-time", normalized: text };

    const targetDay = dateForHit(day?.hit ?? null, now);
    const settled = settleHour(clock.hit, text, lang, false);
    if ("ambiguous" in settled) {
      return { status: "ambiguous", reason: settled.ambiguous, normalized: text };
    }
    let when = atTime(targetDay ?? now, settled.hour, clock.hit.minute);
    // No day given and the time already passed → the next occurrence.
    if (!targetDay && when.getTime() <= now.getTime()) when = addDays(when, 1);
    if (when.getTime() <= now.getTime()) {
      return { status: "ambiguous", reason: "time-in-past", normalized: text };
    }
    return {
      status: "resolved",
      normalized: text,
      intent: { kind: "reminder", dateTime: when, text: subject },
    };
  }

  // Calendar events carry a title the user cares about, and titles are where a
  // deterministic parser is weakest. Resolve only when there is both a clear
  // time and a clear leftover title; otherwise hand the utterance to the model,
  // which is good at exactly this.
  if (!clock) return { status: "none" };
  const targetDay = dateForHit(day?.hit ?? null, now);
  const settled = settleHour(clock.hit, text, lang, false);
  if ("ambiguous" in settled) {
    return { status: "ambiguous", reason: settled.ambiguous, normalized: text };
  }
  const title = leftoverPhrase(clock.tokens, clock.hit.spans, lang);
  if (!title) return { status: "none" };
  let start = atTime(targetDay ?? now, settled.hour, clock.hit.minute);
  if (!targetDay && start.getTime() <= now.getTime()) start = addDays(start, 1);
  return {
    status: "resolved",
    normalized: text,
    intent: { kind: "calendarEvent", start, title },
  };
}
