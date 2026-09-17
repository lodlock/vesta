// Which spelling of a model name does the runtime actually recognise?
//
// Three -100010s in, each from a different wrong string, the useful question is
// no longer "what should we send" but "what does the SDK say about each of the
// things we could send". `ModelManagerWrapper.resolveAlias()` is the only
// public call that answers it, so this asks it once per candidate and reports
// all the answers side by side.
//
// DIAGNOSTIC ONLY. Nothing here feeds the install path, nothing here changes
// what is pulled, and nothing here matches fuzzily — the candidates are
// enumerated, asked about individually, and reported verbatim. Choosing
// between them is a decision for a human holding the results.

import { canonicalChipset, type RuntimeChipset } from "./chipset-identity";
import { hubChipsetFor, type HubModel } from "./npu-hub";

/** One spelling, and what the runtime made of it. */
export interface HubIdentityRow {
  /** Where this candidate came from, so a result can be attributed. */
  source: string;
  /** The exact string handed to resolveAlias(). */
  candidate: string;
  /**
   * What resolveAlias() returned. Null means the call returned nothing —
   * which is itself an answer, and a different one from "the same string
   * back".
   */
  resolved: string | null;
}

export interface HubIdentityProbe {
  rows: HubIdentityRow[];
  /** The name the install path would actually pull by, as things stand. */
  pullName: string;
  /** The hub enum it would use. */
  hub: string;
}

/**
 * The spellings worth asking about, derived from one identifier.
 *
 * Derivation, not guessing: each form is a documented or observed convention,
 * and the point is to have the RUNTIME adjudicate between them rather than to
 * pick one here.
 *
 *   as-is           what the hub returned / what the catalog carries
 *   ai-hub-models/  the org Qualcomm's Android sample uses
 *   qualcomm/       the org listHubModels() returns on device
 *   bare repo       in case the manifest is keyed by `id` without its domain
 *   snake_case      the shape of the QAIRT plugin's own model-family ids
 *                   (the binary carries qwen3, qwen3_vl, qwen2_5), in case the
 *                   registry is consulted by that name
 */
export function identityCandidates(
  modelName: string,
  hubName: string | null,
): { source: string; candidate: string }[] {
  const repo = modelName.includes("/")
    ? modelName.slice(modelName.lastIndexOf("/") + 1)
    : modelName;

  const out: { source: string; candidate: string }[] = [
    { source: "catalog entry", candidate: modelName },
  ];
  if (hubName && hubName !== modelName) {
    out.push({ source: "listHubModels()", candidate: hubName });
  }
  out.push(
    { source: "sample org", candidate: `ai-hub-models/${repo}` },
    { source: "device org", candidate: `qualcomm/${repo}` },
    { source: "bare repo id", candidate: repo },
    { source: "registry style", candidate: repo.toLowerCase().replace(/-/g, "_") },
  );

  // Two candidates can coincide (the catalog entry may already be the device
  // org). Ask once per distinct string; the sources are merged in the label.
  const seen = new Map<string, string[]>();
  for (const { source, candidate } of out) {
    const sources = seen.get(candidate);
    if (sources) sources.push(source);
    else seen.set(candidate, [source]);
  }
  return [...seen].map(([candidate, sources]) => ({
    candidate,
    source: sources.join(" / "),
  }));
}

/**
 * Asks the runtime about every candidate.
 *
 * The resolver is injected so this is testable without a device and without a
 * Qualcomm runtime — the logic worth testing is the candidate set and the
 * reporting, not the bridge call.
 */
export async function probeHubIdentity(
  modelName: string,
  hubName: string | null,
  resolveAlias: (name: string) => Promise<string | null>,
  pullName: string,
  hub: string,
): Promise<HubIdentityProbe> {
  const candidates = identityCandidates(modelName, hubName);
  const rows: HubIdentityRow[] = [];
  for (const { source, candidate } of candidates) {
    let resolved: string | null = null;
    try {
      resolved = await resolveAlias(candidate);
    } catch {
      // A throwing resolver is reported as "no answer" rather than taking the
      // probe down — the other rows are still worth having.
      resolved = null;
    }
    rows.push({ source, candidate, resolved });
  }
  return { rows, pullName, hub };
}

/**
 * The probe as plain text: the clipboard payload, and the logcat payload.
 *
 * Deliberately NOT a two-column table. The first rendering of this aligned
 * candidate and result in columns, and the screen truncated exactly the part
 * that mattered — `qualcomm/Qwen3-4B-Instruct-2507` and
 * `ai-hub-models/Qwen3-4B-Instruct-2507` differ only in a prefix that fell off
 * the right edge. So every value gets its own line, under its own label, at
 * full length.
 *
 * The four things this has to keep distinguishable, because conflating any two
 * of them is how the last three attempts went wrong:
 *
 *   Pull model name   what the install path would actually send
 *   HubSource         which hub it would send it to
 *   Candidate         the string handed to resolveAlias()
 *   resolveAlias      what came back — `<null>` when nothing did, which is a
 *                     different answer from the string echoing back unchanged
 */
export function formatProbe(probe: HubIdentityProbe): string {
  const lines = [
    "Hub identity probe",
    `Pull model name: ${probe.pullName}`,
    `HubSource: ${probe.hub}`,
  ];
  for (const row of probe.rows) {
    lines.push(
      "",
      "Candidate:",
      row.candidate,
      "resolveAlias:",
      row.resolved ?? "<null>",
      `source: ${row.source}`,
    );
  }
  return lines.join("\n");
}

// ── The cache the runtime actually read ───────────────────────────────────

/** Minimal shape of the native cache report, so this module stays testable. */
export interface CacheReportLike {
  env?: Record<string, string | null>;
  dataDir?: string;
  dataDirExists?: boolean;
  files?: CacheFileLike[];
  error?: string | null;
}

/**
 * One file the native side walked in the geniex data directory.
 *
 * `analysis` is present when it parsed as a manifest candidate; `content` when
 * it is small enough JSON to have been read whole. A file with neither — a
 * weights shard, a `.lock` — is inventory, and after a pull the directory is
 * mostly inventory. See `hasFinding`.
 */
export interface CacheFileLike {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  content?: string | null;
  analysis?: ManifestAnalysis;
}

/** What the native side found in one cached manifest. */
export interface ManifestAnalysis {
  parseError?: string | null;
  topLevelKeys?: string[];
  versionFields?: Record<string, string | null>;
  modelsKey?: string | null;
  modelCount?: number;
  exactDisplayName?: boolean;
  exactId?: boolean;
  /** Whole entries. Tens of kilobytes; logcat only. */
  matches?: string[];
  /**
   * The same entries reduced to the fields a pull's manifest inference reads:
   * id, display_name, domain, supported_runtimes, supported_chipsets.
   *
   * `ManifestModelEntry` is the struct in libgeniex.so and those are its
   * fields; the runtime enum beside it has exactly two values,
   * `RUNTIME_GENIEX_QAIRT` and `RUNTIME_GENIE`. This SDK consumes the first
   * only. So an entry the hub lists for this chipset that offers only
   * RUNTIME_GENIE has no asset this app can pull — and the inference that
   * fails over it returns GENIEX_ERROR_COMMON_UNKNOWN (-100000), which names
   * nothing. This line is what turns that number into a finding.
   */
  matchSummaries?: string[];
}

/**
 * Whether a cached manifest mentions a model, and under which key.
 *
 * Substring search on purpose: this is a REPORT, not a matcher. Nothing
 * downstream branches on it — it exists so a human can see at a glance whether
 * the release the runtime cached even contains the model that listHubModels()
 * claims to offer, without scrolling a 100 KB JSON blob on a phone.
 */
export function mentionsModel(content: string, repo: string): string[] {
  const hits: string[] = [];
  const lower = content.toLowerCase();
  for (const form of [
    repo,
    repo.toLowerCase(),
    repo.toLowerCase().replace(/-/g, "_"),
  ]) {
    if (lower.includes(form.toLowerCase())) hits.push(form);
  }
  return [...new Set(hits)];
}

/**
 * The cache report as plain text, for the clipboard and for logcat.
 *
 * Same rule as the identity probe: full values, one per line, never a column
 * that can be truncated. JSON bodies are included whole — they are the
 * evidence, and an abbreviated manifest answers nothing.
 */
/**
 * How much of the cache to render.
 *
 * "full" is the complete inventory: every file the native side walked, its raw
 * manifest entries and the whole content of small JSON files. It goes to the
 * shared .txt and to logcat, where size is not a constraint.
 *
 * "summary" is what goes to the clipboard, and it is an AGGREGATE rather than a
 * shortened inventory. This distinction has now been got wrong twice, in two
 * different ways, and both times on the same rock:
 *
 *   1. The first version put the raw JSON bodies in. The report reached 3.38 MB
 *      and `Clipboard.setString` — a Binder call — took the process down with
 *      TransactionTooLargeException.
 *   2. The second version dropped the bodies but KEPT a per-file block for
 *      every file. That reads fine before a hub probe, when the data directory
 *      is empty. After one, the directory holds the manifests plus every shard
 *      and tokenizer of a downloaded bundle, and each block carried a
 *      `topLevelKeys` line — which on a vocabulary file is every token in the
 *      vocabulary. The summary ballooned past the 64 KiB guard and came back
 *      cut, which is the guard doing its job over a report that should never
 *      have been that size.
 *
 * So the rule is no longer "the same shape, smaller". A summary states the
 * FINDINGS and counts everything else:
 *
 *   - files that answer the question this report exists for — a manifest with
 *     models in it, an exact match, a parse failure, a body that mentions the
 *     model — get a block, at most SUMMARY_FILE_BLOCKS of them
 *   - every other file is counted, never listed. A bundle's shards and
 *     tokenizers are not evidence about whether the hub publishes a model
 *   - inside a block, anything unbounded is counted and sampled:
 *     `topLevelKeys` and `matchSummaries` both grow with data we do not control
 *
 * The result is a size that is a function of the FIELDS rather than of what the
 * device has downloaded, which is the property that makes "Copy summary never
 * truncates" true by construction instead of by luck.
 */
export type CacheDetail = "summary" | "full";

/** Blocks a summary will print before it starts counting instead. */
const SUMMARY_FILE_BLOCKS = 6;
/** Top-level keys sampled per file. A vocabulary file has hundreds of thousands. */
const SUMMARY_KEYS_SHOWN = 8;
/** Matching manifest entries summarised per file. */
const SUMMARY_MATCHES_SHOWN = 6;

/**
 * Whether a file answers the question the cache report exists for.
 *
 * Deliberately generous about what counts — a parse failure and an empty models
 * key are both findings — and deliberately silent about everything else. A
 * `weights_1.bin` has no analysis and no content; it is inventory, and
 * inventory belongs in the full report.
 */
function hasFinding(file: CacheFileLike, repo: string): boolean {
  const a = file.analysis;
  if (a) {
    return (
      Boolean(a.parseError) ||
      Boolean(a.exactDisplayName) ||
      Boolean(a.exactId) ||
      (a.matches?.length ?? 0) > 0 ||
      (a.matchSummaries?.length ?? 0) > 0 ||
      Boolean(a.modelsKey) ||
      (a.modelCount ?? 0) > 0 ||
      Object.keys(a.versionFields ?? {}).length > 0
    );
  }
  if (file.content) return mentionsModel(file.content, repo).length > 0;
  return false;
}

/**
 * The files a summary prints a block for.
 *
 * Findings first. When nothing has a finding, the examined files themselves are
 * the answer — "the manifest is here and mentions nothing" is a result, and a
 * report that printed only a count would be hiding it.
 */
function summaryBlocks(files: CacheFileLike[], repo: string): CacheFileLike[] {
  const found = files.filter((f) => hasFinding(f, repo));
  const examined = files.filter((f) => f.analysis || f.content);
  return (found.length > 0 ? found : examined).slice(0, SUMMARY_FILE_BLOCKS);
}

export function formatCacheReport(
  report: CacheReportLike,
  repo: string,
  detail: CacheDetail = "summary",
): string {
  const lines = ["Hub cache report"];
  if (report.error) lines.push(`error: ${report.error}`);

  const env = report.env ?? {};
  lines.push("", "Environment (unset = the SDK's built-in default applies):");
  for (const key of [
    "GENIEX_AIHUBBASEURL",
    "GENIEX_AIHUBVERSION",
    "GENIEX_DATADIR",
    "GENIEX_HFTOKEN",
  ]) {
    lines.push(`${key}: ${env[key] ?? "<unset>"}`);
  }

  const all = report.files ?? [];
  const totalBytes = all.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
  lines.push(
    "",
    `dataDir: ${report.dataDir ?? "<none>"}`,
    `dataDirExists: ${report.dataDirExists ?? false}`,
    `files: ${all.length}`,
  );

  // A summary never walks the directory. After a pull it is mostly bundle —
  // shards, tokenizers, a lock — and listing that is how this report grew past
  // the clipboard guard. The aggregate says the same thing in two lines.
  const printed = detail === "full" ? all : summaryBlocks(all, repo);
  if (detail === "summary") {
    lines.push(
      `total bytes: ${totalBytes}`,
      `listed below: ${printed.length} of ${all.length}` +
        (all.length > printed.length
          ? " (the rest are bundle files and carry no manifest finding — see the full report)"
          : ""),
    );
  }

  for (const file of printed) {
    lines.push(
      "",
      `path: ${file.path}`,
      `sizeBytes: ${file.sizeBytes}`,
      `modified: ${new Date(file.modifiedAt).toISOString()}`,
    );
    const a = file.analysis;
    if (a) {
      if (a.parseError) lines.push(`parseError: ${a.parseError}`);
      lines.push(
        `topLevelKeys: ${describeKeys(a.topLevelKeys ?? [], detail)}`,
        `modelsKey: ${a.modelsKey ?? "<none>"}`,
        `modelCount: ${a.modelCount ?? 0}`,
      );
      const versions = Object.entries(a.versionFields ?? {});
      for (const [key, value] of versions) lines.push(`${key}: ${value}`);

      // The three answers this report exists for.
      lines.push(
        `exact display_name match: ${a.exactDisplayName ? "YES" : "NO"}`,
        `exact id match: ${a.exactId ? "YES" : "NO"}`,
        `entries matching needle: ${a.matches?.length ?? 0}`,
      );
      // Kept in BOTH forms: a few hundred bytes each, and the line that says
      // whether an entry carries a geniex_qairt asset for this chipset at all.
      // Sampled in a summary, because the count is not ours to bound.
      const summaries = a.matchSummaries ?? [];
      const shown =
        detail === "full" ? summaries : summaries.slice(0, SUMMARY_MATCHES_SHOWN);
      for (const summary of shown) lines.push(`  ${summary}`);
      if (shown.length < summaries.length) {
        lines.push(`  (${summaries.length - shown.length} more — see the full report)`);
      }
      if (detail === "full") {
        for (const match of a.matches ?? []) lines.push(match);
      } else if ((a.matches?.length ?? 0) > 0) {
        // The raw entries run to tens of kilobytes and belong in logcat.
        lines.push("(raw entries omitted — see logcat, VestaNpu tag)");
      }
    } else if (file.content) {
      // Whether the file mentions the model is the finding; the file is not.
      const hits = mentionsModel(file.content, repo);
      lines.push(`mentions ${repo}: ${hits.length > 0 ? hits.join(", ") : "NO"}`);
      if (detail === "full") {
        lines.push("content:", file.content);
      } else {
        lines.push(`(content omitted, ${file.content.length} chars — see logcat)`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Top-level keys, counted in a summary and listed in full.
 *
 * This one line is what made the post-probe summary unsendable. A manifest has
 * a handful of top-level keys; a `vocab.json` beside the weights has one per
 * token, and the geniex directory holds several of them. The count is the fact
 * — "did this parse and what shape is it" — and a sample is enough to
 * recognise the shape.
 */
function describeKeys(keys: string[], detail: CacheDetail): string {
  if (keys.length === 0) return "<none>";
  if (detail === "full") return keys.join(", ");
  if (keys.length <= SUMMARY_KEYS_SHOWN) return keys.join(", ");
  return (
    `${keys.length} keys: ${keys.slice(0, SUMMARY_KEYS_SHOWN).join(", ")}, ` +
    `… (${keys.length - SUMMARY_KEYS_SHOWN} more — see the full report)`
  );
}

/** Minimal shape of a hub-list probe, so this module stays testable. */
export interface ListProbeLike {
  /** The chipset the listing was filtered by; absent means it was not. */
  chipset?: string | null;
  before?: { exists: boolean; sizeBytes: number; modifiedAt: number };
  after?: { exists: boolean; sizeBytes: number; modifiedAt: number };
  count?: number;
  models?: { name: string; modelType: string; chipsets: string[] }[];
  error?: string | null;
}

/**
 * One listHubModels() call, reported against the manifest it may have touched.
 *
 * Only entries matching the needle are printed verbatim — the count covers the
 * rest. The question is whether the listing returns a model the cached
 * manifest does not contain, and 19 unrelated rows do not help answer it.
 */
export function formatListProbe(
  probe: ListProbeLike,
  needle: string,
): string {
  // Spelled out rather than printed as "null". The report that said
  // `listHubModels(null)` sat in the same capture as the runtime's
  // `chipset "null" not found in platform.json`, and reading the two together
  // suggested a bug in the argument when the argument was correct — absent IS
  // the SDK's declared default and its unfiltered query. The label now says
  // which of the two things happened.
  const lines = [
    probe.chipset
      ? `listHubModels(chipset: ${probe.chipset})`
      : "listHubModels() — no chipset, every model the hub has",
  ];
  if (probe.error) lines.push(`error: ${probe.error}`);
  lines.push(`count: ${probe.count ?? 0}`);

  const stat = (
    label: string,
    v?: { exists: boolean; sizeBytes: number; modifiedAt: number },
  ) =>
    lines.push(
      `${label}: ${
        v?.exists
          ? `${v.sizeBytes} bytes, ${new Date(v.modifiedAt).toISOString()}`
          : "<absent>"
      }`,
    );
  stat("manifest before", probe.before);
  stat("manifest after", probe.after);
  // The tell: if the listing rewrote the file the pull then reads, these
  // differ, and the two are not looking at the same bytes.
  const changed =
    probe.before?.modifiedAt !== probe.after?.modifiedAt ||
    probe.before?.sizeBytes !== probe.after?.sizeBytes;
  lines.push(`manifest changed by this call: ${changed ? "YES" : "no"}`);

  const hits = (probe.models ?? []).filter((m) =>
    m.name.toLowerCase().includes(needle.toLowerCase()),
  );
  lines.push(`entries matching "${needle}": ${hits.length}`);
  for (const m of hits) {
    lines.push(
      "",
      `name: ${m.name}`,
      `modelType: ${m.modelType}`,
      `chipsets: ${m.chipsets.join(", ")}`,
    );
  }
  return lines.join("\n");
}

// ── What the SDK says about itself ────────────────────────────────────────

/** Minimal shape of the native GenieX log capture, so this module stays testable. */
export interface GenieXLogLike {
  tag?: string;
  command?: string;
  sdkStarted?: boolean;
  initError?: string | null;
  lines?: string[];
  lineCount?: number;
  totalLines?: number;
  truncated?: boolean;
  byPriority?: { V: number; D: number; I: number; W: number; E: number };
  sawStdoutSelfTest?: boolean;
  sawStderrSelfTest?: boolean;
  verboseSeen?: boolean;
  error?: string | null;
}

/**
 * GenieX's own logging, as it actually arrived — with the header a reader
 * needs to interpret an empty capture.
 *
 * The header exists because "no lines" has three quite different meanings and
 * only the surrounding facts separate them: the SDK never started (sdkStarted
 * false, with the reason), the SDK started and said nothing, or the ring
 * buffer has already rolled past everything it said. `verboseSeen` is the one
 * that answers the question people actually ask first — whether anything is
 * being filtered out. A VERBOSE line is a GenieX TRACE line that passed the
 * level gate, so seeing one proves on-device that the gate is fully open, and
 * that there is no verbosity setting left to look for.
 */
/**
 * Newest lines kept in a summary. The rest is in logcat by definition.
 *
 * Was 60. A threadtime line runs 100-200 characters, so 60 of them is 6-12 KB —
 * most of a clipboard summary's whole budget, spent on the tail of a log that
 * is in the shared report AND in logcat AND is rarely what the summary is being
 * pasted for. 20 still carries the failure and its immediate approach.
 */
const SUMMARY_LOG_LINES = 20;
/** A single line long enough to matter is a dump in disguise. */
const SUMMARY_LOG_LINE_CHARS = 240;

export function formatGenieXLog(
  report: GenieXLogLike,
  detail: CacheDetail = "summary",
): string {
  const lines = ["GenieX native log"];
  if (report.error) lines.push(`error: ${report.error}`);
  lines.push(
    `tag: ${report.tag ?? "<unknown>"}`,
    `command: ${report.command ?? "<none>"}`,
    `SDK started: ${report.sdkStarted ? "yes" : "NO"}`,
  );
  if (report.initError) lines.push(`init error: ${report.initError}`);

  const p = report.byPriority;
  lines.push(
    `lines: ${report.lineCount ?? 0}${
      report.truncated
        ? ` of ${report.totalLines ?? "?"} (newest kept, older dropped)`
        : ""
    }`,
    p
      ? `by priority: V=${p.V} D=${p.D} I=${p.I} W=${p.W} E=${p.E}`
      : "by priority: <not reported>",
    // TRACE reaching logcat at all is the proof that geniex_log_level is 0.
    `TRACE reaching logcat: ${report.verboseSeen ? "YES" : "no VERBOSE line in this capture"}`,
    `stdout redirect self-test seen: ${report.sawStdoutSelfTest ? "YES" : "no"}`,
    `stderr redirect self-test seen: ${report.sawStderrSelfTest ? "YES" : "no"}`,
  );

  lines.push("");
  if ((report.lines ?? []).length === 0) {
    lines.push("<no GenieX lines in the buffer>");
  } else if (detail === "full") {
    for (const line of report.lines ?? []) lines.push(line);
  } else if ((report.lines ?? []).length <= SUMMARY_LOG_LINES) {
    for (const line of report.lines ?? []) lines.push(clip(line));
  } else {
    // The lines that matter for a failure are the last ones, and 400
    // threadtime lines is more than the whole of the rest of a compact
    // report. The drop count is printed so a trimmed capture is not read as
    // a short one.
    const all = report.lines ?? [];
    const tail = all.slice(-SUMMARY_LOG_LINES);
    lines.push(
      `(newest ${tail.length} of ${all.length} lines; ${
        all.length - tail.length
      } older omitted — see logcat, VestaNpu tag)`,
      "",
    );
    for (const line of tail) lines.push(clip(line));
  }
  return lines.join("\n");
}

/** One log line, bounded. A stack trace on one line is still one line. */
function clip(line: string): string {
  return line.length <= SUMMARY_LOG_LINE_CHARS
    ? line
    : `${line.slice(0, SUMMARY_LOG_LINE_CHARS)}… (+${line.length - SUMMARY_LOG_LINE_CHARS} chars)`;
}

// ── What the runtime considers installed ──────────────────────────────────

/** Minimal shape of the native installed report, so this module stays testable. */
export interface InstalledReportLike {
  installed?: string[];
  installedCount?: number;
  probes?: {
    asked: string;
    inList: boolean;
    resolveAlias?: string | null;
    getPaths?: boolean;
    getPathsError?: string | null;
    resolvedName?: string | null;
    modelDir?: string | null;
    modelPath?: string | null;
    tokenizerPath?: string | null;
    runtimeId?: string | null;
    modelType?: string | null;
    getType?: string | null;
    dirExists?: boolean;
    fileCount?: number;
    totalBytes?: number;
    zeroLengthFiles?: string[];
    files?: { path: string; sizeBytes: number }[];
  }[];
  error?: string | null;
}

/**
 * Whether a pulled bundle is actually there, and under which identity.
 *
 * `list()` and `getPaths()` are printed as the two separate answers they are.
 * A name in `list()` with a null `getPaths()` is a bundle the manager knows
 * about but has not finished; a resolving `getPaths()` is the same test
 * `pull()` itself uses to decide the download completed.
 *
 * The zero-length files get their own line because that set is exactly what
 * `checkBundle()` reads as "the download did not finish" — a bundle listed as
 * installed, with paths that resolve, and a zero-byte `.lock` beside the
 * weights is a Vesta false negative rather than a broken download.
 *
 * `detail` defaults to "full", which is what this has always produced and what
 * the shared report wants. "summary" drops the one unbounded thing in here —
 * the per-file listing of the bundle, which for a 2.4 GB model is every shard
 * and every tokenizer file. The counts above it (`files: N, B bytes`) and the
 * zero-length set say what that listing was there to say.
 */
export function formatInstalledReport(
  report: InstalledReportLike,
  detail: CacheDetail = "full",
): string {
  const lines = ["GenieX installed models"];
  if (report.error) lines.push(`error: ${report.error}`);
  lines.push(`list(): ${report.installedCount ?? 0} model(s)`);
  for (const name of report.installed ?? []) lines.push(`  ${name}`);

  for (const p of report.probes ?? []) {
    lines.push("", `asked: ${p.asked}`, `in list(): ${p.inList ? "YES" : "no"}`);
    lines.push(`resolveAlias: ${p.resolveAlias ?? "<null>"}`);
    lines.push(`getPaths: ${p.getPaths ? "RESOLVED" : "<null>"}`);
    if (p.getPathsError) lines.push(`getPaths threw: ${p.getPathsError}`);
    if (!p.getPaths) continue;

    // The identity question: the catalogue name we asked with against the key
    // the manager filed it under.
    lines.push(
      `resolvedName: ${p.resolvedName ?? "<null>"}`,
      `identity matches asked: ${p.resolvedName === p.asked ? "yes" : "NO"}`,
      `getType: ${p.getType ?? "<null>"}`,
      `runtimeId: ${p.runtimeId ?? "<null>"}`,
      `modelDir: ${p.modelDir ?? "<null>"} (${p.dirExists ? "exists" : "ABSENT"})`,
      `modelPath: ${p.modelPath ?? "<null>"}`,
      `tokenizerPath: ${p.tokenizerPath ?? "<null>"}`,
      `files: ${p.fileCount ?? 0}, ${p.totalBytes ?? 0} bytes`,
    );

    const zero = p.zeroLengthFiles ?? [];
    lines.push(
      `zero-length files: ${zero.length === 0 ? "none" : zero.join(", ")}`,
    );
    if (detail === "full") {
      for (const f of p.files ?? []) lines.push(`  ${f.sizeBytes}\t${f.path}`);
    } else if ((p.files ?? []).length > 0) {
      lines.push(`(${(p.files ?? []).length} files not listed — see the full report)`);
    }
  }
  return lines.join("\n");
}

// ── Chipset identity ─────────────────────────────────────────────────────────
//
// What the Hub identity probe should have been asking all along.
//
// It used to make the same listHubModels() call twice — once unfiltered, once
// with the literal "SM8850" — and called the pair a measurement of what the
// parameter means. It was not. `listHubModels(chipset: String? = null)` is the
// released 0.4.0 signature (the bytecode names the parameter `chipset`, marks
// it @Nullable and gives it a default), so the unfiltered call was already
// production's own call, repeated, and the second was a guess at a key in the
// runtime's platform.json — which fails the whole call when it is wrong rather
// than reporting anything, and which Vesta has no business guessing at: the SoC
// id and AI Hub's asset key are different vocabularies by design (see
// CompatibleHubModel).
//
// The question underneath was real, though: WHICH SPELLING OF THIS CHIP IS THE
// ONE THE SDK ACCEPTS. That is answerable from evidence the app already holds,
// with no extra call and no guess — the device's own SoC, the runtime's
// equivalence table, and the keys the hub itself published for this silicon.

export interface ChipsetIdentityInput {
  /** `Build.SOC_MODEL`, as the device reports it. */
  deviceSoc: string | null;
  /** `listChipsets()` — the runtime's own vocabulary. Undefined when unasked. */
  table: RuntimeChipset[] | undefined;
  /** The last hub answer, if there is one. Never re-queried for this. */
  models: HubModel[] | null;
}

/**
 * Every name this device's silicon goes by, and where each one came from.
 *
 * Read-only over state already gathered: no bridge call, no network, and
 * therefore no chance of reporting a runtime the rest of the app never saw.
 *
 * The last line is the one the old two-call probe was reaching for. Each
 * distinct `HubModel.chipsets` key that resolves to this device is a spelling
 * the HUB published for this chip — supplied by the runtime, not invented here,
 * and so the only kind of string that could be handed back to a filtered
 * listing without it being a guess.
 */
export function formatChipsetIdentity(input: ChipsetIdentityInput): string {
  const { deviceSoc, table, models } = input;
  const identity = canonicalChipset(deviceSoc, table);
  const lines = ["Chipset identity", `device SoC (Build.SOC_MODEL): ${deviceSoc ?? "<unknown>"}`];

  if (!table) {
    // Never consulted is a different answer from consulted and empty, and the
    // fail-closed guard downstream treats them differently too.
    lines.push("runtime chipset table: not consulted");
  } else if (table.length === 0) {
    lines.push("runtime chipset table: empty (listChipsets() returned nothing)");
  } else {
    lines.push(`runtime chipset table: ${table.length} entries`);
    lines.push(`runtime name for this chip: ${identity?.runtimeName ?? "<no entry>"}`);
    lines.push(
      `runtime aliases: ${
        identity && identity.aliases.length > 0 ? identity.aliases.join(", ") : "<none>"
      }`,
    );
    lines.push(`known to runtime: ${identity?.knownToRuntime ? "YES" : "NO"}`);
  }

  lines.push(`canonical target: ${identity?.canonical ?? "<none>"}`);

  if (!models) {
    lines.push("hub chipset keys for this device: <no hub answer yet>");
    return lines.join("\n");
  }

  // Distinct, and in the order the hub listed them: this is evidence, so it is
  // reported as the hub spelled it.
  const keys: string[] = [];
  for (const entry of models) {
    const key = hubChipsetFor(entry, deviceSoc, table);
    if (key && !keys.includes(key)) keys.push(key);
  }
  lines.push(
    `hub chipset keys for this device: ${keys.length > 0 ? keys.join(", ") : "<none>"}`,
    `hub models offered for it: ${
      models.filter((m) => hubChipsetFor(m, deviceSoc, table)).length
    } of ${models.length}`,
  );
  return lines.join("\n");
}
