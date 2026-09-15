// Whether an NPU artifact can run on THIS phone.
//
// A GGUF needs no such check: it is portable, and if it loads it runs. A
// Qualcomm bundle is the opposite — compiled for one SoC family, quantized for
// that hardware, tied to a runtime version. Running one on the wrong chip is
// not a degraded experience; it fails, possibly loudly, after the user has
// downloaded gigabytes.
//
// So this answers before anything is loaded, and it answers NO by default:
// every unknown is a refusal. An unreported chipset is not "probably fine", a
// missing target is not "probably this one", and an absent runtime is never
// "maybe it'll work". The cost of a wrong yes is a crash; the cost of a wrong
// no is that the model runs on llama.cpp, which is where it would have run
// anyway.

import type { InstalledModel } from "./types";

export type NpuRefusal =
  | "not-npu-artifact" // a GGUF; llama.cpp's job, not a failure
  | "runtime-missing" // the build has no Qualcomm runtime in it
  | "device-unknown" // the platform won't tell us the chipset
  | "artifact-untargeted" // the artifact doesn't say what it was built for
  | "soc-mismatch" // built for a different chip
  | "runtime-too-old"; // the artifact needs a newer runtime than we have

export type NpuCompatibility =
  | { ok: true }
  | { ok: false; reason: NpuRefusal; message: string };

export interface NpuDevice {
  /** The chipset this phone reports, or null when unknown. */
  soc: string | null;
  /** Whether a Qualcomm runtime is present in this build at all. */
  runtimeAvailable: boolean;
  /** The runtime's version, when it is available. */
  runtimeVersion: string | null;
}

const NPU_ARTIFACTS = new Set(["qairt_context", "geniex_bundle"]);

// SoC ids are case-insensitive in practice and sometimes carry a vendor prefix.
function normalizeSoc(soc: string | null): string | null {
  if (!soc) return null;
  const trimmed = soc.trim().toUpperCase().replace(/^QCOM[-_]?/, "");
  return trimmed.length > 0 ? trimmed : null;
}

// "0.4.0" → [0,4,0]. Anything unparseable sorts as "unknown" rather than zero,
// so a garbled version never reads as older-than-everything.
function parseVersion(version: string | null): number[] | null {
  if (!version) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function olderThan(have: number[], need: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

export function checkNpuCompatibility(
  model: Pick<InstalledModel, "artifact" | "targetSoc" | "runtimeVersion" | "displayName">,
  device: NpuDevice,
): NpuCompatibility {
  if (!NPU_ARTIFACTS.has(model.artifact)) {
    return {
      ok: false,
      reason: "not-npu-artifact",
      message: "This model runs on llama.cpp.",
    };
  }
  if (!device.runtimeAvailable) {
    return {
      ok: false,
      reason: "runtime-missing",
      message:
        "This build has no Qualcomm NPU runtime — see docs/NPU-BACKEND.md for how to build one in.",
    };
  }

  const deviceSoc = normalizeSoc(device.soc);
  const targetSoc = normalizeSoc(model.targetSoc);

  if (!targetSoc) {
    // An NPU artifact that doesn't say what it was compiled for cannot be
    // matched to anything. Refusing is the only honest answer.
    return {
      ok: false,
      reason: "artifact-untargeted",
      message: `${model.displayName} doesn't record which chipset it was built for, so it can't be run safely.`,
    };
  }
  if (!deviceSoc) {
    return {
      ok: false,
      reason: "device-unknown",
      message: "This device doesn't report its chipset, so NPU compatibility can't be confirmed.",
    };
  }
  if (deviceSoc !== targetSoc) {
    return {
      ok: false,
      reason: "soc-mismatch",
      message: `${model.displayName} was built for ${targetSoc}; this device is ${deviceSoc}.`,
    };
  }

  const need = parseVersion(model.runtimeVersion);
  const have = parseVersion(device.runtimeVersion);
  if (need && have && olderThan(have, need)) {
    return {
      ok: false,
      reason: "runtime-too-old",
      message: `${model.displayName} needs runtime ${model.runtimeVersion}; this build has ${device.runtimeVersion}.`,
    };
  }

  return { ok: true };
}

/** True when this model is meant for the NPU at all, compatible or not. */
export function isNpuModel(model: Pick<InstalledModel, "artifact">): boolean {
  return NPU_ARTIFACTS.has(model.artifact);
}
