// Which backend runs a given model.
//
// Ordered, first-match-wins, with llama.cpp last. Order is the policy: an
// accelerated backend gets the chance to claim a model, and whatever nothing
// claims lands on the one runtime that can always run it. There is no
// configuration here on purpose — a user should not have to know what a context
// binary is to get an answer out of their phone.

import { LlamaCppBackend } from "./llamacpp-backend";
import { QualcommNpuBackend } from "./qnn-backend";
import { formatOf } from "./types";
import type { BackendDiagnostics, BackendModelRef, ModelBackend } from "./types";

// Accelerated first, general-purpose last.
const backends: ModelBackend[] = [new QualcommNpuBackend(), new LlamaCppBackend()];

/** Exposed for tests and the diagnostics screen. */
export function allBackends(): ModelBackend[] {
  return backends;
}

/**
 * The backend for this model, or null when nothing can run it (a format no
 * backend claims — an .pte with no ExecuTorch runtime, say). Null is a real
 * answer and callers must handle it: silently loading the wrong runtime is how
 * a model file becomes a crash.
 */
export function selectBackend(model: BackendModelRef): ModelBackend | null {
  return backends.find((backend) => backend.supports(model)) ?? null;
}

/** Builds the ref a backend is asked about, from a registry row. */
export function backendModelRef(model: {
  filePath: string;
  contextSize: number;
  chatTemplate?: string | null;
  targetSoc?: string | null;
}): BackendModelRef {
  return {
    filePath: model.filePath,
    format: formatOf(model.filePath),
    contextSize: model.contextSize,
    chatTemplate: model.chatTemplate ?? null,
    targetSoc: model.targetSoc ?? null,
  };
}

/** Every backend's state, for the diagnostics screen. */
export function backendDiagnostics(): BackendDiagnostics[] {
  return backends.map((backend) => backend.getDiagnostics());
}
