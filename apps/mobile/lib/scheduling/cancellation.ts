// "Actually, cancel." — the user taking back what they just said.
//
// Dictation has no backspace. A spoken request that goes wrong is corrected by
// talking: "set a timer for five minutes — actually, cancel". Everything before
// the correction is still in the transcript, so unless the turn understands
// abandonment it acts on a request that was explicitly withdrawn. On device
// that produced a REMINDER from "How do you handle different tenses in Latin?
// Actually, cancel." — the words were routed to the model, which obligingly
// built a tool call out of them.
//
// The signal is positional, not lexical. "cancel" is an ordinary word — people
// cancel subscriptions, shows get cancelled, reminders are set TO cancel
// things — so the token alone means nothing. What marks abandonment is a
// correction phrase in TERMINAL position: the last thing said, after the
// request it retracts. That is what these patterns match, and why a bare
// trailing "cancel"/"cancelled" deliberately does not.
//
// Pure and unit-tested. No clock, no platform, no model.

import type { Language } from "../orchestrator/types";

/**
 * Phrases that retract the utterance they end, per language.
 *
 * Each is matched only at the very end of the transcript. Two shapes:
 *
 *   self-standing   "never mind", "forget it", "scratch that" — unambiguous
 *                   on their own; nobody ends a real request this way.
 *   marked          a bare verb that needs a correction cue or an object
 *                   ("actually, cancel", "cancel that"). A trailing bare
 *                   "cancel" is NOT one of these: "Why was the TV show
 *                   cancelled?" is a question, not a retraction.
 */
const PATTERNS: Record<Language, RegExp[]> = {
  en: [
    // A correction cue followed by a retraction verb.
    /\b(?:actually|no|wait|oh|erm?|um|sorry)[\s,]+(?:cancel|scrap|skip|stop)(?:\s+(?:that|it|this))?$/,
    // A retraction verb with an explicit object.
    /\b(?:cancel|scrap|skip)\s+(?:that|it|this|the\s+(?:request|question|timer|alarm|reminder|event|last\s+(?:one|bit)))$/,
    /\bnever\s?mind(?:\s+(?:that|it))?$/,
    /\bforget\s+(?:it|that|about\s+it|i\s+(?:said|asked))$/,
    /\bscratch\s+that$/,
    /\b(?:ignore|disregard)\s+(?:that|it|the\s+last(?:\s+(?:one|bit|request))?)$/,
    /\b(?:don'?t|do\s+not)\s+(?:bother|worry\s+about\s+(?:it|that))$/,
    /\bas\s+you\s+were$/,
  ],
  it: [
    /\b(?:anzi|no|aspetta|scusa)[\s,]+(?:annulla|lascia\s+stare|niente|cancella)(?:\s+tutto)?$/,
    /\b(?:annulla|cancella)\s+(?:tutto|quello|la\s+richiesta|la\s+domanda)$/,
    /\blascia\s+stare$/,
    /\bnon\s+importa$/,
    /\bfa(?:i)?\s+niente$/,
    /\bnon\s+fa\s+niente$/,
    /\bscordatelo$/,
    /\bnulla$/,
  ],
};

/**
 * Trailing noise a recognizer leaves behind: final punctuation, the ellipsis
 * people dictate as a pause, and the whitespace around them. Stripped before
 * the end-anchored patterns run, so "…forget it." matches like "forget it".
 */
function trimTail(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?;,…\s]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The abandonment marker ending `text`, or null.
 *
 * Returns the matched phrase rather than a boolean so callers can log or show
 * WHAT was understood as a retraction — "I heard 'never mind'" is a much better
 * thing to be wrong about visibly than silently doing nothing.
 */
export function abandonmentMarker(text: string, lang: Language): string | null {
  const trimmed = trimTail(text);
  if (!trimmed) return null;
  // Both languages are checked regardless of the app language: the marker is a
  // short stock phrase and the recognizer's language is not always the app's.
  const patterns = [...PATTERNS[lang], ...PATTERNS[lang === "en" ? "it" : "en"]];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) return match[0].trim();
  }
  return null;
}

/** True when the utterance ends by taking itself back. */
export function isAbandoned(text: string, lang: Language): boolean {
  return abandonmentMarker(text, lang) !== null;
}

/** What Vesta says when it understands it is being called off. */
export function abandonmentAcknowledgement(lang: Language): string {
  return lang === "it" ? "Va bene, lascio stare." : "Okay, cancelled.";
}
