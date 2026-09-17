// The GenieX llama.cpp compute unit, remembered across restarts.
//
// It was process state and nothing else: a field on the backend, set from the
// Diagnostics buttons, gone the moment the app was killed. Every restart came
// back as `hybrid` whatever had been selected, so a session restored at startup
// was built on a configuration nobody had chosen and the selector disagreed
// with the session as soon as anyone looked at it.
//
// So it is stored, and it is stored as a PENDING choice — the same thing the
// setter has always meant. Restoring it changes what the NEXT load will use; it
// never claims anything about a session, which is `getLoadedComputeUnit()`'s
// job and is set only by a load that succeeded.

import { getConfig, setConfig } from "../storage/database";
import {
  DEFAULT_GENIEX_COMPUTE_UNIT,
  type GenieXComputeUnit,
} from "../native/npu";

/** The config key. One place, so a typo cannot silently mean "always default". */
export const GENIEX_COMPUTE_UNIT_KEY = "geniex_compute_unit";

const UNITS: readonly GenieXComputeUnit[] = ["cpu", "gpu", "npu", "hybrid"];

/**
 * A stored value, when it is one the runtime understands.
 *
 * Anything else — an empty row, a value from a newer build, a hand-edited
 * database — reads as null and the caller takes the default. Casting a string
 * off disk into an alias GenieX would reject turns a stale config row into a
 * load failure on every boot.
 */
export function parseComputeUnit(
  raw: string | null | undefined,
): GenieXComputeUnit | null {
  return raw && (UNITS as readonly string[]).includes(raw)
    ? (raw as GenieXComputeUnit)
    : null;
}

/** The remembered choice, or the default when there is none to remember. */
export async function loadGenieXComputeUnit(): Promise<GenieXComputeUnit> {
  try {
    return (
      parseComputeUnit(await getConfig(GENIEX_COMPUTE_UNIT_KEY)) ??
      DEFAULT_GENIEX_COMPUTE_UNIT
    );
  } catch {
    // A database that cannot be read is not a reason to refuse to start the
    // runtime; it is a reason to use the default and say nothing.
    return DEFAULT_GENIEX_COMPUTE_UNIT;
  }
}

/** Remembers the choice for the next launch. */
export async function saveGenieXComputeUnit(
  unit: GenieXComputeUnit,
): Promise<void> {
  await setConfig(GENIEX_COMPUTE_UNIT_KEY, unit);
}
