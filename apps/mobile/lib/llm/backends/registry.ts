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
import { npuBackend } from "./npu-instance";
import { genieXLlamaCppBackend } from "./geniex-llamacpp-instance";
import type { BackendDiagnostics, BackendModelRef, ModelBackend } from "./types";
import type { InstalledModel, ModelBackendId } from "../../models/types";
import type { RuntimeChipset } from "../../models/chipset-identity";

// Accelerated first, general-purpose last.
//
// The GenieX llama.cpp lane sits BETWEEN the two, and the order is the policy
// in both directions. Above the CPU backend, because it claims a GGUF that
// backend would otherwise take and can run it on the Hexagon DSP. Below QAIRT,
// because the two runtimes take different artifacts and QAIRT's is the
// stronger claim where both could apply — and because a lane that can only
// ever be reached by falling past the one above it is the lane whose ordering
// nobody has to think about again.
const backends: ModelBackend[] = [
  npuBackend,
  genieXLlamaCppBackend,
  new LlamaCppBackend(),
];

/** Tells the NPU backend what chipset it is running on. */
export function setDeviceSoc(soc: string | null): void {
  npuBackend.setSoc(soc);
}

/**
 * Hands the NPU backend the runtime's own chipset table, so the chipset Android
 * reports and the chipset the runtime recognises can be cross-checked instead
 * of one being taken on faith. Called once, after the probe.
 */
export function setRuntimeChipsets(
  known: RuntimeChipset[] | undefined,
): void {
  npuBackend.setRuntimeChipsets(known);
}

/** The NPU backend itself, for the paths that must address it by name. */
export function qualcommNpuBackend() {
  return npuBackend;
}

/** The GenieX llama.cpp backend, for the paths that must address it by name. */
export function genieXLlamaCpp() {
  return genieXLlamaCppBackend;
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
  backend?: ModelBackendId;
  chatTemplate?: string | null;
  targetSoc?: string | null;
  runtimeVersion?: string | null;
  quant?: string | null;
  tokenizerPath?: string | null;
  runtimeModelName?: string | null;
}): BackendModelRef {
  return {
    filePath: model.filePath,
    // Rows carry their artifact type; the extension is only a fallback for a
    // caller that has a path and nothing else.
    artifact: model.artifact ?? "gguf",
    // Carried through UNDEFAULTED. "llama_cpp" here would be a declaration,
    // and a caller that simply does not know which runtime a path belongs to
    // must not make one on the row's behalf — see backends/routing.ts.
    backend: model.backend,
    contextSize: model.contextSize,
    displayName: model.displayName ?? model.filePath.split("/").pop() ?? "model",
    chatTemplate: model.chatTemplate ?? null,
    targetSoc: model.targetSoc ?? null,
    runtimeVersion: model.runtimeVersion ?? null,
    quant: model.quant ?? null,
    tokenizerPath: model.tokenizerPath ?? null,
    runtimeModelName: model.runtimeModelName ?? null,
  };
}

/** Every backend's state, for the diagnostics screen. */
export function backendDiagnostics(): BackendDiagnostics[] {
  return backends.map((backend) => backend.getDiagnostics());
}
