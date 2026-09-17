// Generated-token accounting: whose number it is, and when it cannot be true.
//
// From the device: a GenieX llama.cpp turn on SM8850 rendered "The capital of
// Rhode Island is Providence." and Diagnostics said `Generated: 1`, beside a
// decode speed of 23.2 tok/s that only makes sense for ten or so tokens.
//
// The audit answer is that Vesta counts nothing — `Generated` is
// `ProfilingData.generatedTokens` forwarded verbatim from the plugin, through
// the identical code the QAIRT lane uses. So the fix cannot be "count better";
// there is nothing here doing any counting to fix. What these pin is the rule
// that replaced it: the runtime's number is still the number, and text is the
// one witness that can prove it wrong.

import {
  MAX_CHARS_PER_TOKEN,
  minimumTokensFor,
  minimumTokensForChars,
  accountGeneratedTokens,
  describeGeneratedTokens,
} from "../token-accounting";

/** The answer from the device report. 42 characters. */
const ANSWER = "The capital of Rhode Island is Providence.";

describe("the floor is a proof, not an estimate", () => {
  it("is generous enough that no real tokenizer can fall below it", () => {
    // Real BPE vocabularies top out around 10-15 characters per token. The
    // bound has to be loose in that direction: a floor that cries wolf is worse
    // than useless, because it would teach the reader to ignore it.
    expect(MAX_CHARS_PER_TOKEN).toBeGreaterThanOrEqual(24);
  });

  it("never claims to know the count, only a lower bound", () => {
    // 42 characters proves "at least 2", not "about 10". Being certain is the
    // whole value; being close would require a tokenizer.
    expect(minimumTokensFor(ANSWER)).toBe(2);
    expect(minimumTokensFor(ANSWER)).toBeLessThan(10);
  });

  it("is zero for no text, so an empty turn contradicts nothing", () => {
    expect(minimumTokensFor("")).toBe(0);
    expect(minimumTokensForChars(0)).toBe(0);
    expect(minimumTokensForChars(-5)).toBe(0);
    expect(minimumTokensForChars(Number.NaN)).toBe(0);
  });

  it("rounds up — a partial token is still a token", () => {
    expect(minimumTokensForChars(1)).toBe(1);
    expect(minimumTokensForChars(MAX_CHARS_PER_TOKEN)).toBe(1);
    expect(minimumTokensForChars(MAX_CHARS_PER_TOKEN + 1)).toBe(2);
  });
});

describe("the reported count is kept, and kept honest", () => {
  it("believes a count that meets the floor, without checking it further", () => {
    const account = accountGeneratedTokens(10, ANSWER.length);
    expect(account.contradicted).toBe(false);
    expect(describeGeneratedTokens(account)).toBe("10");
  });

  it("catches the device case: 1 token for a 42-character answer", () => {
    const account = accountGeneratedTokens(1, ANSWER.length);
    expect(account.contradicted).toBe(true);
    expect(account.floor).toBe(2);
    // The number is still shown — it IS the bug, and hiding it would hide that.
    expect(describeGeneratedTokens(account)).toMatch(/^1 —/);
    expect(describeGeneratedTokens(account)).toMatch(/impossible/);
    expect(describeGeneratedTokens(account)).toMatch(/42 characters/);
  });

  it("does not invent a count to replace the impossible one", () => {
    // Substituting the floor would produce a plausible-looking number that is
    // just as wrong, and would hide the runtime's answer at the same time.
    const account = accountGeneratedTokens(1, ANSWER.length);
    expect(account.reported).toBe(1);
    expect(describeGeneratedTokens(account)).toContain("1");
  });

  it("says 'not reported' rather than 0 when the runtime stayed silent", () => {
    // A zero here reads as a measurement. Absence is not a measurement.
    const account = accountGeneratedTokens(undefined, ANSWER.length);
    expect(account.reported).toBeUndefined();
    expect(account.contradicted).toBe(false);
    expect(describeGeneratedTokens(account)).toBe("not reported");
  });

  it("treats a negative or non-finite count as not reported", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeGeneratedTokens(accountGeneratedTokens(bad, 100))).toBe(
        "not reported",
      );
    }
  });

  it("contradicts nothing when no text was produced", () => {
    // A cancelled turn that emitted nothing. Zero characters proves zero
    // tokens, so any reported count clears the floor.
    expect(accountGeneratedTokens(0, 0).contradicted).toBe(false);
    expect(accountGeneratedTokens(1, 0).contradicted).toBe(false);
  });

  it("cannot contradict a genuinely short answer", () => {
    // "Yes." really could be one token. The floor refuses to guess.
    expect(accountGeneratedTokens(1, "Yes.".length).contradicted).toBe(false);
  });
});

describe("chunk count is not token count", () => {
  // The requirement in the brief, stated as a property: how the text ARRIVED
  // must not be able to change what is reported about it.
  it("gives the same answer whether the text came in one chunk or many", () => {
    const chunks = ["The capital of ", "Rhode Island", " is Providence."];
    const whole = chunks.join("");
    const asOneChunk = accountGeneratedTokens(1, whole.length);
    const asManyChunks = accountGeneratedTokens(
      1,
      chunks.reduce((n, c) => n + c.length, 0),
    );
    expect(asOneChunk).toEqual(asManyChunks);
  });

  it("flags 'Generated: 1' for a multi-token answer delivered in ONE chunk", () => {
    // The exact shape of the bug: a runtime that streams its whole answer as a
    // single LlmStreamResult.Token and then reports one generated token. The
    // delivery is not evidence either way; the 42 characters are.
    const oneChunk = accountGeneratedTokens(1, ANSWER.length);
    expect(oneChunk.contradicted).toBe(true);
  });

  it("would flag it just as readily when streaming is off entirely", () => {
    // streamTokens:false — no callbacks at all. Nothing about the accounting
    // depends on there having been any, which is the point.
    expect(accountGeneratedTokens(1, ANSWER.length).contradicted).toBe(true);
  });
});
