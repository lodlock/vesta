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
  isTransientPullFailure,
  TRANSIENT_PULL_RC,
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

  // This omission cost a diagnostic round trip. libgeniex.so builds the
  // -100010 message from two string constants — "AI Hub model " and " not
  // found on hub" — so the runtime NAMES THE KEY IT LOOKED UP, after whatever
  // normalization it applied internally. Replacing that with a friendly
  // sentence threw away the one fact that separates "the asset is absent" from
  // "we asked under the wrong name".
  it("quotes the runtime, so the looked-up key survives to the user", () => {
    const line = describeGenieXFailure(
      new Error(
        "rc=-100010: AI Hub model qualcomm/Qwen3-4B-Instruct-2507 not found on hub",
      ),
    );
    expect(line).toContain("AI Hub model qualcomm/Qwen3-4B-Instruct-2507");
    expect(line).toContain("not found on hub");
    // …without losing the explanation or the code.
    expect(line).toContain("-100010");
    expect(line).toMatch(/hub/i);
  });

  it("does not quote the runtime when it only repeated the code", () => {
    // `rc=-100010` alone adds nothing the head does not already say.
    expect(describeGenieXFailure(new Error("rc=-100010"))).not.toContain(
      "runtime said",
    );
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

// Which failures are worth asking again for.
//
// The classification is GenieX's half of the retry story (the policy — how many
// times, how long — is download-retry.ts). It is one code, and it stays one
// code until another has the same evidence behind it: repeated on device during
// large pulls, the identical request later succeeding, and partial work that
// survives the failure.
describe("transient pull failures", () => {
  const rc = (code: number) => new Error(`rc=${code}: geniex_model_pull failed`);

  it("recognises the code observed on device", () => {
    expect(TRANSIENT_PULL_RC).toBe(-100005);
    expect(isTransientPullFailure(rc(TRANSIENT_PULL_RC))).toBe(true);
  });

  // A 404 is not transient. Asking twice cannot make Qualcomm publish an asset,
  // and a retry loop against it would just spend the user's battery.
  it("does not treat a hub 404 as transient", () => {
    expect(isTransientPullFailure(rc(-100010))).toBe(false);
  });

  // The user's own cancel arrives as a code like any other, and retrying it
  // would restart exactly what they just stopped.
  it("does not treat a cancel as transient", () => {
    expect(isTransientPullFailure(rc(-100006))).toBe(false);
  });

  // An unsourced code is not evidence of transience. Retrying one could mean
  // repeating a request that can never succeed.
  it("does not treat an unrecognised code as transient", () => {
    expect(isTransientPullFailure(rc(-100099))).toBe(false);
    expect(isTransientPullFailure(rc(-100001))).toBe(false);
  });

  it("does not treat a failure without a code as transient", () => {
    expect(isTransientPullFailure(new Error("No usable Qualcomm NPU runtime"))).toBe(
      false,
    );
    expect(isTransientPullFailure(null)).toBe(false);
  });

  // The number leads the message, so a code in the middle of prose is not a
  // match — the same rule readGenieXFailure already applies.
  it("reads the code the same way every other caller does", () => {
    expect(isTransientPullFailure(new Error("rc=-100005"))).toBe(true);
    expect(isTransientPullFailure(new Error("failed with -100005"))).toBe(false);
  });

  // Still reported with its number and the runtime's own words: a retry policy
  // that swallowed the reason would make a repeating failure unreadable.
  it("keeps the runtime's own text for the user", () => {
    const text = describeGenieXFailure(
      new Error(`rc=${TRANSIENT_PULL_RC}: connection reset`),
    );
    expect(text).toContain("-100005");
    expect(text).toContain("connection reset");
  });
});
