// What the hub actually has — asked, not assumed.
//
// The install failed with `rc=-100010` (hub model not found) on a device where
// the runtime, the chipset and the QAIRT plugin had all just been proven good.
// At that point three strings decide whether an asset resolves — the model
// name, the chipset and the precision — and Vesta was supplying all three from
// its own catalog. A hand-maintained copy of someone else's catalogue is wrong
// the moment they change it, and it cannot tell you WHICH of the three is
// wrong when it is.
//
// GenieX carries the answer already. `listHubModels()` returns, for every model
// the hub offers, the chipsets it offers that model FOR — in the hub's own
// vocabulary, which is the vocabulary the pull must be given. So:
//
//   - the chipset string comes from the hub's list for this model, matched to
//     this device through the runtime's chipset table (chipset-identity), not
//     from our catalog and not from Android's `Build.SOC_MODEL`
//   - "is this model even offered" is answered before the download starts
//   - when it is not offered, the failure can say what IS
//
// The catalog keeps its `targetSoc`, and it is still what the COMPATIBILITY
// guard checks — that is a question about this phone and must not depend on a
// network call. This module only decides what to ASK the hub for.

import {
  canonicalChipset,
  sameChipset,
  type RuntimeChipset,
} from "./chipset-identity";

/** One row of `listHubModels()`. */
export interface HubModel {
  name: string;
  modelType: string;
  /** Every chipset the hub has this model for, in the hub's own spelling. */
  chipsets: string[];
}

export type HubCatalog =
  | { ok: true; models: HubModel[] }
  | { ok: false; error: string };

export type HubResolution =
  /** The hub has it for this device; `chipset` is the exact string to pull with. */
  | { status: "available"; chipset: string; entry: HubModel }
  /** The hub knows the model but not for this chipset. */
  | { status: "wrong-chipset"; entry: HubModel; offered: string[] }
  /** The hub has no such model name at all. */
  | { status: "unknown-model"; offered: string[] }
  /** The hub could not be consulted; fall back to the catalog's own target. */
  | { status: "unreachable"; reason: string };

/**
 * Finds the hub entry for a model name.
 *
 * Exact match on the name, case-insensitively, and nothing looser. A model name
 * is an `org/repo` identifier the runtime validates itself ("invalid model
 * name: '…' must be 'org/repo'"); matching it fuzzily would install a different
 * model than the one the catalog entry promised.
 */
function entryFor(models: HubModel[], modelName: string): HubModel | undefined {
  const wanted = modelName.trim().toLowerCase();
  return models.find((m) => m.name.trim().toLowerCase() === wanted);
}

/**
 * Which of the hub's chipset spellings names THIS device's silicon.
 *
 * Both sides go through the runtime's own chipset table, so AI Hub's
 * `qualcomm-snapdragon-8-elite-gen5`, GenieX's device name and Android's
 * `SM8850` are compared as one canonical id — the same equivalence the
 * compatibility guard uses, and the same refusal to guess when the table does
 * not declare two spellings equivalent.
 *
 * Returns the hub's own string, because that is what the pull has to be given.
 */
export function hubChipsetFor(
  entry: HubModel,
  deviceSoc: string | null,
  table: RuntimeChipset[] | undefined,
): string | null {
  const device = canonicalChipset(deviceSoc, table);
  if (!device) return null;
  for (const offered of entry.chipsets) {
    if (sameChipset(device, canonicalChipset(offered, table))) return offered;
  }
  return null;
}

/**
 * Everything the install path needs to know before it spends a byte.
 *
 * `unreachable` is deliberately NOT a refusal. A phone with no connectivity, or
 * a hub endpoint that changed shape, should still be able to attempt the pull
 * with the catalog's own target — the runtime will give its own verdict, which
 * is the authority anyway. What this buys is a better failure when the hub CAN
 * be reached and the answer is no.
 */
export function resolveAgainstHub(
  catalog: HubCatalog,
  modelName: string,
  deviceSoc: string | null,
  table: RuntimeChipset[] | undefined,
): HubResolution {
  if (!catalog.ok) return { status: "unreachable", reason: catalog.error };

  const entry = entryFor(catalog.models, modelName);
  if (!entry) {
    return {
      status: "unknown-model",
      offered: catalog.models.map((m) => m.name),
    };
  }

  const chipset = hubChipsetFor(entry, deviceSoc, table);
  if (!chipset) {
    return { status: "wrong-chipset", entry, offered: entry.chipsets };
  }
  return { status: "available", chipset, entry };
}

/** The sentence a non-`available` resolution should reach the user as. */
export function explainResolution(
  resolution: HubResolution,
  displayName: string,
  deviceSoc: string | null,
): string | null {
  switch (resolution.status) {
    case "available":
    case "unreachable":
      return null;
    case "wrong-chipset":
      return (
        `Qualcomm's hub has ${displayName}, but not for ${deviceSoc ?? "this chipset"}. ` +
        `It currently offers: ${resolution.offered.join(", ") || "no chipsets"}.`
      );
    case "unknown-model":
      return (
        `Qualcomm's hub does not list ${displayName}. ` +
        (resolution.offered.length > 0
          ? `It currently offers ${resolution.offered.length} model(s): ${resolution.offered.slice(0, 8).join(", ")}${resolution.offered.length > 8 ? ", …" : ""}.`
          : "It returned no models at all.")
      );
  }
}
