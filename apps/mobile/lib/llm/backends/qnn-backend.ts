// Qualcomm NPU backend — DECLARED, NOT IMPLEMENTED.
//
// This exists so the seam is real and testable before the runtime lands: the
// registry's selection and fallback logic runs against a second backend today,
// and the diagnostics screen can say why the NPU is not in use on a given
// device rather than staying silent about it.
//
// It reports `available: false` and claims nothing. That is deliberate — a stub
// that pretended to support a model would convert a clean fallback into a
// failed load, which is the exact failure mode this abstraction exists to
// prevent. Until the runtime is wired in, every model routes to llama.cpp.
//
// What "implemented" will mean (see ADR-021):
//   - a native module binding Qualcomm's Genie/QAIRT runtime,
//   - per-SoC context binaries fetched for THIS chipset (they are not
//     portable — one compiled for SM8850 is useless on anything else),
//   - a tokenizer and genie_config.json alongside the binary,
//   - the GGUF path untouched beside it, for every other model and device.

import type {
  BackendDiagnostics,
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendMessage,
  BackendModelRef,
  ModelBackend,
} from "./types";

const NOT_IMPLEMENTED =
  "The Qualcomm NPU runtime is not bundled in this build — models run on llama.cpp.";

export class QualcommNpuBackend implements ModelBackend {
  readonly id = "qnn";
  readonly displayName = "Qualcomm Hexagon NPU";

  /** The chipset this device reports, once the native module can tell us. */
  private readonly soc: string | null;

  constructor(soc: string | null = null) {
    this.soc = soc;
  }

  isAvailable(): boolean {
    // No runtime bundled yet. When it is, this becomes a native availability
    // probe (runtime present AND this SoC supported), never an assumption.
    return false;
  }

  supports(model: BackendModelRef): boolean {
    if (!this.isAvailable()) return false;
    if (model.format !== "qnn-context") return false;
    // A context binary is compiled for one SoC family. Running one built for
    // another chip is not a degraded experience, it is a crash.
    return !!model.targetSoc && model.targetSoc === this.soc;
  }

  async load(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async generate(
    _messages: BackendMessage[],
    _options?: BackendGenerateOptions,
  ): Promise<BackendGenerateResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async unload(): Promise<void> {
    // Nothing is ever loaded; unloading is a no-op rather than an error so
    // callers can tear down every backend uniformly.
  }

  getDiagnostics(): BackendDiagnostics {
    return {
      id: this.id,
      displayName: this.displayName,
      available: this.isAvailable(),
      loaded: false,
      unavailableReason: this.isAvailable() ? null : NOT_IMPLEMENTED,
      details: { soc: this.soc ?? "unknown" },
    };
  }
}
