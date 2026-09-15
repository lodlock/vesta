// Which spelling does the runtime recognise?
//
// Three -100010s, each from a different wrong string, is enough evidence that
// guessing the next one is a bad strategy. `resolveAlias()` is the only public
// call that asks the SDK directly, so the probe asks it once per candidate and
// reports every answer rather than picking one.
//
// What is tested here is the candidate set and the reporting. The resolver is
// injected, so none of this needs a device — and deliberately, none of it
// decides anything: choosing between the answers is a human's job.

import {
  identityCandidates,
  probeHubIdentity,
  formatProbe,
} from "../npu-hub-probe";

const QWEN = "qualcomm/Qwen3-4B-Instruct-2507";

describe("the spellings worth asking about", () => {
  it("covers every form that has actually been in play", () => {
    const candidates = identityCandidates(QWEN, null).map((c) => c.candidate);
    // The catalog entry, the org the sample uses, the org the device returns,
    // the bare manifest id, and the QAIRT plugin's own registry style.
    expect(candidates).toContain(QWEN);
    expect(candidates).toContain("ai-hub-models/Qwen3-4B-Instruct-2507");
    expect(candidates).toContain("Qwen3-4B-Instruct-2507");
    expect(candidates).toContain("qwen3_4b_instruct_2507");
  });

  it("includes what listHubModels actually returned, attributed", () => {
    const rows = identityCandidates("ai-hub-models/Qwen3-4B-Instruct-2507", QWEN);
    const hubRow = rows.find((r) => r.candidate === QWEN);
    expect(hubRow?.source).toContain("listHubModels()");
  });

  it("asks about each distinct string once, merging where they coincide", () => {
    // The catalog entry already IS the device-org form today, so the two must
    // not produce a duplicate row.
    const candidates = identityCandidates(QWEN, QWEN).map((c) => c.candidate);
    expect(new Set(candidates).size).toBe(candidates.length);
    const merged = identityCandidates(QWEN, QWEN).find(
      (c) => c.candidate === QWEN,
    );
    expect(merged?.source).toContain("catalog entry");
  });

  it("derives from whatever model it is given, not from a hard-coded name", () => {
    const candidates = identityCandidates("org/Some-Other-Model", null).map(
      (c) => c.candidate,
    );
    expect(candidates).toContain("ai-hub-models/Some-Other-Model");
    expect(candidates).toContain("some_other_model");
  });

  it("copes with a name that has no org segment", () => {
    const candidates = identityCandidates("bare", null).map((c) => c.candidate);
    expect(candidates).toContain("bare");
    expect(candidates).toContain("ai-hub-models/bare");
  });
});

describe("asking the runtime", () => {
  it("reports every answer, including the ones that came back empty", () => {
    // A null is an ANSWER — "the runtime has nothing to say about this
    // spelling" is different from "it echoed it back" — so it is reported
    // rather than dropped.
    const resolve = async (name: string) =>
      name === QWEN ? "resolved/name" : null;
    return probeHubIdentity(QWEN, null, resolve, QWEN, "AIHUB").then((probe) => {
      expect(probe.rows.length).toBeGreaterThan(1);
      expect(probe.rows.find((r) => r.candidate === QWEN)?.resolved).toBe(
        "resolved/name",
      );
      expect(
        probe.rows.filter((r) => r.resolved === null).length,
      ).toBeGreaterThan(0);
    });
  });

  it("survives a resolver that throws, and keeps the other rows", () => {
    const resolve = async (name: string) => {
      if (name.startsWith("ai-hub-models/")) throw new Error("bridge gone");
      return "ok";
    };
    return probeHubIdentity(QWEN, null, resolve, QWEN, "AIHUB").then((probe) => {
      expect(
        probe.rows.find((r) => r.candidate.startsWith("ai-hub-models/"))?.resolved,
      ).toBeNull();
      expect(probe.rows.some((r) => r.resolved === "ok")).toBe(true);
    });
  });

  it("records what the install path would actually send", () => {
    return probeHubIdentity(QWEN, null, async () => null, QWEN, "AIHUB").then(
      (probe) => {
        expect(probe.pullName).toBe(QWEN);
        expect(probe.hub).toBe("AIHUB");
      },
    );
  });

  it("formats one line per candidate, with the pull request named", () => {
    return probeHubIdentity(QWEN, null, async () => null, QWEN, "AIHUB").then(
      (probe) => {
        const text = formatProbe(probe);
        expect(text).toContain(QWEN);
        expect(text).toContain("AIHUB");
        expect(text).toContain("(no answer)");
        expect(text.split("\n").length).toBe(probe.rows.length + 1);
      },
    );
  });
});
