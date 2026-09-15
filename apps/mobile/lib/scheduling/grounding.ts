// A scheduling action may never invent a time.
//
// On device, "How do you handle different tenses in Latin? Actually, cancel."
// set a reminder for 11:30. Nothing in that sentence is a time. The value came
// from the MODEL: the parser declined the utterance (correctly — it contains no
// scheduling trigger and no temporal expression), the turn fell through to the
// model, and a sampled model asked to emit tool JSON filled the required
// `datetime` field with something plausible, because "plausible" is what
// sampling produces when the prompt gives it nothing to copy.
//
// The deterministic parser has always refused to do this — a missing clock
// returns `missing-time`, never a default. The hole was that the model path had
// no such rule, and a required field is precisely where a model is most likely
// to confabulate: the schema says it must be present, so it is made present.
//
// This module is the defence in depth the parser cannot provide: a check at the
// dispatch boundary, after routing and after any confirmation, asking one
// question of every timer, alarm, reminder and event before it runs —
//
//     did the temporal value come from the user?
//
// Provenance answers it. Values the parser resolved are grounded by
// construction. Values a model produced are not, and are checked against the
// utterance: if the user said nothing temporal at all, no temporal value can
// have come from them, and the call is refused rather than executed.
//
// Deliberately independent of parse.ts. A guard that shares its subject's
// machinery shares its blind spots; this one re-derives "is there a time in
// here?" from scratch, and errs toward refusing.

import type { Language } from "../orchestrator/types";

/**
 * Where a tool call's required temporal values came from.
 *
 *   parser         the deterministic scheduling parser built them from tokens
 *                  it found in the utterance. Grounded by construction: it
 *                  returns `missing-time` rather than guessing.
 *   clarification  the user answered a question about the missing value.
 *   model          a sampled model produced them. NOT grounded; verified here.
 *   api            an explicit programmatic call (the local MCP server), where
 *                  the caller passed the value itself. The parameters ARE the
 *                  input — there is no utterance to check them against.
 */
export type GroundingSource = "parser" | "clarification" | "model" | "api";

export interface Grounding {
  source: GroundingSource;
  /** What the user actually said. Required for `model`; unused otherwise. */
  utterance?: string;
  lang?: Language;
}

/** The parser's own output, grounded by construction. */
export function parserGrounding(utterance: string, lang: Language): Grounding {
  return { source: "parser", utterance, lang };
}

/** An explicit programmatic call, where the parameters are the input. */
export const apiGrounding: Grounding = { source: "api" };

/**
 * Required parameters that carry a time, date or duration, per tool.
 *
 * Only REQUIRED ones: an optional date a model adds to an alarm is a refinement
 * of a time the user did give, not an invention of the appointment itself.
 */
const TEMPORAL_REQUIRED: Record<string, string[]> = {
  set_alarm: ["time"],
  set_timer: ["minutes"],
  set_reminder: ["datetime"],
  create_event: ["start"],
};

/** The temporal fields `tool` requires, or [] when it schedules nothing. */
export function temporalFields(tool: string): string[] {
  return TEMPORAL_REQUIRED[tool] ?? [];
}

/** True when this tool arms something at a time and so needs grounding. */
export function schedulesSomething(tool: string): boolean {
  return temporalFields(tool).length > 0;
}

// ── Is there a time in here at all? ─────────────────────────────────────────
//
// Word-bounded throughout, and deliberately generous: this decides whether the
// user said ANYTHING temporal, not what they meant. A false "yes" only means
// the parser or the model gets its usual chance; a false "no" refuses a real
// request, so anything arguably temporal counts.

const TEMPORAL_PATTERNS: Record<Language, RegExp[]> = {
  en: [
    // Clock times: 7, 7:30, 7.30, 7pm, 07:30, and o'clock.
    /\b\d{1,2}\s*[:.]\s*\d{2}\b/,
    /\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/,
    /\bo'?clock\b/,
    // Durations and offsets: "in 5", "for 30 seconds", "half an hour".
    /\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|month|months|year|years)\b/,
    /\b(?:half|quarter)\s+(?:an?\s+)?(?:hour|past|to)\b/,
    /\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)\s+(?:second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/,
    // Named days, months and dates.
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/,
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b\d{1,2}(?:st|nd|rd|th)\b/,
    // Relative and named moments.
    /\b(?:today|tonight|tomorrow|yesterday|now|noon|midday|midnight|morning|afternoon|evening|night|weekend|dawn|dusk|sunrise|sunset)\b/,
    /\b(?:next|last|this|every|each)\s+(?:minute|hour|day|night|week|weekend|month|year|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    /\bin\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|half)\b/,
    /\b(?:before|after|at|by|until|till)\s+\d/,
  ],
  it: [
    /\b\d{1,2}\s*[:.]\s*\d{2}\b/,
    /\b\d+\s*(?:s|sec|secondi?|m|min|minuti?|h|ore?|giorni?|settimane?|mesi?|anni?)\b/,
    /\b(?:mezz'?a?|un\s+quarto\s+d)\s*ora\b/,
    /\b(?:un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|quindici|venti|trenta|quaranta|sessanta|novanta)\s+(?:secondi?|minuti?|ore?|giorni?|settimane?|mesi?|anni?)\b/,
    // No trailing \b: an accented final letter is not a word character to
    // JS's \b, so "giovedì" ending a sentence would never match.
    /\b(?:luned(?:i|ì)|marted(?:i|ì)|mercoled(?:i|ì)|gioved(?:i|ì)|venerd(?:i|ì)|sabato|domenica)(?![a-zà-ÿ])/,
    /\b(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:oggi|stasera|stanotte|domani|dopodomani|ieri|adesso|ora|subito|mezzogiorno|mezzanotte|mattina|mattino|pomeriggio|sera|notte|weekend|fine\s+settimana)\b/,
    /\b(?:prossim[oa]|scors[oa]|quest[oa]|ogni)\s+(?:minuto|ora|giorno|notte|settimana|mese|anno|mattina|pomeriggio|sera)\b/,
    /\b(?:tra|fra)\s+(?:un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|mezz)\b/,
    /\b(?:alle|dalle|entro|prima\s+delle|dopo\s+le)\s+\d/,
  ],
};

/**
 * True when `text` contains any explicit temporal expression.
 *
 * Both languages are always checked: the recognizer's language is not always
 * the app's, and refusing a real Italian request inside an English session
 * would be a worse failure than being slightly generous here.
 */
export function hasTemporalEvidence(text: string, lang: Language = "en"): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const other: Language = lang === "en" ? "it" : "en";
  return [...TEMPORAL_PATTERNS[lang], ...TEMPORAL_PATTERNS[other]].some((p) =>
    p.test(normalized),
  );
}

/**
 * Why this call must not run, or null when it may.
 *
 * The rule, in one place:
 *
 *   a tool that arms something at a time may only run when its required
 *   temporal values came from the user — the parser reading their words, an
 *   answer to a clarification, or an explicit API call. A model-produced value
 *   counts only if the user said something temporal for it to have come FROM.
 *
 * Missing grounding is a refusal, not a pass. A caller that has not said where
 * its values came from cannot be assumed to know.
 */
export function ungroundedTemporalValue(
  tool: string,
  params: Record<string, unknown>,
  grounding?: Grounding,
): string | null {
  const fields = temporalFields(tool);
  if (fields.length === 0) return null;

  const present = fields.filter(
    (f) => params[f] !== undefined && params[f] !== null && params[f] !== "",
  );
  if (present.length === 0) return null; // validation rejects it anyway

  if (!grounding) {
    return `${tool} needs ${present.join(", ")}, and the caller did not say where the value came from`;
  }

  switch (grounding.source) {
    case "parser":
    case "clarification":
    case "api":
      return null;
    case "model": {
      const utterance = grounding.utterance ?? "";
      if (hasTemporalEvidence(utterance, grounding.lang ?? "en")) return null;
      return `${tool} was given ${present.join(", ")}, but the request contains no time, date or duration to have taken it from`;
    }
  }
}

/** What the user is told when a call is refused for want of grounding. */
export function groundingRefusal(lang: Language): string {
  return lang === "it"
    ? "Non hai indicato un orario, quindi non ho impostato nulla. Dimmi quando."
    : "You didn't say when, so I haven't set anything. Tell me a time.";
}
