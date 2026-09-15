// NPU compatibility: the check that runs before any artifact is loaded.
//
// Every case here is a refusal except one. That asymmetry is the design: the
// cost of a wrong yes is a crash on hardware the artifact was never compiled
// for, after the user has waited for gigabytes; the cost of a wrong no is that
// the model runs on llama.cpp, which is where it would have run anyway.

import { checkNpuCompatibility, isNpuModel } from "../npu-compat";
import type { InstalledModel } from "../types";

type CompatModel = Pick<
  InstalledModel,
  "artifact" | "targetSoc" | "runtimeVersion" | "displayName"
>;

const bundle = (over: Partial<CompatModel> = {}): CompatModel => ({
  artifact: "qairt_context",
  targetSoc: "SM8850",
  runtimeVersion: null,
  displayName: "Qwen3 4B Instruct 2507 (NPU)",
  ...over,
});

const device = (over: Partial<Parameters<typeof checkNpuCompatibility>[1]> = {}) => ({
  soc: "SM8850",
  runtimeAvailable: true,
  runtimeVersion: "0.4.0",
  ...over,
});

describe("the one case that passes", () => {
  it("accepts a bundle whose target matches the device", () => {
    expect(checkNpuCompatibility(bundle(), device())).toEqual({ ok: true });
  });

  it("ignores case and a vendor prefix on the chipset id", () => {
    expect(checkNpuCompatibility(bundle({ targetSoc: "sm8850" }), device()).ok).toBe(true);
    expect(
      checkNpuCompatibility(bundle(), device({ soc: "qcom-SM8850" })).ok,
    ).toBe(true);
  });

  it("accepts when the artifact needs an OLDER runtime than we have", () => {
    expect(
      checkNpuCompatibility(bundle({ runtimeVersion: "0.3.0" }), device({ runtimeVersion: "0.4.0" }))
        .ok,
    ).toBe(true);
  });
});

describe("refusals", () => {
  const refusal = (m: CompatModel, d: Parameters<typeof checkNpuCompatibility>[1]) => {
    const check = checkNpuCompatibility(m, d);
    if (check.ok) throw new Error("expected a refusal");
    return check;
  };

  it("a GGUF is llama.cpp's job, not a failure", () => {
    const check = refusal(bundle({ artifact: "gguf" }), device());
    expect(check.reason).toBe("not-npu-artifact");
    expect(check.message).toMatch(/llama\.cpp/);
  });

  it("no runtime in this build", () => {
    const check = refusal(bundle(), device({ runtimeAvailable: false }));
    expect(check.reason).toBe("runtime-missing");
    expect(check.message).toMatch(/NPU-BACKEND/);
  });

  it("the device won't say what chip it is", () => {
    expect(refusal(bundle(), device({ soc: null })).reason).toBe("device-unknown");
  });

  it("the artifact doesn't say what it was built for", () => {
    expect(refusal(bundle({ targetSoc: null }), device()).reason).toBe(
      "artifact-untargeted",
    );
  });

  it("built for a different chip — names both, so the user can tell why", () => {
    const check = refusal(bundle({ targetSoc: "SM8750" }), device({ soc: "SM8850" }));
    expect(check.reason).toBe("soc-mismatch");
    expect(check.message).toContain("SM8750");
    expect(check.message).toContain("SM8850");
  });

  it("needs a newer runtime than this build has", () => {
    const check = refusal(
      bundle({ runtimeVersion: "0.5.0" }),
      device({ runtimeVersion: "0.4.0" }),
    );
    expect(check.reason).toBe("runtime-too-old");
  });

  it("an empty chipset string is unknown, not a match", () => {
    expect(refusal(bundle(), device({ soc: "   " })).reason).toBe("device-unknown");
  });

  it("checks the runtime before the chipset, so a default build says the useful thing", () => {
    // On a non-Qualcomm phone with no runtime, "no runtime" is the answer that
    // helps; "wrong chip" would send the user looking for the wrong artifact.
    const check = refusal(
      bundle({ targetSoc: "SM8850" }),
      device({ soc: "exynos2400", runtimeAvailable: false }),
    );
    expect(check.reason).toBe("runtime-missing");
  });
});

describe("isNpuModel", () => {
  it("recognizes the Qualcomm artifact types", () => {
    expect(isNpuModel({ artifact: "qairt_context" })).toBe(true);
    expect(isNpuModel({ artifact: "geniex_bundle" })).toBe(true);
    expect(isNpuModel({ artifact: "gguf" })).toBe(false);
  });
});

// The runtime's own vocabulary, and the canonical identity built from it.
//
// This is the block the OnePlus 15 failed. Android reports "SM8850"; GenieX's
// `listChipsets()` names the same chip "Snapdragon 8 Elite Gen 5 QRD" and keeps
// SM8850 among its aliases. Compared as strings they are two chips and an
// installable bundle was refused. Compared through the runtime's own table they
// are one, and everything that really is a different chip still is.
describe("canonical chipset identity", () => {
  // The table as the device reports it: the machine id is an ALIAS, not the
  // name. Every equality below comes from this grouping and from nothing else.
  const known = [
    {
      name: "Snapdragon 8 Elite Gen 5 QRD",
      aliases: ["SM8850", "Snapdragon 8 Elite Gen 5"],
    },
    { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750"] },
  ];

  const refusal = (m: CompatModel, d: Parameters<typeof checkNpuCompatibility>[1]) => {
    const check = checkNpuCompatibility(m, d);
    if (check.ok) throw new Error("expected a refusal");
    return check;
  };

  it("SM8850 and the runtime's 'Snapdragon 8 Elite Gen 5 QRD' are one chip", () => {
    expect(
      checkNpuCompatibility(bundle(), device({ chipsets: known })).ok,
    ).toBe(true);
  });

  it("…and so is the marketing name without the QRD suffix", () => {
    expect(
      checkNpuCompatibility(
        bundle(),
        device({ soc: "Snapdragon 8 Elite Gen 5", chipsets: known }),
      ).ok,
    ).toBe(true);
  });

  it("normalizes case, spacing and the vendor prefix on the way in", () => {
    expect(
      checkNpuCompatibility(
        bundle({ targetSoc: " sm8850 " }),
        device({ soc: "qcom-SM8850", chipsets: known }),
      ).ok,
    ).toBe(true);
    expect(
      checkNpuCompatibility(
        bundle(),
        device({ soc: "snapdragon 8 elite gen 5 qrd", chipsets: known }),
      ).ok,
    ).toBe(true);
  });

  it("SM8750 is still not SM8850 — one digit, different silicon", () => {
    const check = refusal(
      bundle({ targetSoc: "SM8750" }),
      device({ soc: "SM8850", chipsets: known }),
    );
    expect(check.reason).toBe("soc-mismatch");
    expect(check.message).toContain("SM8750");
    expect(check.message).toContain("SM8850");
  });

  it("'Snapdragon 8 Elite' is not 'Snapdragon 8 Elite Gen 5', substring or not", () => {
    const check = refusal(
      bundle({ targetSoc: "Snapdragon 8 Elite" }),
      device({ soc: "Snapdragon 8 Elite Gen 5", chipsets: known }),
    );
    expect(check.reason).toBe("soc-mismatch");
  });

  it("an 8 Elite Gen 4 the table never mentions is not gen 5", () => {
    const check = refusal(
      bundle({ targetSoc: "Snapdragon 8 Elite Gen 4" }),
      device({ soc: "SM8850", chipsets: known }),
    );
    expect(check.reason).toBe("soc-mismatch");
  });

  it("fails closed on a device chipset the runtime has never heard of", () => {
    // A runtime that does not know this silicon cannot be relied on to reject
    // a bundle built for different silicon either.
    const check = refusal(
      bundle(),
      device({ soc: "SM9999", chipsets: known }),
    );
    expect(check.reason).toBe("chipset-unrecognised");
    expect(check.message).toContain("SM9999");
  });

  it("fails closed on a bundle target the runtime has never heard of", () => {
    const check = refusal(
      bundle({ targetSoc: "SM9999" }),
      device({ soc: "SM8850", chipsets: known }),
    );
    expect(check.reason).toBe("soc-mismatch");
    expect(check.message).toContain("SM9999");
  });

  it("fails closed when the device reports no chipset at all", () => {
    expect(refusal(bundle(), device({ soc: null, chipsets: known })).reason).toBe(
      "device-unknown",
    );
  });

  it("fails closed when the bundle records no target", () => {
    expect(
      refusal(bundle({ targetSoc: null }), device({ chipsets: known })).reason,
    ).toBe("artifact-untargeted");
  });

  it("names both chips in a mismatch, raw name included, so a user can see why", () => {
    const check = refusal(
      bundle({ targetSoc: "SM8750" }),
      device({ soc: "SM8850", chipsets: known }),
    );
    // The canonical id decides; the runtime's own words are carried along so
    // the message matches what the diagnostics screen shows.
    expect(check.message).toContain("Snapdragon 8 Elite Gen 5 QRD");
  });

  it("checks nothing extra when the table was never consulted", () => {
    // undefined is "not asked", which is not the same as "not recognised" —
    // conflating them would refuse every model on a device whose probe simply
    // hasn't run yet.
    expect(checkNpuCompatibility(bundle(), device()).ok).toBe(true);
    expect(
      checkNpuCompatibility(bundle(), device({ chipsets: undefined })).ok,
    ).toBe(true);
  });

  it("treats an empty table as 'no table', not 'knows nothing'", () => {
    // listChipsets() can come back empty (the native side logs and continues).
    // An empty table is evidence of nothing, so it must refuse nothing.
    expect(checkNpuCompatibility(bundle(), device({ chipsets: [] })).ok).toBe(true);
  });

  it("cannot resolve a marketing name with no table — and refuses rather than guess", () => {
    // No hand-written mapping anywhere: without the runtime saying so, the
    // marketing name is simply a different string.
    const check = refusal(
      bundle(),
      device({ soc: "Snapdragon 8 Elite Gen 5" }),
    );
    expect(check.reason).toBe("soc-mismatch");
  });
});
