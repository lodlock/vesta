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
