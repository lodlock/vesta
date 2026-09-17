// Getting the NPU backend into a state where it can answer honestly.
//
// The backend refuses on every unknown, by design: no chipset means
// "device-unknown", an unprobed runtime means "runtime-missing". That is the
// right default, and it has one consequence that has to be handled rather than
// hoped away — **the facts have to arrive before the first load, not after it.**
//
// They did not, at first. The chipset was set only by the Models screen's
// refresh(), and the runtime was probed fire-and-forget AFTER
// ensureModelLoaded(). A cold start straight into the assistant — force-stop,
// invoke, ask — therefore reached the load with neither, and an NPU model that
// works perfectly would have been refused as "this device doesn't report its
// chipset". The refusal would have been correct on its own terms and completely
// wrong about the world.
//
// So this exists as one awaited step, called by whoever is about to load a
// model, and it is cheap to call on every boot: in a default build there is no
// native module and it returns immediately; on an NPU build the probe is cached
// for the process, so only the first call pays for the SDK's init.

import {
  genieXLlamaCpp,
  setDeviceSoc,
  setRuntimeChipsets,
} from "../llm/backends/registry";
import { loadGenieXComputeUnit } from "./geniex-compute";
import { getDeviceInfo } from "../native/system-actions";
import {
  isNpuBuild,
  probeNpuRuntime,
  npuProbeHasRun,
  npuUnavailableReason,
  npuDeviceChipset,
} from "../native/npu";
import {
  canonicalChipset,
  type RuntimeChipset,
} from "./chipset-identity";

export interface NpuReadiness {
  /** The bridge was compiled in (VESTA_ENABLE_NPU=1). */
  inBuild: boolean;
  /**
   * …and the one-time runtime probe has finished, whatever it found.
   *
   * Separate from `available` because "it did not start" and "nothing has
   * asked yet" are different facts and only one of them is about the device.
   * Reported so a screen can say which it is instead of printing the pessimistic
   * reading of both.
   */
  probed: boolean;
  /** …and the runtime actually started on this device. */
  available: boolean;
  /** …or, when it didn't, the SDK's own words for why. */
  reason: string | null;
  runtimeVersion: string | null;
  /** What Android reports (`Build.SOC_MODEL`), raw. */
  soc: string | null;
  /**
   * What the RUNTIME calls the same chip, raw and untranslated — the name out
   * of its own `listChipsets()` entry. `undefined` = never asked; `null` =
   * asked, and it does not know this chip. The distinction is load-bearing.
   *
   * This is a DIAGNOSTIC value. Nothing compares it; on the OnePlus 15 it is a
   * device/marketing name while Android says "SM8850", and treating those as
   * different chips is the bug canonicalSoc exists to fix.
   */
  runtimeChipset: string | null | undefined;
  /**
   * The one id both of the above reduce to — what compatibility is actually
   * decided on. Null when the device reports no chipset at all.
   */
  canonicalSoc: string | null;
  /** The runtime's whole chipset table, for the paths that resolve ids themselves. */
  chipsets: RuntimeChipset[] | undefined;
}

const UNAVAILABLE: NpuReadiness = {
  inBuild: false,
  probed: false,
  available: false,
  reason: null,
  runtimeVersion: null,
  soc: null,
  runtimeChipset: undefined,
  canonicalSoc: null,
  chipsets: undefined,
};

// The chipset table cannot change while the process lives, and reading it costs
// a bridge hop plus a runtime call. The probe caches itself; this caches the
// rest, so calling prepare on every boot path is free after the first.
let cached: NpuReadiness | null = null;

// Whether the remembered compute unit has been put back on the backend this
// process. Once only: after that the Diagnostics selector owns the value, and
// re-reading the row would undo a choice made since.
let computeUnitRestored = false;

/**
 * Puts the remembered GenieX compute unit back on the backend.
 *
 * Part of readiness rather than of startup, because it answers the same
 * question the rest of this module does: what the backend needs to know before
 * it is asked to load anything. A session built before this runs is a session
 * built on a default the user did not choose.
 */
async function restoreComputeUnit(): Promise<void> {
  if (computeUnitRestored) return;
  computeUnitRestored = true;
  genieXLlamaCpp().setComputeUnit(await loadGenieXComputeUnit());
}

/**
 * Tells the NPU backend what device it is on, and whether its runtime works.
 *
 * @param soc The chipset, when the caller already has it (the Models screen has
 *   it from device-caps). Omitted, it is read from the native device info —
 *   cheaper than a full device-caps read, which also stats the filesystem.
 */
export async function prepareNpuBackend(
  soc?: string | null,
): Promise<NpuReadiness> {
  // A default build has no bridge, so there is nothing to prepare and nothing
  // to report. Returning early also keeps a GGUF-only boot from paying for a
  // device-info call it has no use for.
  if (!isNpuBuild()) return UNAVAILABLE;

  // Before the early return below: prepare is called from the load paths, and
  // a cached readiness must not mean the pending compute unit is still whatever
  // the class field was initialised to.
  await restoreComputeUnit();

  if (cached && (soc === undefined || soc === cached.soc)) return cached;

  const chipset =
    soc !== undefined ? soc : ((await getDeviceInfo())?.soc ?? null);

  // Set FIRST, unconditionally: the backend needs it to match an artifact's
  // target even while the probe is still deciding.
  setDeviceSoc(chipset);

  const runtime = await probeNpuRuntime();
  let known: RuntimeChipset[] | undefined = undefined;
  let runtimeChipset: string | null | undefined = undefined;
  if (runtime) {
    const report = await npuDeviceChipset();
    known = report?.known;
    setRuntimeChipsets(known);
    const identity = canonicalChipset(chipset, known);
    // Only meaningful once there is a table: without one, nothing was asked.
    runtimeChipset = identity?.tableConsulted
      ? (identity.runtimeName ?? null)
      : undefined;
  }

  cached = {
    inBuild: true,
    probed: npuProbeHasRun(),
    available: runtime !== null,
    reason: runtime ? null : npuUnavailableReason(),
    runtimeVersion: runtime?.version ?? null,
    soc: chipset,
    runtimeChipset,
    canonicalSoc: canonicalChipset(chipset, known)?.canonical ?? null,
    chipsets: known,
  };
  return cached;
}

/** Forgets the cached readiness. Only for tests. */
export function resetNpuReadinessForTests(): void {
  cached = null;
  computeUnitRestored = false;
}
