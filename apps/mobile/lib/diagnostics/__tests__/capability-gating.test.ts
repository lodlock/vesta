// What makes a Qualcomm diagnostics section EXIST, and what makes it say
// something.
//
// These were one thing, and they are not. The screen gated every Qualcomm
// section — the runtime, the GenieX llama.cpp lane, the hub — on hub state,
// which is only populated by a query the user starts from the Models screen.
// So a device with working Snapdragon silicon showed nothing about it until
// somebody had gone to another screen and made a network request, and the two
// sections that describe the LOCAL runtime were the ones hidden behind it.
//
// Existence is a question about the build. What a section says is a question
// about what has been asked. These pin both halves apart, including the states
// that are easiest to collapse: "nobody has probed" is not "the probe failed",
// and "nobody has checked the hub" is not "the hub check failed".

import {
  describeHubCheck,
  describeNpuCapability,
  formatHubState,
  hubCheckState,
  npuCapabilityState,
  type HubDiag,
  type NpuCapability,
} from "../sections";

const cap = (over: Partial<NpuCapability> = {}): NpuCapability => ({
  inBuild: true,
  probed: true,
  available: true,
  reason: null,
  ...over,
});

const hub = (over: Partial<HubDiag> = {}): HubDiag => ({
  checkedAt: null,
  cached: false,
  total: 0,
  compatible: 0,
  otherChipsets: 0,
  unsupportedType: 0,
  pullability: null,
  canonicalSoc: "SM8850",
  error: null,
  activeNpuModel: null,
  ...over,
});

const ISO = (ms: number) => new Date(ms).toISOString();
const WHEN = Date.parse("2026-09-17T10:00:00.000Z");

describe("the four runtime capability states stay distinct", () => {
  it("no bridge in the build is 'absent', and is not a fault", () => {
    const c = cap({ inBuild: false, probed: false, available: false });
    expect(npuCapabilityState(c)).toBe("absent");
    expect(describeNpuCapability(c)).toMatch(/not in this build/);
  });

  it("compiled in but never probed is 'unprobed', not 'failed'", () => {
    // The state a freshly opened Diagnostics screen used to be stuck in, and
    // the one that must never be reported as broken hardware.
    const c = cap({ probed: false, available: false });
    expect(npuCapabilityState(c)).toBe("unprobed");
    expect(describeNpuCapability(c)).toBe("compiled in, not probed yet");
    expect(describeNpuCapability(c)).not.toMatch(/fail/i);
  });

  it("a probe that ran and found nothing is 'failed', in the runtime's words", () => {
    const c = cap({
      probed: true,
      available: false,
      reason: "libGenieX.so failed to load",
    });
    expect(npuCapabilityState(c)).toBe("failed");
    expect(describeNpuCapability(c)).toContain("libGenieX.so failed to load");
  });

  it("says a failure happened even when the runtime gave no reason", () => {
    const c = cap({ probed: true, available: false, reason: null });
    expect(npuCapabilityState(c)).toBe("failed");
    expect(describeNpuCapability(c)).toMatch(/probe failed/);
  });

  it("a started runtime is 'ready'", () => {
    expect(npuCapabilityState(cap())).toBe("ready");
    expect(describeNpuCapability(cap())).toBe("probed and running");
  });

  it("never reports a failed probe as available", () => {
    // The one substitution that would make this screen worthless.
    const c = cap({ probed: true, available: false, reason: "no HTP device" });
    expect(describeNpuCapability(c)).not.toMatch(/running/);
  });
});

describe("hub state is about the hub, and says so from the first open", () => {
  it("never asked reads as never asked, and says where to ask", () => {
    expect(hubCheckState(hub())).toBe("never");
    const line = describeHubCheck(hub(), ISO);
    expect(line).toMatch(/^never/);
    expect(line).toMatch(/Check Qualcomm Hub/);
  });

  it("distinguishes a check that failed from one never made", () => {
    const failed = hub({ error: "Unable to resolve host" });
    expect(hubCheckState(failed)).toBe("failed");
    expect(describeHubCheck(failed, ISO)).toContain("Unable to resolve host");
    expect(describeHubCheck(failed, ISO)).not.toBe(describeHubCheck(hub(), ISO));
  });

  it("marks a snapshot restored from disk as what it is", () => {
    const c = hub({ checkedAt: WHEN, cached: true, total: 19 });
    expect(hubCheckState(c)).toBe("cached");
    expect(describeHubCheck(c, ISO)).toMatch(/cached from an earlier session/);
  });

  it("keeps a good snapshot beside a later failure rather than hiding either", () => {
    const stale = hub({ checkedAt: WHEN, total: 19, error: "timed out" });
    expect(hubCheckState(stale)).toBe("stale");
    const line = describeHubCheck(stale, ISO);
    expect(line).toContain("2026-09-17");
    expect(line).toContain("timed out");
  });

  it("a fresh successful check is just the time", () => {
    const ok = hub({ checkedAt: WHEN, total: 19 });
    expect(hubCheckState(ok)).toBe("checked");
    expect(describeHubCheck(ok, ISO)).toBe(ISO(WHEN));
  });
});

describe("the text report carries the same states", () => {
  it("prints an unchecked hub rather than omitting the section", () => {
    // The report is what gets pasted into a bug thread. A missing section reads
    // as "this device has no hub"; "never" reads as "nobody asked".
    const text = formatHubState(hub());
    expect(text).toContain("Qualcomm Hub state");
    expect(text).toMatch(/last check: never/);
    expect(text).toContain("models returned: 0");
  });

  it("names a failure once, not twice", () => {
    const text = formatHubState(hub({ error: "Unable to resolve host" }));
    expect(text.match(/Unable to resolve host/g)).toHaveLength(1);
  });

  it("still prints nothing at all for a build with no Qualcomm runtime", () => {
    // The caller passes null in that case — the section is dropped by the
    // BUILD, which is the only thing allowed to drop it.
    expect(formatHubState(null)).toBe("");
  });
});
