// Whether a runtime's generated-token count can be believed.
//
// ## The observation
//
// A GenieX llama.cpp turn on SM8850 rendered "The capital of Rhode Island is
// Providence." — 42 characters — and Diagnostics reported `Generated: 1`,
// beside a decode speed of 23.2 tok/s that is only consistent with ten or so
// tokens. One of those two numbers is wrong, and they came from the same
// struct.
//
// ## Where the number comes from, and what is NOT happening
//
// Nothing in Vesta counts anything. `Generated` is
// `ProfilingData.generatedTokens`, forwarded verbatim:
//
//   GenieX plugin  → LlmGenerateResult.profileData
//   SDK (Kotlin)   → LlmStreamResult.Completed(profile)
//   VestaNpuModule → resultMap(): putDouble("generatedTokens", …)
//   npu.ts         → NpuRawResult.generatedTokens (pass-through)
//   backend        → recordRun({ generatedTokens })
//
// In particular it is NOT derived from stream callbacks, chunks, messages or
// completion events. `LlmStreamResult.Token` carries a `String` — a CHUNK, not
// necessarily one token — and Vesta never counts those: the only subscriber is
// the UI's `onToken`, which appends text and keeps no tally. The QAIRT lane
// reads the identical field through the identical code, so the two lanes differ
// only in which plugin filled the struct in.
//
// ## So this does not replace the runtime's number
//
// It cannot: a token count is a property of the tokenizer, and inferring one
// from callbacks is exactly the mistake that would make this field lie
// convincingly instead of obviously. The runtime's value is still what gets
// reported.
//
// What this adds is a FALSIFIER. Text of n characters cannot have been produced
// by fewer than ceil(n / MAX_CHARS_PER_TOKEN) tokens, whatever the tokenizer —
// so a count below that floor is provably wrong, and a diagnostics screen must
// not present it as an unqualified fact. This is a proof of impossibility, not
// an estimate: it never says what the count IS, only when the reported one
// cannot be true.

/**
 * The most characters one token may stand for, chosen to be safely too large.
 *
 * Real BPE vocabularies (Qwen3, Gemma, Llama) top out around 10-15 characters
 * for a single text token, with long whitespace runs the only common exception.
 * 32 is roughly double that, which is the direction the error has to lean: the
 * floor is only useful if it is a bound nothing can legitimately fall below, so
 * a loose bound that never cries wolf beats a tight one that sometimes does.
 *
 * The cost of being this conservative is that the floor is weak — a 42-character
 * answer only proves "at least 2 tokens". That is enough to catch the failure
 * this exists for, and being certain matters more than being close.
 */
export const MAX_CHARS_PER_TOKEN = 32;

/**
 * The fewest tokens that could possibly have produced this text.
 *
 * Counted in code units rather than grapheme clusters on purpose: a tokenizer
 * splits bytes, and an emoji that reads as one character to a human is several
 * tokens to every vocabulary in use here. Under-counting keeps this a floor.
 */
export function minimumTokensForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / MAX_CHARS_PER_TOKEN);
}

/** The same bound, for a caller holding the text itself. */
export function minimumTokensFor(text: string): number {
  return minimumTokensForChars(text?.length ?? 0);
}

export interface GeneratedTokenAccount {
  /** Exactly what the runtime said, untouched. Undefined = it did not say. */
  reported?: number;
  /** Characters of text the backend actually received this turn. */
  chars: number;
  /** The provable lower bound implied by `chars`. */
  floor: number;
  /**
   * True when `reported` is below what the text proves. The count is then known
   * to be wrong — not merely surprising.
   */
  contradicted: boolean;
}

/**
 * Takes a CHARACTER COUNT rather than the text, because that is what survives
 * into the run record — keeping several kilobytes of an answer alive for the
 * diagnostics screen would be a memory leak in service of one integer.
 */
export function accountGeneratedTokens(
  reported: number | undefined,
  chars: number,
): GeneratedTokenAccount {
  const floor = minimumTokensForChars(chars);
  const usable =
    reported !== undefined && Number.isFinite(reported) && reported >= 0;
  return {
    reported: usable ? reported : undefined,
    chars: Number.isFinite(chars) && chars > 0 ? chars : 0,
    floor,
    // Nothing to contradict when the runtime reported nothing, and a count that
    // meets the floor is simply believed — this makes no claim about whether it
    // is exactly right, only that it is not impossible.
    contradicted: usable && (reported as number) < floor,
  };
}

/**
 * The generated-token count as a diagnostics screen should print it.
 *
 * A contradicted count is still SHOWN — hiding the runtime's answer would lose
 * the evidence that there is a bug, and the number is the bug. It is shown with
 * the contradiction attached so nobody reads it as a measurement.
 */
export function describeGeneratedTokens(
  account: GeneratedTokenAccount,
): string {
  if (account.reported === undefined) return "not reported";
  if (!account.contradicted) return String(account.reported);
  return (
    `${account.reported} — runtime-reported, but impossible: ` +
    `${account.chars} characters of text needs at least ${account.floor} tokens`
  );
}
