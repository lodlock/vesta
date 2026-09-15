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
  /**
   * The hub has it for this device. Both `modelName` and `chipset` are the
   * HUB'S OWN spellings and are what the pull must be given.
   */
  | { status: "available"; modelName: string; chipset: string; entry: HubModel }
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
function entryFor(
  models: HubModel[],
  names: (string | null | undefined)[],
): HubModel | undefined {
  for (const name of names) {
    if (!name) continue;
    const wanted = name.trim().toLowerCase();
    const hit = models.find((m) => m.name.trim().toLowerCase() === wanted);
    if (hit) return hit;
  }
  return undefined;
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
  /**
   * What `ModelManagerWrapper.resolveAlias()` made of the name, when it was
   * asked. Tried after the literal name, because the catalogue may list a
   * model under its resolved form — and because that call is one of the few
   * genuinely public ways to ask the runtime about a name at all.
   */
  aliasName?: string | null,
): HubResolution {
  if (!catalog.ok) return { status: "unreachable", reason: catalog.error };

  const entry = entryFor(catalog.models, [modelName, aliasName]);
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
  return { status: "available", modelName: entry.name, chipset, entry };
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

// ── The catalogue as state ────────────────────────────────────────────────
//
// On device, the hub answered with 19 models and Qwen3-4B-Instruct-2507 was not
// among them. That settles the -100010: the asset is not published, and no
// amount of client code will conjure it. It also says something about the
// shape of this feature — a hard-coded list of one downloadable model was
// always going to be wrong whenever Qualcomm's list changed, and it is wrong
// now. So the hub becomes the catalogue, and Vesta's own entry becomes a
// preference expressed against it rather than a promise made instead of it.

/** A catalogue as of one successful query. */
export interface HubSnapshot {
  models: HubModel[];
  /** Epoch ms of the query that produced these rows. */
  checkedAt: number;
  /**
   * True when these rows were restored from disk rather than fetched in this
   * session. Shown, because "the hub did not list it" is a claim with an age,
   * and a stale absence must never read as a permanent one.
   */
  cached: boolean;
}

export interface HubState {
  /**
   * The last SUCCESSFUL catalogue, or null if none has ever been obtained.
   * A failed refresh does not clear it — losing a good answer because a later
   * query timed out would be strictly worse than showing an older one.
   */
  snapshot: HubSnapshot | null;
  /** The most recent failure, kept BESIDE the snapshot rather than replacing it. */
  error: string | null;
  checking: boolean;
}

export const EMPTY_HUB: HubState = {
  snapshot: null,
  error: null,
  checking: false,
};

/**
 * A hub model this device can install.
 *
 * TWO chipset strings, and conflating them is the bug this shape exists to
 * prevent — they come from different places and mean different things:
 *
 *   hubChipsetKey  CATALOG METADATA. `HubModel.chipsets`, which is the release
 *                  manifest's `supported_chipsets` — AI Hub's asset key, e.g.
 *                  "qualcomm-snapdragon-8-elite-gen5". Good for display and for
 *                  deciding compatibility. NOT a pull parameter.
 *   canonicalSoc   The SoC IDENTIFIER, e.g. "SM8850". This is what
 *                  `ModelPullInput.chipset` takes — Qualcomm's Android API
 *                  documents it with exactly that example (SM8750 = Snapdragon
 *                  8 Elite, SM8850 = Snapdragon 8 Elite Gen 5) — and it is also
 *                  what the registry row records for the load-time guard.
 *
 * They are different fields on different beans (`HubModel.chipsets` vs
 * `ModelPullInput.chipset`) and the type system never claimed they matched. An
 * earlier revision passed the asset key to the pull on the assumption that
 * "the hub's own spelling" must be what the hub wants back; it is not, and the
 * result was an indistinguishable second round of -100010.
 */
export interface CompatibleHubModel {
  entry: HubModel;
  /** Catalog metadata: the release manifest's key. Display and matching only. */
  hubChipsetKey: string;
  /** The SoC identifier: what the pull takes, and what the row records. */
  canonicalSoc: string;
}

/** What the hub offers, split by whether Vesta can do anything with it. */
export interface HubBreakdown {
  /** Installable here: right chipset class, and a model type Vesta can run. */
  compatible: CompatibleHubModel[];
  /** Right type, wrong silicon. Counted, not listed — it is not actionable. */
  otherChipsets: number;
  /** Right silicon, a type this app has no runtime for (VLM). */
  unsupportedType: number;
}

// Vesta's NPU backend creates an LlmWrapper. A VLM bundle handed to it does not
// degrade, it fails — so model type is a compatibility fact here, in the same
// sense the chipset is, and not a judgement about the model.
const RUNNABLE_TYPES = new Set(["LLM"]);

/**
 * Splits the hub's catalogue against this device.
 *
 * Chipset compatibility goes through the runtime's own equivalence table, the
 * same canonical machinery the load-time guard uses — so a model is offered
 * only when Qualcomm's list and this phone agree on the silicon, and never
 * because two names looked similar.
 */
export function breakDownHubModels(
  models: HubModel[],
  deviceSoc: string | null,
  table: RuntimeChipset[] | undefined,
): HubBreakdown {
  const compatible: CompatibleHubModel[] = [];
  let otherChipsets = 0;
  let unsupportedType = 0;

  const device = canonicalChipset(deviceSoc, table);
  for (const entry of models) {
    const chipset = device ? hubChipsetFor(entry, deviceSoc, table) : null;
    if (!chipset) {
      otherChipsets += 1;
      continue;
    }
    if (!RUNNABLE_TYPES.has(entry.modelType.toUpperCase())) {
      unsupportedType += 1;
      continue;
    }
    compatible.push({
      entry,
      hubChipsetKey: chipset,
      // The SoC identifier for this class. It is what the pull is given and
      // what the row records — the latter because it is compared against
      // Build.SOC_MODEL on every later boot, long after this catalogue is gone.
      canonicalSoc: canonicalChipset(chipset, table)?.canonical ?? chipset,
    });
  }
  return { compatible, otherChipsets, unsupportedType };
}

/** Where a curated catalog entry stands against the last hub answer. */
export type HubAvailability =
  /** No successful query yet — nothing is known, and nothing is claimed. */
  | { status: "unchecked" }
  /**
   * Listed, for this silicon. `canonicalSoc` is the string to pull with —
   * `hubChipsetKey` is catalog metadata, see CompatibleHubModel.
   */
  | { status: "listed"; hubChipsetKey: string; canonicalSoc: string }
  /** The hub answered, and this model was not in it for this device. */
  | { status: "absent"; checkedAt: number; cached: boolean };

/**
 * Whether Vesta's own preferred model can be pulled right now.
 *
 * `absent` carries the timestamp on purpose. It is the difference between "not
 * published" and "was not published when we last looked", and only the second
 * is ever true — Qualcomm can publish at any time, so the UI that renders this
 * must always offer another look.
 */
export function hubAvailability(
  state: HubState,
  modelName: string,
  deviceSoc: string | null,
  table: RuntimeChipset[] | undefined,
  aliasName?: string | null,
): HubAvailability {
  const snapshot = state.snapshot;
  if (!snapshot) return { status: "unchecked" };

  const resolution = resolveAgainstHub(
    { ok: true, models: snapshot.models },
    modelName,
    deviceSoc,
    table,
    aliasName,
  );
  if (resolution.status === "available") {
    return {
      status: "listed",
      hubChipsetKey: resolution.chipset,
      canonicalSoc:
        canonicalChipset(resolution.chipset, table)?.canonical ?? resolution.chipset,
    };
  }
  return {
    status: "absent",
    checkedAt: snapshot.checkedAt,
    cached: snapshot.cached,
  };
}

/**
 * A display name for a hub model, from its `org/repo` identifier.
 *
 * The repo segment with separators relaxed, and nothing else. No prettifying
 * that could imply a claim the hub did not make — the full identifier stays
 * visible on the card beside it, because that is what gets pulled.
 */
export function hubModelLabel(name: string): string {
  const repo = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return repo.replace(/[_-]+/g, " ").trim() || name;
}

// ── Persistence ───────────────────────────────────────────────────────────
//
// A catalogue survives a restart so the Models screen has something to show
// before the network answers. It is never authoritative: every rendering of a
// cached snapshot says so and offers a refresh, and an absence read from cache
// is presented with its age rather than as a fact about today.

export function serializeSnapshot(snapshot: HubSnapshot): string {
  return JSON.stringify({ models: snapshot.models, checkedAt: snapshot.checkedAt });
}

/**
 * Reads a cached catalogue back. Returns null for anything it cannot fully
 * trust — a corrupt cache must degrade to "not checked yet", never to a
 * half-populated list that would be read as the hub's answer.
 */
export function parseSnapshot(raw: string | null): HubSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { models, checkedAt } = parsed as {
      models?: unknown;
      checkedAt?: unknown;
    };
    if (!Array.isArray(models) || typeof checkedAt !== "number") return null;

    const clean: HubModel[] = [];
    for (const m of models) {
      if (typeof m !== "object" || m === null) return null;
      const { name, modelType, chipsets } = m as Record<string, unknown>;
      if (typeof name !== "string" || typeof modelType !== "string") return null;
      if (!Array.isArray(chipsets) || chipsets.some((c) => typeof c !== "string")) {
        return null;
      }
      clean.push({ name, modelType, chipsets: chipsets as string[] });
    }
    return { models: clean, checkedAt, cached: true };
  } catch {
    return null;
  }
}
