// What the last NPU pull actually asked for, and what came back.
//
// TEMPORARY DIAGNOSTIC. It exists because `rc=-100000` carries no information
// on its own: it is not one of the four codes with a source (0, -100006,
// -100008, -100010), it has no symbolic name anywhere in geniex-android 0.4.0,
// and it sits at the base of the `GENIEX_ERROR_COMMON_*` block — the position a
// generic "something failed" occupies. So the number says nothing, and the only
// evidence is the REQUEST that produced it and the runtime's own message.
//
// Both were already going to logcat from the native side. What was missing is a
// way to read them off the device without `adb`, and one fact neither side
// recorded: whether any bytes moved before the failure. That single boolean
// splits the problem in half —
//
//   progress events > 0  → the transfer started and died inside it
//   progress events == 0 → it failed during setup: manifest resolution,
//                          chipset lookup, asset selection, or creating the
//                          `.inflight` directory
//
// and those have entirely different causes.
//
// Records only. Nothing here changes what is pulled, retried, kept or deleted,
// and no user-facing behaviour is attached to any code.

/** One pull attempt, as it was issued. */
export interface PullAttemptTrace {
  /** 1 for the first attempt; 2+ means the retry wrapper asked again. */
  attempt: number;
  /** Exactly the fields handed to npuPull(), after serialization decisions. */
  request: Record<string, unknown>;
  /** Whether the install's abort signal was already set. Must be false at 1. */
  aborted: boolean;
  startedAt: number;
  /** How the attempt ended. Absent while it is still running. */
  outcome?: {
    ok: boolean;
    /** Milliseconds from request to answer. A setup failure is ~instant. */
    elapsedMs: number;
    /** Progress events seen during THIS attempt. Zero means no transfer. */
    progressEvents: number;
    /** Highest byte count this attempt reported, if any. */
    bytesWritten: number;
    /** The rejection text verbatim, `rc=<n>: <message>`. */
    error?: string;
  };
}

const MAX_ATTEMPTS_KEPT = 8;

let trace: PullAttemptTrace[] = [];

/** Starts a new record. Returns the attempt so the caller can complete it. */
export function recordPullAttempt(
  attempt: number,
  request: Record<string, unknown>,
  aborted: boolean,
  now = Date.now(),
): PullAttemptTrace {
  const entry: PullAttemptTrace = { attempt, request, aborted, startedAt: now };
  trace = [...trace, entry].slice(-MAX_ATTEMPTS_KEPT);
  return entry;
}

/** Completes the most recent record in place. */
export function recordPullOutcome(
  entry: PullAttemptTrace,
  outcome: PullAttemptTrace["outcome"],
): void {
  entry.outcome = outcome;
}

export function getPullTrace(): PullAttemptTrace[] {
  return trace;
}

export function resetPullTrace(): void {
  trace = [];
}

/**
 * The trace as plain text, for the diagnostics report and for logcat.
 *
 * The request is printed field by field rather than as JSON so an empty string,
 * an absent key and the four-character word "null" are three visibly different
 * things — which is the distinction that has already cost this path two
 * separate bugs.
 */
export function formatPullTrace(entries: PullAttemptTrace[] = trace): string {
  if (entries.length === 0) return "NPU pull trace\nno pull attempted this session";

  const lines = ["NPU pull trace"];
  for (const e of entries) {
    lines.push(
      "",
      `attempt ${e.attempt} ${e.attempt === 1 ? "(initial)" : `(retry ${e.attempt - 1})`}`,
      `abort signal at issue: ${e.aborted ? "ABORTED" : "clear"}`,
      "request:",
    );
    for (const [key, value] of Object.entries(e.request)) {
      lines.push(`  ${key} = ${describeValue(value)}`);
    }
    // Absent keys are as load-bearing as present ones on this bridge: the
    // native side reads an absent chipset as "unfiltered" and an absent
    // precision as "let GenieX pick", and both were once the word "null".
    const absent = ["modelName", "chipset", "precision", "hub", "displayName", "localPath"]
      .filter((k) => !(k in e.request));
    lines.push(`  <absent keys> = ${absent.join(", ") || "none"}`);

    if (!e.outcome) {
      lines.push("outcome: still running");
      continue;
    }
    const o = e.outcome;
    lines.push(
      `outcome: ${o.ok ? "ok" : "FAILED"} after ${o.elapsedMs} ms`,
      `progress events: ${o.progressEvents}`,
      `bytes reported: ${o.bytesWritten}`,
      // The half-and-half question, answered rather than guessed at.
      `phase: ${o.progressEvents > 0 ? "inside transfer" : "BEFORE any transfer (setup)"}`,
    );
    if (o.error) lines.push(`error: ${o.error}`);
  }
  return lines.join("\n");
}

/** Quoted, so "" and "null" and absent cannot be read as each other. */
function describeValue(value: unknown): string {
  if (value === null) return "<JSON null>";
  if (value === undefined) return "<undefined>";
  if (typeof value === "string") return `"${value}" (len ${value.length})`;
  return String(value);
}

/**
 * The model the last pull attempt actually asked for, if there was one.
 *
 * The diagnostics screen used to interrogate the manifest for whatever the
 * curated catalogue's first entry happens to be. When the failing install is a
 * hub row for a different model, that answers a question nobody asked — so the
 * needle follows the request when there is one.
 */
export function lastPulledModelName(): string | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const name = trace[i].request?.modelName;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return null;
}
