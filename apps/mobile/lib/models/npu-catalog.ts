// The curated NPU catalog — bundles Vesta knows how to install.
//
// Deliberately SEPARATE from `catalog.ts`, and deliberately short. A GGUF entry
// is an invitation to browse: any repo, any quant, any device. An NPU entry is
// the opposite — one model, compiled ahead of time for one chipset family, at a
// precision fixed inside the artifact. There is nothing to choose and nothing
// to substitute, so the catalog states facts rather than offering options.
//
// Every string here was verified against primary sources, not recalled:
//   - the model name format `org/repo` comes from the GenieX runtime's own
//     validation message ("invalid model name: … must be 'org/repo'"). The org
//     segment comes from the DEVICE: listHubModels() returns
//     `qualcomm/Qwen3-4B-Instruct-2507`. Qualcomm's Android sample
//     (`apps/geniex_chat_android/.../model_list.json`) says `ai-hub-models/…`,
//     and trusting the sample over the runtime cost a false "not available".
//   - `SM8850` as the chipset string for Snapdragon 8 Elite Gen 5 comes from
//     the GenieX Android API reference, and is the same string Android's
//     `Build.SOC_MODEL` reports on this device. The GenieX RUNTIME, measured on
//     a OnePlus 15, does NOT use it as the display name — `listChipsets()` names
//     the chip by a device/marketing string and carries `SM8850` as an alias.
//     Which is exactly why matching goes through chipset-identity rather than
//     comparing these strings directly.
//   - `w4a16` (int4 weights, int16 activations) is the precision Qualcomm AI
//     Hub compiles its LLM bundles at. That an SM8850 asset at this precision
//     exists for THIS model is not an assumption either: qai-hub-models'
//     `models/qwen3_4b_instruct_2507/release-assets.yaml` lists a
//     `geniex_qairt` asset under
//     `precisions.w4a16.chipset_assets.qualcomm-snapdragon-8-elite-gen5`.
//
// Sizes are approximate and are REPLACED by the real measured total once the
// bundle is on disk (model-registry.finalizeBundle). Nothing downstream reads
// the approximation as fact.

import type { ModelArtifact, ModelRole } from "./types";
import {
  canonicalChipset,
  normalizeChipsetId,
  sameChipset,
  type RuntimeChipset,
} from "./chipset-identity";

export interface NpuCatalogModel {
  /** Stable catalog id, Vesta's own. */
  id: string;
  displayName: string;
  description: string;
  /**
   * How this model is identified in the HUB CATALOGUE — what
   * `listHubModels()` returns, and what the card is matched against.
   * On device that is `qualcomm/Qwen3-4B-Instruct-2507`.
   */
  modelName: string;
  /**
   * The identifier handed to `ModelPullInput.model_name`, when it differs
   * from the catalogue one.
   *
   * These are NOT known to be the same thing, and assuming they were is how
   * the last two attempts failed. Qualcomm's Android documentation pairs
   * `ai-hub-models/<repo>` with `HubSource.AUTO`, and states that AUTO routes
   * that prefix to AI Hub — so the routing identifier can differ from the
   * repository identifier the catalogue displays.
   *
   * Absent means "the catalogue identifier is also the pull identifier",
   * which is what every generic hub row still assumes.
   */
  pullModelName?: string;
  /** The chipset this entry is for. One entry per chipset, on purpose. */
  targetSoc: string;
  /** Marketing name, for the UI — never used for matching. */
  socName: string;
  /** "w4a16". Null lets GenieX pick the bundle's only precision. */
  precision: string | null;
  /**
   * Which hub GenieX resolves it from.
   *
   * AUTO lets the runtime route by model-name prefix rather than being told;
   * Qualcomm's own Android example uses it for `ai-hub-models/*`.
   */
  hub: "AIHUB" | "AUTO";
  artifact: ModelArtifact;
  sizeBytesApprox: number;
  /**
   * RAM this needs to be comfortable. A 4B w4a16 context bundle is far more
   * demanding than its download size suggests: the weights are resident and the
   * KV cache is preallocated at the context length baked into the bundle.
   */
  minRamMb: number;
  role: ModelRole;
  /**
   * The minimum runtime version this entry needs, compared by npu-compat
   * against what the QAIRT plugin reports for itself.
   *
   * Worth being precise about what that comparison actually is, because the
   * two numbers come from different places: this is the GenieX SDK version the
   * bridge was written against (0.4.0), while the device side is whatever
   * string `getPluginVersion("qairt")` hands back — which is the plugin's
   * version, not the SDK's, and is expected to be a QAIRT number (2.45-ish).
   * A QAIRT version therefore always compares as newer, so in practice this
   * gate does not fire today; and if either side is unparseable the check is
   * SKIPPED rather than failed, because a model that runs perfectly well is
   * not worth blocking on an opaque version string. The checks that actually
   * protect this path are the chipset match and the manifest's runtime_id.
   */
  runtimeVersion: string;
  license: string;
  licenseUrl?: string;
}

const APACHE = "https://www.apache.org/licenses/LICENSE-2.0";

export const NPU_CATALOG: NpuCatalogModel[] = [
  {
    id: "qwen3-4b-instruct-2507-npu-sm8850",
    displayName: "Qwen3 4B Instruct (2507)",
    description:
      "The same model as the GGUF entry, compiled ahead of time for this phone's Hexagon NPU. " +
      "Runs on the NPU only — it cannot fall back to the CPU, and it will not install on another chipset.",
    // Verified against the DEVICE, not against a sample: listHubModels() on a
    // OnePlus 15 returns this model as `qualcomm/Qwen3-4B-Instruct-2507`.
    // Qualcomm's Android sample model_list.json says `ai-hub-models/…`, which
    // is what this entry carried before — and which made the hub lookup miss,
    // so the card reported the model "not available" when it was listed all
    // along. The hub's own answer wins over a sample file.
    modelName: "qualcomm/Qwen3-4B-Instruct-2507",
    targetSoc: "SM8850",
    socName: "Snapdragon 8 Elite Gen 5",
    precision: "w4a16",
    // Qualcomm's documented Android combination, exactly: the
    // `ai-hub-models/` identifier with AUTO, which their docs say routes that
    // prefix to AI Hub. Deliberately NOT generalized to other hub rows — this
    // is one controlled test of a documented path for one known model, and
    // the generic installer still sends what the catalogue returned.
    hub: "AUTO",
    pullModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    artifact: "qairt_context",
    // Order of magnitude only — a 4B at int4 plus tokenizer and metadata. The
    // real figure is measured at install and is what the UI shows afterwards.
    sizeBytesApprox: 3_000_000_000,
    minRamMb: 12288,
    role: "primary",
    runtimeVersion: "0.4.0",
    license: "Apache-2.0",
    licenseUrl: APACHE,
  },
];

/**
 * The identifier to pull by, which is not always the one the catalogue lists.
 *
 * One function so the download, the duplicate check, the registry row and the
 * Models screen's "is this installed" lookup cannot disagree about which name
 * identifies a model. The MANAGER keys its cache by whatever `pullFlow` was
 * given — `getPaths()` is called with that same string — so this is also the
 * value that must land in `runtime_model_name`.
 */
export function pullIdentifier(
  model: Pick<NpuCatalogModel, "modelName" | "pullModelName">,
): string {
  return model.pullModelName ?? model.modelName;
}

export function getNpuCatalogModel(id: string): NpuCatalogModel | undefined {
  return NPU_CATALOG.find((m) => m.id === id);
}

/**
 * The catalog entries meant for THIS chipset.
 *
 * Returns nothing for an unknown chipset, which is the point: an NPU entry is
 * an offer to download several gigabytes that will only ever run on one kind of
 * phone, and offering it without knowing the phone is how a user ends up with
 * an unusable download.
 *
 * @param known The runtime's own chipset table, when it has been read. With it,
 *   a device that reports a marketing name and a bundle filed under an SoC
 *   number are recognised as the same chip; without it, the two ids must match
 *   outright — see chipset-identity.
 */
export function npuCatalogFor(
  soc: string | null,
  known?: RuntimeChipset[] | null,
): NpuCatalogModel[] {
  const device = canonicalChipset(soc, known);
  if (!device) return [];
  return NPU_CATALOG.filter((m) =>
    sameChipset(device, canonicalChipset(m.targetSoc, known)),
  );
}

/**
 * Canonical form of a chipset id, for comparison only.
 *
 * Kept here as the name the rest of the model layer already imports; the
 * implementation — and the rule about what is and is not normalized away —
 * lives in chipset-identity, so the id a bundle is FILED under and the id it is
 * MATCHED by can never drift apart.
 */
export const normalizeSocId = normalizeChipsetId;
