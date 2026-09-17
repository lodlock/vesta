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
import type { ModelBackendId } from "../models/types";

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
 * Whether a Qualcomm section should EXIST, and what it should say about itself.
 *
 * Four states, kept apart because collapsing them is what made the Diagnostics
 * screen misleading in both directions at once:
 *
 *   absent    no Qualcomm bridge in this build. Nothing to show, and nothing
 *             wrong.
 *   unprobed  the bridge is compiled in and the one-time native probe has not
 *             run. NOT a failure — the honest answer is "nobody has looked".
 *   failed    the probe ran and the runtime did not start. The SDK's own
 *             sentence says why, and this must never be dressed up as
 *             "available".
 *   ready     the runtime started.
 *
 * `available` alone answers false for three of these, which is why a screen
 * driven by it told a user with working silicon that they had none.
 */
export type NpuCapabilityState = "absent" | "unprobed" | "failed" | "ready";

export interface NpuCapability {
  /** The bridge is compiled into this build. */
  inBuild: boolean;
  /** The one-time native probe has finished, whatever it concluded. */
  probed: boolean;
  /** The runtime started. */
  available: boolean;
  /** The runtime's own words when it did not. */
  reason: string | null;
}

export function npuCapabilityState(cap: NpuCapability): NpuCapabilityState {
  if (!cap.inBuild) return "absent";
  if (cap.available) return "ready";
  return cap.probed ? "failed" : "unprobed";
}

/** The capability line, in words. */
export function describeNpuCapability(cap: NpuCapability): string {
  switch (npuCapabilityState(cap)) {
    case "absent":
      return "not in this build — models run on llama.cpp (CPU)";
    case "unprobed":
      return "compiled in, not probed yet";
    case "failed":
      // The runtime's own sentence, never a paraphrase and never an omission:
      // it is the only part of this that says what actually happened.
      return `probe failed — ${cap.reason ?? "the runtime did not start, and reported no reason"}`;
    case "ready":
      return "probed and running";
  }
}

/**
 * Whether the hub has ever been asked, and how that went.
 *
 * Deliberately independent of {@link npuCapabilityState}: a hub query is a
 * NETWORK act the user performs, and whether they have performed it says
 * nothing about whether this build has a Qualcomm runtime. Tying the two
 * together is what made unrelated sections appear only after a hub check.
 *
 *   never    no snapshot, no error. Nobody has asked.
 *   failed   asked, it did not work, and nothing was ever obtained.
 *   cached   a snapshot restored from disk; nothing asked this session.
 *   stale    a snapshot AND a later failure — the rows are real but old.
 *   checked  a snapshot obtained this session.
 */
export type HubCheckState = "never" | "failed" | "cached" | "stale" | "checked";

export function hubCheckState(hub: HubDiag): HubCheckState {
  if (hub.checkedAt === null) return hub.error ? "failed" : "never";
  if (hub.error) return "stale";
  return hub.cached ? "cached" : "checked";
}

/**
 * The hub's "last check" line.
 *
 * `at` formats the timestamp — ISO for the text report, a locale string on the
 * screen — so the two callers can differ there and nowhere else.
 */
export function describeHubCheck(
  hub: HubDiag,
  at: (ms: number) => string,
): string {
  switch (hubCheckState(hub)) {
    case "never":
      // Says what to do about it. The check lives on the Models screen, and a
      // bare "never" reads as a defect rather than as an action not taken.
      return "never — run Check Qualcomm Hub on the Models screen";
    case "failed":
      return `never completed — ${hub.error}`;
    case "cached":
      return `${at(hub.checkedAt as number)} (cached from an earlier session)`;
    case "stale":
      return `${at(hub.checkedAt as number)} — a later refresh failed: ${hub.error}`;
    case "checked":
      return at(hub.checkedAt as number);
  }
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
    `last check: ${describeHubCheck(hub, (ms) => new Date(ms).toISOString())}`,
    `models returned: ${hub.total}`,
    `compatible here: ${hub.compatible}`,
    `excluded — other chipsets: ${hub.otherChipsets}`,
    `excluded — unsupported model type: ${hub.unsupportedType}`,
    `filtering on: ${hub.canonicalSoc ?? "unknown chipset"}`,
    `pullability: ${hub.pullability ? describePullabilityCounts(hub.pullability) : "unknown (no manifest read yet)"}`,
    `active NPU model: ${hub.activeNpuModel ?? "none"}`,
  ];
  // No separate error line: every state that carries an error — failed, stale
  // — already says so on the "last check" line above, and printing the same
  // sentence twice made one failure look like two.
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

/** How each runtime is named on the device-state line. */
const RUNTIME_LABELS: Record<ModelBackendId, string> = {
  llama_cpp: "llama.cpp (CPU)",
  geniex_llama_cpp: "Qualcomm GenieX / llama.cpp",
  qualcomm_npu: "Qualcomm NPU (QAIRT)",
};

/**
 * The "loaded:" line — which runtime actually owns the session, and whether
 * that is the one the active row is registered for.
 *
 * "loaded: yes" on its own was the line that hid this bug for a whole session.
 * It is true of ANY live session, so a GenieX-registered model restored onto
 * llama.rn read as a working accelerated model; the only contradiction was a
 * token rate in a different section, several screens down. A claim about
 * loading now has to name the runtime making it, and a disagreement between
 * the live session and the row is stated as one rather than left to be
 * inferred.
 *
 * @param owner   the runtime holding the session, null when nothing is loaded
 * @param declared the runtime the active row is registered for, when it has one
 */
export function describeLoadedRuntime(
  owner: ModelBackendId | null,
  declared: ModelBackendId | null,
): string {
  if (!owner) return "no";
  const running = RUNTIME_LABELS[owner];
  if (!declared || declared === owner) return `yes — on ${running}`;
  return (
    `yes — on ${running}, but the active model is registered for ` +
    `${RUNTIME_LABELS[declared]} (BACKEND MISMATCH)`
  );
}
