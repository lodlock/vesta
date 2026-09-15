// The curated NPU catalog — bundles Vesta knows how to install.
//
// Deliberately SEPARATE from `catalog.ts`, and deliberately short. A GGUF entry
// is an invitation to browse: any repo, any quant, any device. An NPU entry is
// the opposite — one model, compiled ahead of time for one chipset family, at a
// precision fixed inside the artifact. There is nothing to choose and nothing
// to substitute, so the catalog states facts rather than offering options.
//
// Every string here was verified against primary sources, not recalled:
//   - the model name format `org/repo` and the `ai-hub-models/` namespace come
//     from the GenieX runtime's own validation message and from Qualcomm's
//     Android sample (`apps/geniex_chat_android/src/main/assets/model_list.json`),
//     which lists `ai-hub-models/Qwen3-4B-Instruct-2507` with runtime `qairt`.
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
  /** The name GenieX pulls by: "ai-hub-models/Qwen3-4B-Instruct-2507". */
  modelName: string;
  /** The chipset this entry is for. One entry per chipset, on purpose. */
  targetSoc: string;
  /** Marketing name, for the UI — never used for matching. */
  socName: string;
  /** "w4a16". Null lets GenieX pick the bundle's only precision. */
  precision: string | null;
  /** Which hub GenieX resolves it from. */
  hub: "AIHUB";
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
    modelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    targetSoc: "SM8850",
    socName: "Snapdragon 8 Elite Gen 5",
    precision: "w4a16",
    hub: "AIHUB",
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
