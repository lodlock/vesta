// Where the first-launch wait actually goes.
//
// The launch spinner covers several things at once, and guessing which one
// dominates is how people optimize the wrong half. This records each phase as
// it happens, so Diagnostics can show a breakdown rather than a total:
//
//   nativeToJs   Android process start → the first line of JS. Zygote, the
//                native libraries, the RN bundle. Mostly not ours.
//   database     opening SQLite and running migrations
//   restore      language + last conversation + its messages
//   service      starting the keep-alive foreground service
//   model        loading the GGUF and warming the KV prefix — the big one
//   total        mount → the spinner going away
//
// Cheap by construction: a handful of Date.now() calls, kept in memory, never
// written anywhere. The point is to answer "is this us or is this Android",
// which no amount of reasoning about the code can settle.

export type StartupPhase =
  | "nativeToJs"
  | "database"
  | "restore"
  | "service"
  | "model"
  | "total";

export interface StartupTrace {
  phases: Partial<Record<StartupPhase, number>>;
  /** True when this launch deliberately skipped the model (an assist launch). */
  skippedModel: boolean;
  at: number | null;
}

const trace: StartupTrace = { phases: {}, skippedModel: false, at: null };

/** Times `work`, records it under `phase`, and returns its result. */
export async function timePhase<T>(
  phase: StartupPhase,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    trace.phases[phase] = Date.now() - started;
  }
}

export function markPhase(phase: StartupPhase, ms: number): void {
  trace.phases[phase] = ms;
}

export function markSkippedModel(skipped: boolean): void {
  trace.skippedModel = skipped;
}

export function finishTrace(totalMs: number): void {
  trace.phases.total = totalMs;
  trace.at = Date.now();
}

export function getStartupTrace(): StartupTrace {
  return trace;
}

/**
 * How long the app took to reach JS, from the OS's own process-start clock.
 * Android-only and API 24+; absent elsewhere, which is honest rather than
 * zero — this is the part of the wait that is not Vesta's to fix.
 */
export function recordNativeToJs(processStartMs: number | null): void {
  if (processStartMs === null || processStartMs <= 0) return;
  trace.phases.nativeToJs = Math.max(0, Date.now() - processStartMs);
}
