// Speech normalization for scheduling commands: turn what a dictation engine
// actually produces into something a deterministic parser can read.
//
// The input is a system-recognizer transcript (FUTO / Google / whatever the
// user set), so it carries what people say rather than what they would type:
// fillers ("set a uh set a timer"), stammered repeats ("five five minute"),
// and mid-sentence self-corrections ("eight… no, eight thirty"). All three are
// handled here, before any value is parsed, so the parser itself stays a plain
// grammar over clean tokens.
//
// Everything in this file is pure and unit-tested. Nothing here decides an
// intent or a time — it only cleans and segments.

import type { Language } from "../orchestrator/types";

// Standalone filler words. Only ever dropped as WHOLE tokens: "um" must not
// eat the "um" in a word, and "like" is a filler only on its own.
const FILLERS: Record<Language, string[]> = {
  en: [
    "uh", "uhh", "um", "umm", "er", "erm", "ah", "hmm", "mm", "mhm",
    "like", "okay", "ok", "so", "well", "please",
  ],
  it: ["eh", "ehm", "mm", "mmm", "boh", "cioè", "tipo", "allora", "dai", "per favore"],
};

// Markers that open a correction: everything after the LAST one supersedes the
// same kind of value stated before it. Multi-word markers are matched first so
// "no wait" wins over a bare "no".
const CORRECTIONS: Record<Language, string[]> = {
  en: [
    "no wait", "wait no", "hold on", "scratch that", "make it", "let's say",
    "actually", "sorry", "i mean", "i meant", "rather", "instead", "no",
  ],
  it: [
    "anzi no", "no scusa", "aspetta no", "facciamo", "diciamo",
    "anzi", "scusa", "volevo dire", "invece", "no",
  ],
};

export interface NormalizedUtterance {
  // The full utterance with fillers removed and stammers collapsed.
  text: string;
  // `text` split at correction markers, in order, markers removed. Always at
  // least one segment; the LAST segment holds the user's final intent for any
  // value it mentions.
  segments: string[];
  // True when at least one correction marker was found — the caller may want
  // to be stricter about what it accepts from a corrected utterance.
  corrected: boolean;
}

// Lowercase, strip punctuation that dictation sprinkles in, and collapse
// whitespace. Ellipses/commas/dashes carry the pause that precedes a
// correction, so they become spaces rather than disappearing.
function basicClean(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[…]/g, " ")
      // A colon between digits is a clock ("19:30") and must survive; any other
      // colon is punctuation. Written without lookbehind for Hermes.
      .replace(/:/g, (_m, offset: number, str: string) =>
        /\d/.test(str[offset - 1] ?? "") && /\d/.test(str[offset + 1] ?? "")
          ? ":"
          : " ",
      )
      .replace(/[.,;!?\-–—"'`()]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Drop whole-token fillers.
function dropFillers(tokens: string[], lang: Language): string[] {
  const fillers = new Set(FILLERS[lang]);
  return tokens.filter((t) => !fillers.has(t));
}

// Collapse an immediately repeated token ("five five minute" → "five minute",
// "set a set a" handled by the phrase pass below).
//
// This is why a stammered number does not become a different number: the two
// tokens are identical, so one of them is noise by construction. A genuinely
// different pair ("five fifty") is left alone for the parser to read.
function collapseRepeatedTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (out.length > 0 && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}

// Collapse an immediately repeated 2-4 token phrase ("set a set a" → "set a").
// Runs after the single-token pass so "set a uh set a" has already lost its
// filler and reads as an exact repeat.
function collapseRepeatedPhrases(tokens: string[]): string[] {
  let out = tokens;
  for (let size = 4; size >= 2; size--) {
    const next: string[] = [];
    let i = 0;
    while (i < out.length) {
      const a = out.slice(i, i + size);
      const b = out.slice(i + size, i + size * 2);
      if (a.length === size && a.join(" ") === b.join(" ")) {
        next.push(...a);
        i += size * 2;
      } else {
        next.push(out[i]);
        i += 1;
      }
    }
    out = next;
  }
  return out;
}

// Split at correction markers. A marker only counts when it is followed by
// something — a trailing "no" is not a correction, it is the end of a sentence.
function splitOnCorrections(text: string, lang: Language): {
  segments: string[];
  corrected: boolean;
} {
  const markers = CORRECTIONS[lang];
  const tokens = text.split(" ").filter(Boolean);
  const segments: string[] = [];
  let current: string[] = [];
  let corrected = false;

  let i = 0;
  while (i < tokens.length) {
    let matched = 0;
    for (const marker of markers) {
      const size = marker.split(" ").length;
      if (tokens.slice(i, i + size).join(" ") === marker) {
        matched = size;
        break;
      }
    }
    // Only treat it as a correction when text follows it.
    if (matched > 0 && i + matched < tokens.length) {
      corrected = true;
      segments.push(current.join(" ").trim());
      current = [];
      i += matched;
      continue;
    }
    current.push(tokens[i]);
    i += 1;
  }
  segments.push(current.join(" ").trim());

  return { segments: segments.filter((s) => s.length > 0), corrected };
}

export function normalizeUtterance(
  input: string,
  lang: Language = "en",
): NormalizedUtterance {
  const cleaned = basicClean(input ?? "");
  if (!cleaned) return { text: "", segments: [], corrected: false };

  let tokens = cleaned.split(" ").filter(Boolean);
  tokens = dropFillers(tokens, lang);
  tokens = collapseRepeatedTokens(tokens);
  tokens = collapseRepeatedPhrases(tokens);
  // A phrase collapse can leave a new adjacent duplicate behind.
  tokens = collapseRepeatedTokens(tokens);

  const text = tokens.join(" ");
  const { segments, corrected } = splitOnCorrections(text, lang);
  return { text, segments: segments.length > 0 ? segments : [text], corrected };
}
