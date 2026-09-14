// What the assistant is allowed to show and say.
//
// Two jobs, both about not leaking the model's workings into a surface that is
// read aloud:
//
//  1. Reasoning never reaches the user. The first line of defence is the
//     runtime's own switch (`enableThinking: false`, see the orchestrator's
//     assist mode) and the second is llama.rn's reasoning-filtered `content`.
//     This module is the third: a model can still emit a thinking block when
//     the runtime doesn't recognize its format, or when a stray delimiter
//     survives, and "mostly hidden" is not hidden.
//
//  2. Tool-call JSON never reaches the user either. The chat screen renders a
//     confirmation for those; spoken aloud, a raw JSON object is gibberish.
//
// Pure and unit-tested — no model, no platform.

// Reasoning delimiters seen across the open-weight models this runs (Qwen's
// <think>, and the <thinking>/<reasoning>/<reflection> variants others use).
const REASONING_TAGS = ["think", "thinking", "reasoning", "reflection", "analysis"];

function stripPairedTags(text: string): string {
  let out = text;
  for (const tag of REASONING_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return out;
}

// An unclosed block — the model was cut off mid-thought, or the opening tag was
// swallowed. Everything from an orphan opener to the end is reasoning; anything
// after an orphan closer is the answer.
function stripOrphanTags(text: string): string {
  let out = text;
  for (const tag of REASONING_TAGS) {
    const close = out.lastIndexOf(`</${tag}>`);
    if (close !== -1) out = out.slice(close + tag.length + 3);
    const open = out.search(new RegExp(`<${tag}>`, "i"));
    if (open !== -1) out = out.slice(0, open);
  }
  return out;
}

// A tool call that reached a text reply — strip a leading/whole JSON object
// that carries a "tool" key rather than reading braces aloud.
function stripToolJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("```")) return text;
  const body = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  if (!/"tool"\s*:/.test(body)) return text;
  // Keep the human-facing "message" if there is one; otherwise drop it all.
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  return message ? message[1].replace(/\\"/g, '"') : "";
}

/**
 * The model's answer, as the user may see it: no reasoning, no tool JSON.
 * Returns an empty string when nothing of substance is left, which callers
 * should treat as "the model said nothing usable" rather than showing a blank.
 */
export function visibleAnswer(raw: string): string {
  if (!raw) return "";
  let out = stripPairedTags(raw);
  out = stripOrphanTags(out);
  out = stripToolJson(out);
  // Collapse the whitespace the strips leave behind — a removed block must not
  // leave a double space where the sentence used to join.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Roughly how much an assistant should say out loud before it becomes a
// monologue. Sentence-aware, so speech ends on a full stop rather than
// mid-clause.
const SPOKEN_LIMIT = 320;

/**
 * The spoken form of an answer. Speech is linear and uninterruptible in a way
 * a screen is not, so this is deliberately shorter than what is displayed:
 * whole sentences up to the limit, and a hard clip only if the model produced
 * one enormous sentence.
 */
export function spokenAnswer(visible: string, limit = SPOKEN_LIMIT): string {
  const text = visible
    // Markdown is for eyes: don't read asterisks, backticks and hashes aloud.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (sentences) {
    let out = "";
    for (const sentence of sentences) {
      if ((out + sentence).trim().length > limit) break;
      out += sentence;
    }
    if (out.trim().length > 0) return out.trim();
  }
  // One long sentence: clip on a word boundary.
  const clipped = text.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > limit / 2 ? clipped.slice(0, lastSpace) : clipped).trim() + "…";
}
