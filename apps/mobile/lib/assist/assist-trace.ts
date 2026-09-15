// Where a model-backed assistant turn's wait actually goes.
//
// The complaint this answers: "every assistant question seems to reload the
// model." That is three different possible things — the process was killed and
// the weights really were reloaded; the weights were resident but the prompt
// prefix had to be re-evaluated; or the generation itself was simply long — and
// they need completely different fixes. Guessing between them from a stopwatch
// is how you end up pinning multi-GB of weights in RAM to fix a prefill.
//
// So each model-backed invocation records, in order:
//
//   loadedAtStart   was a model already resident when the invocation began?
//   loadMs          time inside ensureModelLoaded (0 when already resident)
//   restoreMs       prefix/session restore, if the load did one
//   generateMs      the model call itself
//   promptTokens    tokens the runtime actually EVALUATED for this turn. The
//                   tell: a small number is a warm KV append, a number near the
//                   whole prefix is a cold re-prefill of a prefix that changed.
//   cachedTokens    tokens it got to reuse from the KV cache.
//
// Pure bookkeeping — no timers, no platform, nothing to tear down.

export interface AssistTurnTrace {
  /** The invocation this turn belonged to. */
  sessionId: number;
  /** Was a model already loaded when the assistant reached the model path? */
  loadedAtStart: boolean;
  /** Milliseconds inside ensureModelLoaded. ~0 when it was already resident. */
  loadMs: number;
  /** Milliseconds spent restoring the prefix KV session, when a load ran. */
  restoreMs: number;
  /** Milliseconds inside the model call (prefill + decode). */
  generateMs: number;
  /** Prompt tokens the runtime evaluated — the cold-prefill tell. */
  promptTokens: number | null;
  /** Prompt tokens served from the KV cache. */
  cachedTokens: number | null;
  /** Wall clock for the whole model path. */
  totalMs: number;
  at: number;
}

let last: AssistTurnTrace | null = null;
// How many model-backed invocations this PROCESS has served. A counter that
// keeps returning 1 while the user is asking their third question is itself the
// answer to "does the model unload between questions": it doesn't, the process
// is being killed.
let modelTurns = 0;

export function recordAssistTurn(trace: AssistTurnTrace): void {
  last = trace;
  modelTurns += 1;
}

export function getLastAssistTurn(): AssistTurnTrace | null {
  return last;
}

/** Model-backed assistant turns served by THIS process. */
export function getAssistModelTurns(): number {
  return modelTurns;
}

/** Test seam. */
export function resetAssistTrace(): void {
  last = null;
  modelTurns = 0;
}
