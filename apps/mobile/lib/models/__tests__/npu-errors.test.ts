// GenieX return codes, turned into sentences — without losing the code.
//
// The install failure that prompted this reached the user as
// `rc=-100010: geniex_model_pull failed (rc=-100010)`. Everything needed to
// diagnose it was in there and nothing needed to ACT on it was: no statement
// of what went wrong, no next step, and the same number twice.
//
// Both halves are load-bearing, so both are tested: the sentence must be
// actionable, and the raw code must survive into it.

import {
  readGenieXFailure,
  describeGenieXFailure,
  isHubModelNotFound,
} from "../npu-errors";

describe("the code that prompted all this", () => {
  const raw = "rc=-100010: geniex_model_pull failed (rc=-100010)";

  it("recognises hub-model-not-found and names the constant", () => {
    const failure = readGenieXFailure(new Error(raw));
    expect(failure.rc).toBe(-100010);
    expect(failure.name).toBe("GENIEX_ERROR_COMMON_HUB_MODEL_NOT_FOUND");
  });

  it("says it is about the remote hub, not about this phone", () => {
    // The distinction the user has to be able to act on: nothing about the
    // device, the chipset or the build changes this answer, so neither
    // retrying blindly nor different hardware is the fix.
    const { message } = readGenieXFailure(new Error(raw));
    expect(message).toMatch(/hub/i);
    expect(message).toMatch(/import/i);
  });

  it("keeps the raw code in the one-line form", () => {
    const line = describeGenieXFailure(new Error(raw));
    expect(line).toContain("-100010");
    expect(line).toContain("GENIEX_ERROR_COMMON_HUB_MODEL_NOT_FOUND");
  });

  it("is identifiable as the manual-import case", () => {
    expect(isHubModelNotFound(new Error(raw))).toBe(true);
    expect(isHubModelNotFound(new Error("rc=-100006: canceled"))).toBe(false);
  });

  it("preserves the runtime's original text untouched", () => {
    expect(readGenieXFailure(new Error(raw)).raw).toBe(raw);
  });
});

describe("codes read out of the SDK's own bytecode", () => {
  it("maps cancellation", () => {
    const failure = readGenieXFailure(new Error("rc=-100006: canceled"));
    expect(failure.name).toBe("GENIEX_ERROR_CANCELLED");
    expect(failure.message).toMatch(/cancel/i);
  });

  it("maps already-initialized", () => {
    expect(readGenieXFailure(new Error("rc=-100008: x")).name).toBe(
      "GENIEX_ERROR_ALREADY_INITIALIZED",
    );
  });
});

describe("codes with no verified meaning", () => {
  // Inventing an explanation for an unverified code is worse than offering
  // none: it sends the reader somewhere that is not the problem.
  it("claims nothing, but keeps the number", () => {
    const failure = readGenieXFailure(new Error("rc=-100099: something"));
    expect(failure.rc).toBe(-100099);
    expect(failure.name).toBeNull();
    expect(failure.message).toContain("-100099");
  });

  it("does not pretend an unknown code is the hub one", () => {
    expect(isHubModelNotFound(new Error("rc=-100011: x"))).toBe(false);
  });
});

describe("failures that carry no code at all", () => {
  it("falls back to the original text rather than inventing one", () => {
    const failure = readGenieXFailure(new Error("Network unreachable"));
    expect(failure.rc).toBeNull();
    expect(failure.message).toBe("Network unreachable");
  });

  it("never returns an empty message", () => {
    expect(readGenieXFailure(new Error("")).message.length).toBeGreaterThan(0);
    expect(readGenieXFailure(null).message.length).toBeGreaterThan(0);
    expect(readGenieXFailure(undefined).message.length).toBeGreaterThan(0);
  });

  it("handles a thrown non-Error", () => {
    expect(readGenieXFailure("plain string").message).toBe("plain string");
  });
});

describe("parsing the code out of the runtime's string", () => {
  it("reads it wherever the native side put it", () => {
    expect(readGenieXFailure(new Error("rc=-100010")).rc).toBe(-100010);
    expect(
      readGenieXFailure(new Error("pull failed rc=-100010: not found")).rc,
    ).toBe(-100010);
  });

  it("does not mistake a number inside a model name for a code", () => {
    // "Qwen3-4B-Instruct-2507" is full of digits and hyphens.
    const failure = readGenieXFailure(
      new Error("ai-hub-models/Qwen3-4B-Instruct-2507 could not be resolved"),
    );
    expect(failure.rc).toBeNull();
  });

  it("does not match a substring of another key", () => {
    // `src=-5` must not read as `rc=-5`.
    expect(readGenieXFailure(new Error("src=-5 failed")).rc).toBeNull();
  });
});
