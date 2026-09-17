// Which form of each section goes into which report.
//
// This file exists because getting that wrong is not a formatting mistake, it
// is the bug. The compact form of a section has to stay compact when the device
// is FULL — after a hub probe, with a 2.4 GB bundle on disk and a manifest
// cached — and the only way a section stays compact under those conditions is
// if its summary is an aggregate rather than a shortened inventory.
//
// It was wrong here, twice:
//
//   1. `installed` declared no `full` form at all, which means "the same in
//      both". Its one form ends with a listing of every file in the bundle —
//      every weights shard, every tokenizer — so after a pull the clipboard
//      summary carried the bundle's directory listing.
//   2. `hub cache` did declare both, but the formatter's own "summary" mode
//      still printed a block per file, each with a `topLevelKeys` line. On a
//      `vocab.json` that line is one entry per token. Before a probe the data
//      directory is empty and none of this shows; after one it is most of the
//      report.
//
// Both were invisible until a real device with a real bundle produced a
// summary that hit the 64 KiB guard and came back cut.
//
// So the pairing lives in one place, out of the screen, where a test can feed
// it a populated device and measure what comes out. See
// __tests__/post-probe-summary.test.ts — that is the regression, and it is the
// reason this module is not just inlined back into diagnostics.tsx.

import {
  formatCacheReport,
  formatGenieXLog,
  formatInstalledReport,
  formatListProbe,
  type CacheReportLike,
  type GenieXLogLike,
  type InstalledReportLike,
  type ListProbeLike,
} from "../models/npu-hub-probe";
import {
  describePullabilityCounts,
  type PullabilityCounts,
} from "../models/npu-pullability";
import type { DiagnosticsSection } from "./report";

/**
 * What is worth knowing about the hub without reprinting it.
 *
 * Counts and a timestamp, not a model list: the list belongs on the Models
 * screen, and these values are what EXPLAIN it — in particular why a catalogue
 * of many models can show as none here.
 */
export interface HubDiag {
  checkedAt: number | null;
  cached: boolean;
  total: number;
  compatible: number;
  /** Right model type, wrong silicon. Counted because it explains an empty list. */
  otherChipsets: number;
  /** Right silicon, a type this app has no runtime for. Same reason. */
  unsupportedType: number;
  /**
   * How the compatible models divide into downloadable / manual-export /
   * unknown. Null before any manifest has been read — which is "unknown",
   * not "none".
   */
  pullability: PullabilityCounts | null;
  canonicalSoc: string | null;
  error: string | null;
  activeNpuModel: string | null;
}

/**
 * What the hub said, as counts.
 *
 * The models themselves live on the Models screen and in the listing section;
 * what belongs here is the arithmetic that explains an empty list — how many
 * the hub returned, how many survive the chipset filter, how many survive the
 * model-type filter, and how many of the survivors Qualcomm actually
 * distributes a bundle for.
 *
 * Fixed size: nine lines whatever the catalogue holds. It is the same in both
 * reports for exactly that reason.
 */
export function formatHubState(hub: HubDiag | null): string {
  if (!hub) return "";
  const lines = [
    "Qualcomm Hub state",
    `last check: ${hub.checkedAt === null ? "never" : new Date(hub.checkedAt).toISOString()}${hub.cached ? " (cached)" : ""}`,
    `models returned: ${hub.total}`,
    `compatible here: ${hub.compatible}`,
    `excluded — other chipsets: ${hub.otherChipsets}`,
    `excluded — unsupported model type: ${hub.unsupportedType}`,
    `filtering on: ${hub.canonicalSoc ?? "unknown chipset"}`,
    `pullability: ${hub.pullability ? describePullabilityCounts(hub.pullability) : "unknown (no manifest read yet)"}`,
    `active NPU model: ${hub.activeNpuModel ?? "none"}`,
  ];
  if (hub.error) lines.push(`last hub error: ${hub.error}`);
  return lines.join("\n");
}

/** Everything one run of the hub probe produced, before it is shaped. */
export interface ProbeSectionInput {
  /** The model the report is asking about — the needle for every match. */
  repo: string;
  /** Already text: bounded by construction, one block per pull attempt. */
  pullTrace: string;
  /** Already text: one line per candidate spelling. */
  identityProbe: string;
  /** Already text: fixed size, read off state the app already held. */
  chipsetIdentity: string;
  cache: CacheReportLike | null;
  listProbe: ListProbeLike | null;
  installed: InstalledReportLike | null;
  genieXLog: GenieXLogLike | null;
}

const NO_BRIDGE = "Hub cache report\nunavailable (no NPU bridge in this build)";

/**
 * The probe's sections, each with the right form for each report.
 *
 * Ordered most-wanted first, because that is the order the clipboard-safe
 * assembler drops things in when it has to drop anything.
 *
 * The rule, and it is the whole point of this function: a section whose content
 * grows with what the DEVICE holds — the cache walk, the bundle listing, the
 * log buffer — must declare a separate `summary` that is an aggregate. A
 * section that is a fixed number of lines may declare one form and be the same
 * in both. Every entry below is one or the other, deliberately, and the comment
 * on each says which and why.
 */
export function probeSections(input: ProbeSectionInput): DiagnosticsSection[] {
  const { repo, cache, listProbe, installed, genieXLog } = input;
  return [
    // Fixed size: one block per pull attempt this session, and there are at
    // most a handful. Same in both.
    { name: "pull trace", summary: input.pullTrace, essential: true },
    // Fixed size: one entry per candidate spelling, four of them.
    { name: "identity probe", summary: input.identityProbe, essential: true },
    // Fixed size: the SoC, the runtime's names for it, the hub's keys.
    { name: "chipset identity", summary: input.chipsetIdentity, essential: true },
    // GROWS: one block per file in the geniex data directory, and after a pull
    // that is the whole bundle. The summary form counts the inventory and
    // prints only files carrying a manifest finding.
    {
      name: "hub cache",
      summary: cache ? formatCacheReport(cache, repo, "summary") : NO_BRIDGE,
      full: cache ? formatCacheReport(cache, repo, "full") : NO_BRIDGE,
      essential: true,
    },
    // Bounded: only entries matching the needle are printed verbatim, the rest
    // are a count. Same in both.
    {
      name: "hub listing",
      summary: listProbe ? formatListProbe(listProbe, repo) : "",
    },
    // GROWS: the full form ends with every file in the bundle. This is the one
    // that declared a single form and so put a 2.4 GB model's directory listing
    // on the clipboard.
    {
      name: "installed",
      summary: installed ? formatInstalledReport(installed, "summary") : "",
      full: installed ? formatInstalledReport(installed, "full") : "",
    },
    // GROWS: the capture is up to 400 threadtime lines.
    {
      name: "native log",
      summary: genieXLog ? formatGenieXLog(genieXLog, "summary") : "",
      full: genieXLog ? formatGenieXLog(genieXLog, "full") : "",
    },
  ];
}
