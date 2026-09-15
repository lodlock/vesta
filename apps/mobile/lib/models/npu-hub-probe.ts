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

/** The probe as a log line, one row per candidate. */
export function formatProbe(probe: HubIdentityProbe): string {
  const rows = probe.rows
    .map((r) => `  ${r.candidate}  ->  ${r.resolved ?? "(no answer)"}   [${r.source}]`)
    .join("\n");
  return `hub identity probe (pull would use ${probe.pullName} via ${probe.hub}):\n${rows}`;
}
