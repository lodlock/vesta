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
import {
  canonicalChipset,
  type ChipsetIdentity,
  type RuntimeChipset,
} from "./chipset-identity";

export type NpuRefusal =
  | "not-npu-artifact" // a GGUF; llama.cpp's job, not a failure
  | "runtime-missing" // the build has no Qualcomm runtime in it
  | "device-unknown" // the platform won't tell us the chipset
  | "artifact-untargeted" // the artifact doesn't say what it was built for
  | "soc-mismatch" // built for a different chip
  | "chipset-unrecognised" // the runtime has never heard of this chip
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
  /**
   * The runtime's own chipset vocabulary — `ModelManagerWrapper.listChipsets()`,
   * one entry per chip with every spelling it answers to.
   *
   * Three states, and they are not the same:
   *   undefined  — never asked. Nothing extra is checked, and the device's own
   *                reported id is matched against the bundle's target directly.
   *   empty/null — asked, and the runtime had no table to give. Same treatment:
   *                an empty table is evidence of nothing, so it refuses nothing.
   *   entries    — the authority. Every id below is resolved through it, and a
   *                device chip that does not appear in it is refused: a runtime
   *                that does not know this silicon cannot be relied on to
   *                reject a bundle built for different silicon either.
   *
   * This is what lets "SM8850" (Android), the runtime's own device name, and
   * "SM8850" (the bundle's target) be recognised as one chip without any
   * hand-written marketing-name table — see chipset-identity.
   */
  chipsets?: RuntimeChipset[] | null;
}

/** How a chipset is named in a refusal: its canonical id, plus what was reported. */
function describe(id: ChipsetIdentity): string {
  return id.runtimeName && id.runtimeName.toUpperCase() !== id.canonical
    ? `${id.canonical} (${id.runtimeName})`
    : id.canonical;
}

const NPU_ARTIFACTS = new Set(["qairt_context", "geniex_bundle"]);

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

  // Every id — Android's, the runtime's, the bundle's — reduced to one
  // canonical form through the runtime's own table. Comparing the raw strings
  // is what made a OnePlus 15 refuse an SM8850 bundle: Android calls the chip
  // "SM8850" and GenieX calls the same chip by a device name.
  const table = device.chipsets;
  const target = canonicalChipset(model.targetSoc, table);
  const deviceChip = canonicalChipset(device.soc, table);

  if (!target) {
    // An NPU artifact that doesn't say what it was compiled for cannot be
    // matched to anything. Refusing is the only honest answer.
    return {
      ok: false,
      reason: "artifact-untargeted",
      message: `${model.displayName} doesn't record which chipset it was built for, so it can't be run safely.`,
    };
  }
  if (!deviceChip) {
    return {
      ok: false,
      reason: "device-unknown",
      message: "This device doesn't report its chipset, so NPU compatibility can't be confirmed.",
    };
  }

  // The runtime was asked and has a vocabulary, but this chip is not in it.
  // Fail closed, before the mismatch check: "the runtime has never heard of
  // this chip" is a different problem from "wrong chip", and sending a user
  // looking for a different artifact would be the wrong advice.
  if (deviceChip.tableConsulted && !deviceChip.knownToRuntime) {
    return {
      ok: false,
      reason: "chipset-unrecognised",
      message: `The Qualcomm runtime does not recognise this device's chipset (${deviceChip.canonical}), so it can't confirm ${model.displayName} will run here.`,
    };
  }

  if (deviceChip.canonical !== target.canonical) {
    return {
      ok: false,
      reason: "soc-mismatch",
      message: `${model.displayName} was built for ${describe(target)}; this device is ${describe(deviceChip)}.`,
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

/**
 * Whether loading this row needs a Qualcomm runtime to be ready first.
 *
 * NOT the same question as `isNpuModel()`, and that is the whole reason it
 * exists. A GenieX llama.cpp model's artifact is `gguf` — correctly, it IS a
 * GGUF — so every check shaped like "artifact !== 'gguf'" reads it as an
 * ordinary portable file. The startup restore was one of those checks: it
 * awaited the runtime probe only for non-GGUF artifacts, so a GenieX-managed
 * model reached its load with the probe still in flight, the lane reporting
 * itself unavailable, and llama.rn quietly taking the file.
 *
 * The honest question is about OWNERSHIP, which the `backend` column records.
 * The artifact test stays beside it for rows written before that column, where
 * a Qualcomm artifact is the only evidence there is.
 */
export function needsQualcommRuntime(
  model: Pick<InstalledModel, "artifact" | "backend">,
): boolean {
  return model.backend !== "llama_cpp" || isNpuModel(model);
}
