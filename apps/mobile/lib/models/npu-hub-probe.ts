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
  files?: {
    path: string;
    sizeBytes: number;
    modifiedAt: number;
    content?: string | null;
    analysis?: ManifestAnalysis;
  }[];
  error?: string | null;
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
  matches?: string[];
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
export function formatCacheReport(
  report: CacheReportLike,
  repo: string,
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

  lines.push(
    "",
    `dataDir: ${report.dataDir ?? "<none>"}`,
    `dataDirExists: ${report.dataDirExists ?? false}`,
    `files: ${report.files?.length ?? 0}`,
  );

  for (const file of report.files ?? []) {
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
        `topLevelKeys: ${(a.topLevelKeys ?? []).join(", ") || "<none>"}`,
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
      for (const match of a.matches ?? []) lines.push(match);
    } else if (file.content) {
      const hits = mentionsModel(file.content, repo);
      lines.push(
        `mentions ${repo}: ${hits.length > 0 ? hits.join(", ") : "NO"}`,
        "content:",
        file.content,
      );
    }
  }
  return lines.join("\n");
}

/** Minimal shape of a hub-list probe, so this module stays testable. */
export interface ListProbeLike {
  filter?: string | null;
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
  const lines = [`listHubModels(${probe.filter ?? "null"})`];
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
