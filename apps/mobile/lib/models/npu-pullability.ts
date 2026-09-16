// Compatible is not the same as downloadable, and the hub says so.
//
// `listHubModels()` filters on two things — the supported runtime and the
// chipset — and on nothing else. In particular it never checks whether Qualcomm
// distributes a bundle at all. So the catalogue returns models this device
// could run, some of which cannot be downloaded by anyone, and Vesta offered
// Download for every one of them.
//
// On device that read as a fault: every Qwen entry started downloading, every
// Llama entry and Falcon3 returned `rc=-100000` instantly. The runtime's own
// words, in logcat and nowhere else:
//
//   hub error: No pre-compiled assets available for "Falcon3-7B-Instruct" due
//   to licensing restrictions. Please use the qai-hub-models Python package to
//   manually export the model.
//
// And the rule behind it, from `AiHubSource::plan()`:
//
//   let release_assets_url = &entry.manifest_urls.release_assets;
//   if release_assets_url.is_empty() {
//       return Err(Error::Hub("No pre-compiled assets available …"));
//   }
//
// That is the first thing a pull does. One empty string, checked before any
// network call — which means it is knowable before the button is drawn, and a
// pull for such a model should never be attempted.
//
// ## What this is NOT
//
// Not a license gate: there is no acceptance flow to offer, the asset simply is
// not published. Not a name rule: "every Llama failed" is an observation, not a
// classifier, and Qualcomm can publish a Llama bundle tomorrow. Not
// `supported_runtimes`: a model can advertise the QAIRT runtime and still ship
// nothing, which is exactly the Falcon3 case. The field is
// `manifest_urls.release_assets`, and only that field.
//
// ## Unknown is a real answer
//
// The manifest arrives with the first hub query and is cached under our own
// data directory. Before that there is nothing to read, and a model whose
// status we have not established must keep behaving as it does today — offered,
// and allowed to fail with the runtime's own message. Guessing "not
// distributed" from an absent manifest would hide a model that works.

/** One manifest entry, reduced to the identity and the one field that decides. */
export interface PullabilityEntry {
  /** The manifest's `id`, e.g. "falcon3_7b_instruct". */
  id: string;
  /** The manifest's `display_name`, e.g. "Falcon3-7B-Instruct". */
  displayName: string;
  /** Whether `manifest_urls.release_assets` is a non-empty string. */
  hasReleaseAssets: boolean;
}

/** What the native side read out of the cached manifest. */
export interface PullabilityReport {
  manifestExists?: boolean;
  models?: PullabilityEntry[];
  modelCount?: number;
  error?: string | null;
}

export type Pullability =
  /** The hub publishes a bundle. Download is real. */
  | "downloadable"
  /** Compatible, but nothing is distributed. Export it yourself and import. */
  | "manual-export"
  /** No manifest read yet. Behave as before rather than claim either. */
  | "unknown";

/**
 * An index from the report, ready to answer about a hub model name.
 *
 * Null when the report says nothing usable — an absent manifest, a parse
 * failure, an empty list. A caller holding null gets "unknown" for everything,
 * which is the honest state before the first hub query.
 */
export function pullabilityIndex(
  report: PullabilityReport | null | undefined,
): Map<string, boolean> | null {
  const models = report?.models;
  if (!models || models.length === 0) return null;

  const index = new Map<string, boolean>();
  for (const entry of models) {
    // Both keys, lower-cased. `listHubModels()` builds its names as
    // `qualcomm/<display_name>`, but the manifest is also keyed by `id`, and a
    // caller should not have to know which one it is holding.
    if (entry.displayName) index.set(entry.displayName.toLowerCase(), entry.hasReleaseAssets);
    if (entry.id) index.set(entry.id.toLowerCase(), entry.hasReleaseAssets);
  }
  return index;
}

/**
 * Whether the hub will actually hand over this model.
 *
 * @param modelName the hub's own identifier, `qualcomm/<display_name>` or a
 *   bare name. Only the part after the last `/` is matched, because the org
 *   prefix is the hub's and the manifest's key is not.
 */
export function pullabilityOf(
  modelName: string,
  index: Map<string, boolean> | null,
): Pullability {
  if (!index) return "unknown";
  const repo = modelName.slice(modelName.lastIndexOf("/") + 1).trim().toLowerCase();
  if (!repo) return "unknown";

  const direct = index.get(repo);
  if (direct !== undefined) return direct ? "downloadable" : "manual-export";

  // The manifest's `id` is the display name lower-cased with `-` for `_`, which
  // is a convention rather than a guarantee — so it is tried second, and a miss
  // is still "unknown" rather than a guess.
  const asId = index.get(repo.replace(/-/g, "_"));
  if (asId !== undefined) return asId ? "downloadable" : "manual-export";

  // In the manifest's model list but under neither spelling we know: say so.
  return "unknown";
}

/** How the three states divide a set of compatible models. */
export interface PullabilityCounts {
  compatible: number;
  downloadable: number;
  manualExport: number;
  unknown: number;
}

/**
 * The counts the Models screen shows.
 *
 * "14 compatible" on its own was a claim the screen could not support: four of
 * those fourteen could not be downloaded by anybody. Unknown is counted
 * separately and never folded into either of the other two — a number that
 * quietly includes guesses is worse than one that admits what it does not know.
 */
export function countPullability(
  modelNames: string[],
  index: Map<string, boolean> | null,
): PullabilityCounts {
  const counts: PullabilityCounts = {
    compatible: modelNames.length,
    downloadable: 0,
    manualExport: 0,
    unknown: 0,
  };
  for (const name of modelNames) {
    const state = pullabilityOf(name, index);
    if (state === "downloadable") counts.downloadable += 1;
    else if (state === "manual-export") counts.manualExport += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/** The counts as one line, omitting what there is nothing to say about. */
export function describePullabilityCounts(counts: PullabilityCounts): string {
  const parts = [`${counts.compatible} compatible`];
  if (counts.downloadable > 0) parts.push(`${counts.downloadable} directly downloadable`);
  if (counts.manualExport > 0) parts.push(`${counts.manualExport} require manual export`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} not yet known`);
  return parts.join(" · ");
}

/** What the card says instead of Download, and why. */
export const MANUAL_EXPORT_LABEL = "Requires manual export";

export const MANUAL_EXPORT_EXPLANATION =
  "Qualcomm publishes no pre-compiled bundle for this model, so it cannot be " +
  "downloaded here. Export it yourself with the qai-hub-models Python package " +
  "and add it with Import bundle.";
