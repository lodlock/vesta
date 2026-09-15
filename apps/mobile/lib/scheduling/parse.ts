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
  // A timer plus an earlier heads-up timer — "45 minutes, warn me 5 before".
  // Two timers, one utterance; kept as one intent so the pair is resolved (and
  // validated against each other) in one place.
  | {
      kind: "timerWithWarning";
      durationSeconds: number;
      warningSeconds: number;
      label?: string;
    }
  // HH:MM (+ optional YYYY-MM-DD) rather than a Date: this is what Android's
  // AlarmClock intent takes, and the date is advisory (see intent-to-tool).
  | { kind: "alarm"; time: string; date?: string; label?: string }
  | { kind: "reminder"; dateTime: Date; text: string }
  | { kind: "calendarEvent"; start: Date; end?: Date; title: string };

export type AmbiguityReason =
  | "missing-duration"
  | "missing-warning-time"
  | "missing-time"
  | "missing-subject"
  | "ambiguous-meridiem"
  | "compound-request"
  | "out-of-range"
  | "time-in-past";

// Extra facts a clarification question needs. Only the meridiem question has
// any: it has to name the hour it is asking about ("4 AM or 4 PM?").
export interface AmbiguityDetail {
  hour12?: number;
}

export type ScheduleParse =
  | { status: "resolved"; intent: ScheduleIntent; normalized: string }
  | {
      status: "ambiguous";
      reason: AmbiguityReason;
      normalized: string;
      detail?: AmbiguityDetail;
    }
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
    timer: ["timer", "timers", "countdown", "time me"],
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

// Phrases that introduce an earlier heads-up alongside a timer. These say
// "warning" and little else, so a pair built on one of them is safe even when
// the utterance never says "timer" ("forty-five minutes, with a five-minute
// warning").
//
// NO MARKER MAY START WITH A UNIT WORD. "second timer" used to be here, for
// "set a second timer" meaning another one — and it matched the middle of
// "set a 30 SECOND TIMER", turning the most ordinary timer request there is
// into a warning-pair with one quantity, which then asked the user how long
// the timer should be. Italian's "secondo timer" had the same defect. The
// ordinal reading is already covered by "another one"/"another timer", and a
// bare "set a second timer" asks for a length anyway, so nothing is lost.
// __tests__/parse.test.ts locks this by resolving a timer in every unit.
const WARNING_MARKERS: Record<Language, string[]> = {
  en: ["warn me", "warning", "heads up", "another one", "another timer"],
  it: ["avvisami", "avviso", "un altro timer", "un altro"],
};

// "remind me" introduces a warning too ("45 minutes, but remind me 5 before"),
// but it is also how every ordinary reminder starts. It only counts as a
// warning phrase when there is already a timer in the utterance to warn about
// — otherwise "remind me the meeting is in forty-five minutes" could be read
// as a timer pair.
const WARNING_MARKERS_GENERIC: Record<Language, string[]> = {
  en: ["remind me"],
  it: ["ricordami"],
};

// "five minutes BEFORE" is measured back from the end; "a warning AT forty" is
// measured from the start. Same sentence shape, opposite arithmetic.
const BEFORE_WORDS: Record<Language, string[]> = {
  en: ["before", "beforehand", "prior"],
  it: ["prima"],
};
const AT_WORDS: Record<Language, string[]> = {
  en: ["at"],
  it: ["a", "alle"],
};

// Tokens that are only ever articles, never a spoken quantity.
const ARTICLES: Record<Language, string[]> = {
  en: ["a", "an"],
  it: ["un", "una", "uno"],
};

// Words that introduce an explicit name for a timer or alarm: "a 30 second
// timer CALLED brandon time". They are not stopwords — stripping "called" or
// "named" everywhere would mangle a reminder like "call the man named Brandon"
// — so they are only consumed here, where they are doing this one job.
const LABEL_INTRODUCERS: Record<Language, string[]> = {
  en: ["called", "named", "labeled", "labelled", "titled"],
  it: ["chiamato", "chiamata", "chiamati", "chiamate", "denominato", "nome"],
};

// The noun a timer request ends on. Used to tell "a second timer" (another one)
// from "a 30 second timer" (a duration) — see scanDurationRaw.
const TIMER_NOUNS: Record<Language, string[]> = {
  en: ["timer", "timers"],
  it: ["timer"],
};

// A timer longer than this is almost certainly a misparse (a 25-hour countdown
// is an alarm or an event, not a timer).
const MAX_TIMER_SECONDS = 24 * 3600;

// ── Small helpers ───────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number; // exclusive
}

function segmentsOf(segments: string[]): string[][] {
  return segments.map((seg) => seg.split(" ").filter(Boolean));
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
  if (first === undefined) {
    // Italian writes compounds as ONE word — "quarantacinque", "ventotto",
    // "trentuno" — so a recognizer hands them over as a single token that no
    // dictionary lookup will find.
    const compound = lang === "it" ? readItalianCompound(tok) : null;
    return compound === null ? null : { value: compound, next: i + 1 };
  }

  // Tens followed by a unit: "forty five" → 45. Only for 20..90 + 1..9.
  if (first >= 20 && first % 10 === 0) {
    const second = words[tokens[i + 1] ?? ""];
    if (second !== undefined && second >= 1 && second <= 9) {
      return { value: first + second, next: i + 2 };
    }
  }
  return { value: first, next: i + 1 };
}

// "quarantacinque" → 45. The tens word loses its final vowel before a unit
// ("quaranta" + "cinque" → "quarant" + "a" + "cinque"), and drops the linking
// vowel entirely before one that starts with one ("vent" + "otto" → ventotto).
export function readItalianCompound(token: string): number | null {
  const words = NUMBER_WORDS.it;
  for (const [tensWord, tens] of Object.entries(words)) {
    if (tens < 20 || tens % 10 !== 0) continue;
    const stem = tensWord.slice(0, -1); // vent, trent, quarant, cinquant...
    if (!token.startsWith(stem) || token === tensWord) continue;
    let rest = token.slice(stem.length);
    // Put back, or drop, the linking vowel.
    if (words[rest] === undefined && /^[aeiou]/.test(rest)) {
      rest = rest.slice(1);
    }
    const unit = words[rest];
    if (unit !== undefined && unit >= 1 && unit <= 9) return tens + unit;
  }
  return null;
}

// ── Duration ────────────────────────────────────────────────────────────────

interface DurationHit {
  seconds: number;
  spans: Span[];
}

// One duration as spoken, with where it sits in the token list. Distinct from
// scanDuration's total: to tell "45 minutes" from "5 minutes" in "45 minutes,
// warn me 5 minutes before", the two must stay separate quantities.
export interface DurationQuantity {
  seconds: number;
  start: number;
  end: number; // exclusive
  // The number as spoken, and the unit it was spoken with. `unitSeconds` is
  // null when no unit was said at all ("warn me at forty"), which is what lets
  // a bare warning borrow the timer's unit instead of assuming minutes.
  value: number;
  unitSeconds: number | null;
}

// Joins quantities that are one spoken duration split across two unit phrases:
// "one hour and thirty minutes" is 5400, not 3600 and 1800. Adjacent means
// touching, or separated only by "and"/"e".
function mergeAdjacent(
  hits: DurationQuantity[],
  tokens: string[],
  lang: Language,
): DurationQuantity[] {
  const joiner = lang === "it" ? "e" : "and";
  const out: DurationQuantity[] = [];
  for (const hit of hits) {
    const prev = out[out.length - 1];
    const gap = prev ? tokens.slice(prev.end, hit.start) : null;
    const touching =
      gap !== null &&
      (gap.length === 0 || (gap.length === 1 && gap[0] === joiner));
    if (prev && touching) {
      prev.seconds += hit.seconds;
      prev.end = hit.end;
      // "one hour and thirty minutes" inherits as MINUTES: the last unit spoken
      // is the finer one, and the one a follow-up number would be measured in.
      prev.value = hit.value;
      prev.unitSeconds = hit.unitSeconds;
    } else {
      out.push({ ...hit });
    }
  }
  return out;
}

// Every duration in the token list, in order, as separate quantities.
export function scanDurationQuantities(
  tokens: string[],
  lang: Language,
): DurationQuantity[] {
  const raw = scanDurationRaw(tokens, lang);
  return mergeAdjacent(raw, tokens, lang);
}

// Sums every `<number> <unit>` pair in the token list, so "an hour and thirty
// minutes" is 5400. Also handles the fixed idioms ("half an hour").
export function scanDuration(
  tokens: string[],
  lang: Language,
): DurationHit | null {
  const quantities = scanDurationRaw(tokens, lang);
  if (quantities.length === 0) return null;
  return {
    seconds: quantities.reduce((sum, q) => sum + q.seconds, 0),
    spans: quantities.map((q) => ({ start: q.start, end: q.end })),
  };
}

// The scanner both of the above are built on: unmerged, in token order.
function scanDurationRaw(
  tokens: string[],
  lang: Language,
): DurationQuantity[] {
  const units = UNITS[lang];
  const hits: DurationQuantity[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // "half an hour" / "mezz ora" / "mezza ora"
    if (
      (lang === "en" && tokens[i] === "half" && tokens[i + 1] === "an" && units[tokens[i + 2] ?? ""] === 3600) ||
      (lang === "it" && /^mezz[ao]?$/.test(tokens[i]) && units[tokens[i + 1] ?? ""] === 3600)
    ) {
      const end = lang === "en" ? i + 3 : i + 2;
      hits.push({ seconds: 1800, start: i, end, value: 30, unitSeconds: 60 });
      i = end - 1;
      continue;
    }
    // "a quarter of an hour" / "un quarto d ora"
    if (
      (lang === "en" && tokens[i] === "quarter" && tokens[i + 1] === "of" && units[tokens[i + 3] ?? ""] === 3600) ||
      (lang === "it" && tokens[i] === "quarto" && tokens[i + 1] === "d" && units[tokens[i + 2] ?? ""] === 3600)
    ) {
      const end = lang === "en" ? i + 4 : i + 3;
      hits.push({ seconds: 900, start: i, end, value: 15, unitSeconds: 60 });
      i = end - 1;
      continue;
    }

    const num = readNumber(tokens, i, lang);
    if (!num) continue;
    const unit = units[tokens[num.next] ?? ""];
    if (unit === undefined) continue;
    // "a second timer" is ANOTHER timer, not a one-second one. An article
    // reading as the number one, directly before a unit, directly before the
    // word "timer", is the ordinal sense — a real duration says a number ("a
    // 30 second timer"). Without this the phrase silently armed a 1-second
    // timer, which is worse than asking.
    if (
      ARTICLES[lang].includes(tokens[i]) &&
      TIMER_NOUNS[lang].includes(tokens[num.next + 1] ?? "")
    ) {
      continue;
    }
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
    hits.push({ seconds: value, start: i, end, value: num.value, unitSeconds: unit });
    i = end - 1;
  }

  return hits;
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

// Phrasings that mean "get me up", which settles a bare hour as morning.
// Italian "sveglia" is the alarm-clock noun AND the wake-up verb — "metti la
// sveglia alle sette" is 07:00 to any Italian speaker — so the noun counts
// there while English needs an explicit "wake me".
function prefersMorning(text: string, lang: Language): boolean {
  if (lang === "it") {
    return ["sveglia", "svegliami", "sveglie"].some((w) => hasPhrase(text, w));
  }
  return hasPhrase(text, "wake me") || hasPhrase(text, "wake up");
}

// "Tomorrow" and weekdays are named future days. "Today" is not: it is the day
// the next-occurrence rule already works within, so it needs no extra question.
function isNamedFutureDay(hit: DayHit | null): boolean {
  return hit?.kind === "tomorrow" || hit?.kind === "weekday";
}

function itWeekdayIndex(word: string): number {
  const map: Record<string, number> = {
    domenica: 0, lunedì: 1, lunedi: 1, martedì: 2, martedi: 2,
    mercoledì: 3, mercoledi: 3, giovedì: 4, giovedi: 4,
    venerdì: 5, venerdi: 5, sabato: 6,
  };
  return map[word] ?? 0;
}

// ── Timer + warning ─────────────────────────────────────────────────────────

// "45 minutes, but warn me 5 minutes before" is two timers, not two requests.
// Resolving it here is what keeps it out of the compound-request question.
export type WarningPair =
  | { kind: "none" } // no warning phrase — not this shape at all
  | { kind: "unresolved" } // a warning phrase, but the relationship isn't clear
  | { kind: "pair"; durationSeconds: number; warningSeconds: number };

// Span of the first warning marker in the token list, or null.
function findWarningMarker(
  tokens: string[],
  lang: Language,
  allowGeneric: boolean,
): { start: number; end: number } | null {
  const text = tokens.join(" ");
  const markers = allowGeneric
    ? [...WARNING_MARKERS[lang], ...WARNING_MARKERS_GENERIC[lang]]
    : WARNING_MARKERS[lang];
  for (const marker of markers) {
    if (!hasPhrase(text, marker)) continue;
    const size = marker.split(" ").length;
    for (let i = 0; i + size <= tokens.length; i++) {
      if (tokens.slice(i, i + size).join(" ") === marker) {
        return { start: i, end: i + size };
      }
    }
  }
  return null;
}

// How many tokens may sit between the marker and the quantity it introduces
// ("warn me [about] five minutes before").
const WARNING_LOOKAHEAD = 3;

// Which of the two quantities is the warning.
//
// A quantity FOLLOWING the marker wins: "warn me five minutes before", "a
// warning at forty" — the marker announces it. Only when nothing follows does
// the one before it count, which is the "with a five-minute warning" shape.
//
// Raw token distance cannot decide this: in "timer for forty-five, warning at
// forty" the timer's own quantity ends exactly at the marker (distance 0) while
// the warning sits one token past it, so nearest-wins picks the timer and the
// arithmetic comes out negative.
function pickWarningQuantity(
  quantities: DurationQuantity[],
  marker: { start: number; end: number },
): DurationQuantity | null {
  const after = quantities.find(
    (q) => q.start >= marker.end && q.start - marker.end <= WARNING_LOOKAHEAD,
  );
  if (after) return after;
  const before = [...quantities].reverse().find((q) => q.end <= marker.start);
  return before ?? null;
}

// A bare number in a timer+warning sentence — "warning at forty", "warn me at
// one". The unit is decided later by findWarningPair (it borrows the timer's);
// `seconds` here is provisional. Deliberately scoped to this resolver:
// elsewhere a bare number could be a clock time, and guessing between the two
// is how "set a timer for seven" would silently become 7 minutes.
function bareQuantities(tokens: string[], lang: Language): DurationQuantity[] {
  const out: DurationQuantity[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (ARTICLES[lang].includes(token)) continue;
    const num = readNumber(tokens, i, lang);
    if (!num) continue;
    // A number that carries its own unit is already a real quantity.
    if (UNITS[lang][tokens[num.next] ?? ""] !== undefined) {
      i = num.next;
      continue;
    }
    // "one" is usually a pronoun in this shape ("another ONE five minutes
    // before that"), so it counts as a quantity only where a quantity is
    // syntactically due: right after "at", or right before "before".
    if (num.value <= 1) {
      const prev = tokens[i - 1] ?? "";
      const next = tokens[num.next] ?? "";
      const isQuantityPosition =
        AT_WORDS[lang].includes(prev) || BEFORE_WORDS[lang].includes(next);
      if (!isQuantityPosition) {
        i = num.next - 1;
        continue;
      }
    }
    out.push({
      seconds: num.value * 60,
      start: i,
      end: num.next,
      value: num.value,
      unitSeconds: null,
    });
    i = num.next - 1;
  }
  return out;
}

/**
 * Reads a timer + earlier-warning pair out of one utterance.
 *
 * The warning quantity is the one NEAREST the warning phrase, whichever side it
 * falls on — that is what makes "warn me five minutes before" and "with a
 * five-minute warning" the same shape despite the opposite word order. The
 * other quantity is the timer itself.
 *
 * Then the arithmetic: "five BEFORE" counts back from the end (45 → warn at
 * 40), "a warning AT forty" is already the warning's own length (45 → warn at
 * 40). With neither word ("a five-minute warning") it counts back, which is
 * what a warning means.
 *
 * Exactly two quantities are required. One is not a pair ("give me a warning
 * sometime before forty-five minutes"), three is not a shape this should guess
 * at, and none is just a warning phrase with nothing to measure.
 */
export function findWarningPair(
  tokens: string[],
  lang: Language,
  opts: { allowGeneric?: boolean; allowBareNumbers?: boolean } = {},
): WarningPair {
  const marker = findWarningMarker(tokens, lang, opts.allowGeneric ?? false);
  if (!marker) return { kind: "none" };

  let quantities = scanDurationQuantities(tokens, lang);
  if (quantities.length < 2 && opts.allowBareNumbers) {
    // No units spoken ("forty five ... forty"), or only one of the two carried
    // a unit ("two hours ... at one"): read bare numbers too.
    //
    // Gated by the caller on there being no alarm/reminder/calendar in the
    // utterance, because there a bare number is usually a clock time: "remind
    // me to call mum at six and take the bread out in ten minutes" must not
    // read "six" as a quantity and become a timer pair.
    const bare = bareQuantities(tokens, lang).filter(
      (b) => !quantities.some((q) => b.start < q.end && q.start < b.end),
    );
    quantities = [...quantities, ...bare].sort((a, b) => a.start - b.start);
  }
  if (quantities.length !== 2) return { kind: "unresolved" };

  const warning = pickWarningQuantity(quantities, marker);
  if (!warning) return { kind: "unresolved" };
  const rest = quantities.filter((q) => q !== warning);
  if (rest.length !== 1) return { kind: "unresolved" };
  const main = rest[0];

  // "before" anywhere from the marker on means the warning is an offset back
  // from the end; an "at" immediately before the number means it is absolute.
  const tail = tokens.slice(marker.start);
  const isRelative = BEFORE_WORDS[lang].some((w) => tail.includes(w));
  const isAbsolute =
    !isRelative && AT_WORDS[lang].includes(tokens[warning.start - 1] ?? "");

  if (main.seconds <= 0 || main.seconds > MAX_TIMER_SECONDS) {
    return { kind: "unresolved" };
  }

  // UNIT INHERITANCE. An explicit unit always wins. A bare warning number
  // borrows the timer's unit first — "give me two hours, warn me at one" is one
  // HOUR, not one minute, and reading it as minutes is the dangerous answer
  // because it fires 119 minutes early. Minutes stay as the fallback for when
  // the borrowed unit gives something impossible ("two hours, warn me at
  // ninety" is 90 minutes, since 90 hours cannot be it), and for when neither
  // quantity named a unit at all ("timer for forty five, warning at forty").
  const inheritedUnit = main.unitSeconds ?? 60;
  const candidateLengths =
    warning.unitSeconds !== null
      ? [warning.seconds]
      : [...new Set([warning.value * inheritedUnit, warning.value * 60])];

  for (const length of candidateLengths) {
    const warningSeconds = isAbsolute ? length : main.seconds - length;
    if (warningSeconds > 0 && warningSeconds < main.seconds) {
      return { kind: "pair", durationSeconds: main.seconds, warningSeconds };
    }
  }
  // Nothing plausible: a warning that isn't before the end, or a number no unit
  // makes sense of. Ask.
  return { kind: "unresolved" };
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

/**
 * The name the user gave a timer or alarm.
 *
 * Usually just what is left over once the duration, the trigger words and the
 * filler are gone — "set a PIZZA timer for 30 seconds" leaves "pizza". But an
 * explicit introducer changes where the name starts: in "a 30 second timer
 * called brandon time" the leftover is "called brandon time", and the label is
 * what follows the introducer, not the phrase including it.
 *
 * The LAST introducer in the phrase wins ("called pizza called bread" is
 * "bread"). A correction that opens a new segment ("…called pizza, no, called
 * bread") keeps the first: the label travels with the segment the DURATION was
 * found in, which is the segment the timer itself came from. Rare enough to
 * leave alone rather than complicate value resolution for.
 */
function labelPhrase(
  tokens: string[],
  spans: Span[],
  lang: Language,
): string | null {
  const leftover = leftoverPhrase(tokens, spans, lang);
  if (!leftover) return null;
  const words = leftover.split(" ");
  const introducers = LABEL_INTRODUCERS[lang];
  let start = -1;
  for (let i = 0; i < words.length; i++) {
    if (introducers.includes(words[i])) start = i;
  }
  if (start === -1) return leftover;
  const named = words.slice(start + 1);
  // "set a timer called" — an introducer with nothing after it names nothing.
  return named.length > 0 ? named.join(" ") : null;
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

/**
 * Turns a spoken clock reading into an actual instant.
 *
 * THE RULE, in order — the first line that applies decides it:
 *
 *  1. An explicit am/pm, or a 24-hour reading ("19:30"), is taken as spoken.
 *  2. A part-of-day word anywhere in the utterance decides it: "in the
 *     morning" → am, "tonight" / "this evening" / "at night" → pm.
 *  3. A wake-up phrasing ("wake me", Italian "sveglia", which is both the noun
 *     and the verb) means morning.
 *  4. A bare "twelve" with none of the above is genuinely two-way — noon and
 *     midnight — so it ASKS.
 *  5. A named FUTURE day ("tomorrow", "Friday") with a bare 1-12 hour: ASK.
 *     Nothing in the sentence says which half of the day it is, and unlike
 *     rule 6 there is no clock to lean on — "tomorrow at four" is a coin flip
 *     between breakfast and teatime, and an alarm that guesses wrong by twelve
 *     hours is worse than one more question.
 *  6. Otherwise (no day, or "today"): the NEXT PLAUSIBLE OCCURRENCE. Of the two
 *     readings (h and h+12), take whichever comes sooner from now, rolling into
 *     tomorrow when both have passed today.
 *
 * Rule 6 is why "alarm for four" means 04:00 said at 02:00 and 16:00 said at
 * 13:00: at 02:00 the morning reading is two hours away and the afternoon one
 * fourteen. It is fully deterministic — the same (utterance, instant) pair
 * always gives the same answer — and it crosses midnight naturally, since a
 * reading that has passed today is simply tried again tomorrow. "Today at four"
 * uses it too, and may roll to tomorrow; the confirmation names the day it
 * landed on.
 */
function resolveClockInstant(
  clock: ClockHit,
  day: Date | null,
  namedFutureDay: boolean,
  now: Date,
  text: string,
  lang: Language,
  preferAm: boolean,
): { at: Date } | { ambiguous: "ambiguous-meridiem"; hour12: number } {
  const { minute } = clock;

  // The next time this hour:minute comes around, today or tomorrow.
  const nextOccurrence = (hour: number): Date => {
    const today = atTime(now, hour, minute);
    return today.getTime() > now.getTime() ? today : atTime(addDays(now, 1), hour, minute);
  };

  // 1. As spoken.
  if (clock.explicit) {
    return { at: day ? atTime(day, clock.hour, minute) : nextOccurrence(clock.hour) };
  }

  const fixed = (hour: number) => ({
    at: day ? atTime(day, hour, minute) : nextOccurrence(hour),
  });

  // 2. Part of day.
  if (AM_HINTS[lang].some((w) => hasPhrase(text, w))) {
    return fixed(clock.hour === 12 ? 0 : clock.hour);
  }
  if (PM_HINTS[lang].some((w) => hasPhrase(text, w))) {
    return fixed(clock.hour === 12 ? 12 : (clock.hour % 12) + 12);
  }

  // 4. Noon or midnight — ask. (Checked before the wake-up rule: "wake me at
  // twelve" is no less ambiguous for being a wake-up.)
  if (clock.hour === 12) {
    return { ambiguous: "ambiguous-meridiem", hour12: 12 };
  }

  // 3. Wake-up phrasing.
  if (preferAm) return fixed(clock.hour);

  // 5. A named future day with nothing to disambiguate it — ask.
  if (namedFutureDay) {
    return { ambiguous: "ambiguous-meridiem", hour12: clock.hour };
  }

  // 6. Next plausible occurrence.
  const am = nextOccurrence(clock.hour);
  const pm = nextOccurrence(clock.hour + 12);
  return { at: am.getTime() <= pm.getTime() ? am : pm };
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

  if (isQuestion(raw, text, lang)) return { status: "none" };

  // A timer with an earlier warning is ONE request in two parts, so it is read
  // before anything is called compound.
  //
  // Attempted on the strength of the warning phrase alone, not on a timer
  // trigger: "set thirty minutes, no wait forty-five, and warn me five before"
  // never says "timer". It is safe because it only ACCEPTS a result that holds
  // two durations and a warning phrase — a shape nothing else produces. "Remind
  // me to call mum at six" has one time and no second duration, so it falls
  // straight through to the reminder branch.
  //
  // The last segment is tried first so a correction wins (45 + 40 above, not
  // 30 + 40); the whole utterance is the fallback for when the correction
  // restated only part of it.
  // Without a timer trigger, a pair rests entirely on the warning phrase, so
  // keep it to utterance lengths a spoken command actually has. It stops a
  // narrative sentence that happens to contain two durations and the word
  // "warning" ("the warning said it takes forty-five minutes and five minutes
  // to cool") from silently setting two timers. Commands of this shape are
  // short: the longest one this is built for is eight tokens.
  const MAX_FAMILYLESS_PAIR_TOKENS = 14;
  const hasTimerFamily = families.includes("timer");
  const pairOpts = {
    allowGeneric: hasTimerFamily,
    // Bare numbers are quantities only where nothing else in the utterance
    // wants a clock time. With an alarm, a reminder or an event in it, "at six"
    // is six o'clock.
    allowBareNumbers: !families.some(
      (f) => f === "alarm" || f === "reminder" || f === "calendar",
    ),
  };
  const pairAllowed = (segment: string[]) =>
    hasTimerFamily || segment.length <= MAX_FAMILYLESS_PAIR_TOKENS;
  const lastSegment = segmentsOf(norm.segments).at(-1) ?? tokens;
  const fromLast = pairAllowed(lastSegment)
    ? findWarningPair(lastSegment, lang, pairOpts)
    : ({ kind: "none" } as WarningPair);
  const warningPair: WarningPair =
    fromLast.kind === "pair"
      ? fromLast
      : pairAllowed(tokens)
        ? findWarningPair(tokens, lang, pairOpts)
        : { kind: "none" };

  if (warningPair.kind === "pair") {
    return {
      status: "resolved",
      normalized: text,
      intent: {
        kind: "timerWithWarning",
        durationSeconds: warningPair.durationSeconds,
        warningSeconds: warningPair.warningSeconds,
      },
    };
  }

  // Nothing recognizable as a scheduling command (and not the pair shape
  // above, which needs no trigger word of its own).
  if (families.length === 0) return { status: "none" };

  // Two different actions in one utterance ("set an alarm for seven and a timer
  // for ten minutes"). One turn executes one action, and picking which is
  // exactly the guess this parser must not make.
  if (families.length > 1) {
    return { status: "ambiguous", reason: "compound-request", normalized: text };
  }

  // A warning phrase alongside a timer, but no usable pair. Which question to
  // ask depends on which half is missing — asking "how long should the timer
  // be?" at someone who just said "ten minute timer" is the same failure as the
  // marker collision above, only quieter.
  if (warningPair.kind === "unresolved" && families.includes("timer")) {
    const stated = scanDuration(tokens, lang);
    return {
      status: "ambiguous",
      reason: stated ? "missing-warning-time" : "missing-duration",
      normalized: text,
    };
  }

  const family = families[0];

  // Values are read from the LAST segment that states one: a self-correction
  // supersedes everything before it. A qualifier the correction didn't restate
  // (typically the day) still carries over from the earlier segment.
  const segmentTokens = segmentsOf(norm.segments);
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
    const label = labelPhrase(duration.tokens, duration.hit.spans, lang);
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
    const targetDay = dateForHit(day?.hit ?? null, now);
    const settled = resolveClockInstant(
      clock.hit,
      targetDay,
      isNamedFutureDay(day?.hit ?? null),
      now,
      text,
      lang,
      prefersMorning(text, lang),
    );
    if ("ambiguous" in settled) {
      return {
        status: "ambiguous",
        reason: settled.ambiguous,
        normalized: text,
        detail: { hour12: settled.hour12 },
      };
    }
    const time = `${pad2(settled.at.getHours())}:${pad2(settled.at.getMinutes())}`;
    const label = labelPhrase(clock.tokens, clock.hit.spans, lang);
    return {
      status: "resolved",
      normalized: text,
      intent: {
        kind: "alarm",
        time,
        // Always carry the resolved day, even when the user didn't name one:
        // rule 6 may have rolled past midnight, and the confirmation should say
        // so. intent-to-tool adds Android's next-occurrence caveat when the
        // date is one the AlarmClock intent cannot honour.
        date: localDateStr(settled.at),
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
    const settled = resolveClockInstant(
      clock.hit,
      targetDay,
      isNamedFutureDay(day?.hit ?? null),
      now,
      text,
      lang,
      prefersMorning(text, lang),
    );
    if ("ambiguous" in settled) {
      return {
        status: "ambiguous",
        reason: settled.ambiguous,
        normalized: text,
        detail: { hour12: settled.hour12 },
      };
    }
    const when = settled.at;
    // Only reachable when the user named a day and that time on it has gone.
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
  // Title first: an event we cannot name goes to the model regardless, and
  // asking AM/PM about it would be a question with no useful answer.
  const title = leftoverPhrase(clock.tokens, clock.hit.spans, lang);
  if (!title) return { status: "none" };
  const targetDay = dateForHit(day?.hit ?? null, now);
  const settled = resolveClockInstant(
    clock.hit,
    targetDay,
    isNamedFutureDay(day?.hit ?? null),
    now,
    text,
    lang,
    false,
  );
  if ("ambiguous" in settled) {
    return {
      status: "ambiguous",
      reason: settled.ambiguous,
      normalized: text,
      detail: { hour12: settled.hour12 },
    };
  }
  const start = settled.at;
  return {
    status: "resolved",
    normalized: text,
    intent: { kind: "calendarEvent", start, title },
  };
}
