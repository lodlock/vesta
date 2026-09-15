// Which backend runs a given model.
//
// Ordered, first-match-wins, with llama.cpp last. Order is the policy: an
// accelerated backend gets the chance to claim a model, and whatever nothing
// claims lands on the one runtime that can always run it. There is no user
// configuration here on purpose — a person should not have to know what a
// context binary is to get an answer out of their phone.
//
// The NPU backend needs one fact from outside: the device's chipset, which
// arrives from device-caps. Until it does, it has nothing to match an
// artifact's target against and therefore claims nothing.

import { LlamaCppBackend } from "./llamacpp-backend";
import { QualcommNpuBackend } from "./qnn-backend";
import type { BackendDiagnostics, BackendModelRef, ModelBackend } from "./types";
import type { InstalledModel } from "../../models/types";

const npuBackend = new QualcommNpuBackend();

// Accelerated first, general-purpose last.
const backends: ModelBackend[] = [npuBackend, new LlamaCppBackend()];

/** Tells the NPU backend what chipset it is running on. */
export function setDeviceSoc(soc: string | null): void {
  npuBackend.setSoc(soc);
}

/** Exposed for tests and the diagnostics screen. */
export function allBackends(): ModelBackend[] {
  return backends;
}

/**
 * The backend for this model, or null when nothing can run it. Null is a real
 * answer and callers must handle it: silently loading the wrong runtime is how
 * a model file becomes a crash.
 */
export function selectBackend(model: BackendModelRef): ModelBackend | null {
  return backends.find((backend) => backend.supports(model)) ?? null;
}

/**
 * Why the NPU backend will not take this model, in words — or null when it
 * will. The Models screen shows this so "runs on CPU" is never a mystery.
 */
export function npuRefusalFor(model: BackendModelRef): string | null {
  return npuBackend.refusalFor(model);
}

/** Builds the ref a backend is asked about, from a registry row. */
export function backendModelRef(model: {
  filePath: string;
  contextSize: number;
  displayName?: string;
  artifact?: InstalledModel["artifact"];
  chatTemplate?: string | null;
  targetSoc?: string | null;
  runtimeVersion?: string | null;
  quant?: string | null;
  tokenizerPath?: string | null;
}): BackendModelRef {
  return {
    filePath: model.filePath,
    // Rows carry their artifact type; the extension is only a fallback for a
    // caller that has a path and nothing else.
    artifact: model.artifact ?? "gguf",
    contextSize: model.contextSize,
    displayName: model.displayName ?? model.filePath.split("/").pop() ?? "model",
    chatTemplate: model.chatTemplate ?? null,
    targetSoc: model.targetSoc ?? null,
    runtimeVersion: model.runtimeVersion ?? null,
    quant: model.quant ?? null,
    tokenizerPath: model.tokenizerPath ?? null,
  };
}

/** Every backend's state, for the diagnostics screen. */
export function backendDiagnostics(): BackendDiagnostics[] {
  return backends.map((backend) => backend.getDiagnostics());
}
