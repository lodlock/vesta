// GenieX llama.cpp backend — the Snapdragon GGUF lane. SPIKE.
//
// A third runtime, and deliberately not a variant of either neighbour:
//
//   llama.cpp (llama.rn)   a GGUF Vesta downloaded, on the CPU. Portable, and
//                          the fallback that can always run.
//   THIS                   a GGUF the GENIEX model manager owns, run by
//                          GenieX's llama.cpp plugin across Hexagon HTP and
//                          CPU. Snapdragon only.
//   qualcomm_npu (QAIRT)   a pre-compiled context bundle, NPU only, one SoC.
//
// ## What this may be called, and what it may not
//
// Not "NPU". The prototype runs with `compute_unit = "hybrid"`, and hybrid is
// HTP **and** CPU by design — GenieX resolves it to an EMPTY device id and lets
// llama.cpp's per-tensor scheduler split the graph:
//
//     // sdk/src/device.cpp, v0.4.0 — the llama_cpp branch
//     if (alias == kAliasCPU)      { output->ngl = 0; }
//     else if (alias == kAliasGPU) { output->device_id = "GPUOpenCL"; }
//     else if (alias == kAliasNPU) { output->device_id = "HTP0"; }
//     // hybrid: device_id stays null, ngl passes through (-1 = all layers)
//
// So every op landing on the DSP is not a claim this backend can make, and it
// does not make it. What it CAN show is what the runtime logged while binding
// devices — see `deviceSelection` — which is more than the QAIRT lane has ever
// had, and is still evidence rather than attestation. `computeAttested` stays
// false: GenieX exposes no API that reports where a generation executed.
//
// ## No fallback
//
// If the GenieX session cannot be created the error propagates, exactly as on
// the QAIRT path. Quietly re-loading the same file on llama.rn would produce a
// CPU run wearing this backend's label, which is the one outcome the whole
// three-lane split exists to prevent.
//
// ## Why `supports()` is this narrow
//
// A GenieX-owned GGUF and an ordinary one are the same file format; only the
// OWNERSHIP differs. `runtimeModelName` is exactly that fact — "the runtime
// addresses this by name and resolved the path itself" — and nothing in Vesta
// produces a row with `artifact: "gguf"` AND a `runtimeModelName` except the
// import that feeds this lane. Claiming every GGUF instead would take the
// portable ones away from the backend that can always run them.

import {
  isNpuBuild,
  isNpuRuntimeAvailable,
  npuUnavailableReason,
  npuLoadLlamaCpp,
  npuGenerate,
  npuUnload,
  npuCancel,
  onNpuToken,
  DEFAULT_GENIEX_COMPUTE_UNIT,
  type GenieXComputeUnit,
  type NpuDeviceSelection,
  type NpuRawResult,
  type NpuRuntimeInfo,
} from "../../native/npu";
import { recordRun } from "../run-record";
import type {
  BackendDiagnostics,
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendMessage,
  BackendModelRef,
  ModelBackend,
} from "./types";

/** The manifest runtime a model must declare to belong to this lane. */
const LLAMA_CPP_RUNTIME = "llama_cpp";

/** How each compute unit is described once a session exists. */
const COMPUTE_LABELS: Record<GenieXComputeUnit, string> = {
  hybrid: "Hexagon HTP + CPU (hybrid)",
  npu: "Hexagon HTP (pinned HTP0)",
  gpu: "Adreno GPU (OpenCL)",
  cpu: "CPU (GenieX llama.cpp)",
};

export class GenieXLlamaCppBackend implements ModelBackend {
  readonly id = "geniex_llama_cpp";
  readonly displayName = "Qualcomm GenieX / llama.cpp";

  private loadedRef: BackendModelRef | null = null;
  private runtime: NpuRuntimeInfo | null = null;
  private computeUnit: GenieXComputeUnit = DEFAULT_GENIEX_COMPUTE_UNIT;
  private devices: NpuDeviceSelection | null = null;
  private lastError: string | null = null;
  private lastProfile: NpuRawResult | null = null;
  private lastLoadMs: number | null = null;
  private turnsSinceLoad = 0;

  /**
   * The compute unit the next load will use.
   *
   * Internal and test-only, as the brief asks: `npu` is the one alias that
   * makes GenieX log the explicit "Found device: HTP0" sentence, so it is the
   * mode that PROVES binding, while `hybrid` is the one that should be fast.
   * There is deliberately no UI for this.
   */
  setComputeUnit(unit: GenieXComputeUnit): void {
    this.computeUnit = unit;
  }

  getComputeUnit(): GenieXComputeUnit {
    return this.computeUnit;
  }

  isAvailable(): boolean {
    return isNpuRuntimeAvailable();
  }

  isLoaded(): boolean {
    return this.loadedRef !== null;
  }

  /**
   * A GGUF the GenieX model manager owns, on a device whose GenieX runtime
   * actually started. Every other GGUF belongs to llama.rn.
   */
  supports(model: BackendModelRef): boolean {
    return this.refusalFor(model) === null;
  }

  /** Why this model is refused, in words, or null when it is accepted. */
  refusalFor(model: BackendModelRef): string | null {
    if (model.artifact !== "gguf") {
      return "This model is not a GGUF.";
    }
    if (!model.runtimeModelName) {
      return "This GGUF is not registered with the GenieX model manager, so it runs on llama.cpp (CPU).";
    }
    if (!this.isAvailable()) {
      return isNpuBuild()
        ? (npuUnavailableReason() ??
          "The Qualcomm GenieX runtime has not been probed yet.")
        : "No Qualcomm GenieX runtime in this build — models run on llama.cpp (CPU).";
    }
    return null;
  }

  async load(model: BackendModelRef): Promise<void> {
    // Re-checked here and not only in supports(): load() is reachable directly.
    const refusal = this.refusalFor(model);
    if (refusal) {
      this.lastError = refusal;
      throw new Error(refusal);
    }
    try {
      const started = Date.now();
      const runtime = await npuLoadLlamaCpp({
        // Non-null by the guard above; the manager resolves the path itself.
        modelName: model.runtimeModelName as string,
        computeUnit: this.computeUnit,
        contextSize: model.contextSize,
      });

      // The manifest's own runtime, reported back by the native side. The
      // mirror of the QAIRT backend's check: a bundle that is not a GGUF must
      // never be run — or labelled — by this lane.
      if (runtime.manifestRuntimeId && runtime.manifestRuntimeId !== LLAMA_CPP_RUNTIME) {
        await npuUnload().catch(() => {});
        throw new Error(
          `${model.displayName} is a ${runtime.manifestRuntimeId} model, not a GenieX llama.cpp (GGUF) model.`,
        );
      }

      this.runtime = runtime;
      this.devices = runtime.deviceSelection ?? null;
      this.lastLoadMs = Date.now() - started;
      this.turnsSinceLoad = 0;
      this.loadedRef = model;
      this.lastError = null;
    } catch (err) {
      this.loadedRef = null;
      this.runtime = null;
      this.devices = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
    onToken?: (token: string) => void,
  ): Promise<BackendGenerateResult> {
    const model = this.loadedRef;
    if (!model) throw new Error("No GenieX llama.cpp model loaded.");
    const started = Date.now();
    const unsubscribe = onToken ? onNpuToken(onToken) : null;
    try {
      // The same native session the QAIRT lane drives — one LlmWrapper per
      // process, whichever runtime created it.
      const result = await npuGenerate(messages, {
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        enableThinking: options?.enableThinking,
        streamTokens: !!onToken,
      });
      this.lastError = null;
      this.lastProfile = result;

      const coldLoad = this.turnsSinceLoad === 0;
      this.turnsSinceLoad++;
      recordRun({
        backend: "geniex_llama_cpp",
        backendLabel: "Qualcomm GenieX / llama.cpp",
        computeLabel: this.computeLabel(),
        modelName: model.displayName,
        artifactLabel: model.quant ? `GGUF ${model.quant}` : "GGUF",
        soc: this.runtime?.soc ?? undefined,
        runtimeVersion: this.runtime?.version ?? undefined,
        coldLoadMs: coldLoad ? (this.lastLoadMs ?? undefined) : undefined,
        reusedSession: !coldLoad,
        promptTokens: result.promptTokens,
        ttftMs: result.ttftMs,
        prefillTokensPerSecond: result.prefillSpeed,
        generatedTokens: result.generatedTokens,
        decodeTokensPerSecond: result.decodeSpeed,
        totalMs: Date.now() - started,
        stopReason: result.stopReason,
      });
      return {
        text: result.text,
        content: result.text,
        tokensPredicted: result.generatedTokens ?? 0,
        tokensPerSecond: result.decodeSpeed ?? 0,
        tokensEvaluated: result.promptTokens,
        stoppedByUser: result.canceled === true,
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      unsubscribe?.();
    }
  }

  stop(): void {
    npuCancel();
  }

  async unload(): Promise<void> {
    if (!this.loadedRef) return;
    try {
      await npuUnload();
    } finally {
      this.loadedRef = null;
      this.runtime = null;
      this.devices = null;
      this.lastLoadMs = null;
      this.turnsSinceLoad = 0;
    }
  }

  /**
   * What executed this turn, as honestly as the evidence allows.
   *
   * The requested alias is the claim; the logged device lines qualify it. A
   * session that asked for HTP and then logged "No valid devices found" ran on
   * something else entirely, and the label says so rather than repeating the
   * request back.
   */
  private computeLabel(): string {
    const asked = COMPUTE_LABELS[this.computeUnit];
    if (this.devices?.sawNoValidDevices) {
      return `${asked} — requested, but GenieX found no valid device`;
    }
    return asked;
  }

  getDiagnostics(): BackendDiagnostics {
    const available = this.isAvailable();
    const devices = this.devices;
    return {
      id: this.id,
      displayName: this.displayName,
      available,
      loaded: this.loadedRef !== null,
      unavailableReason: available
        ? null
        : !isNpuBuild()
          ? "No Qualcomm GenieX runtime in this build — GGUF models run on llama.cpp (CPU)."
          : (npuUnavailableReason() ??
            "The Qualcomm GenieX runtime has not been probed yet."),
      details: {
        // What the session was REQUESTED with. Named that way on purpose, as
        // on the QAIRT lane.
        requestedRuntime: this.runtime?.runtimeId ?? LLAMA_CPP_RUNTIME,
        requestedComputeUnit: this.runtime?.computeUnit ?? this.computeUnit,
        manifestRuntime: this.runtime?.manifestRuntimeId ?? "n/a",
        runtimeVersion: this.runtime?.version ?? "n/a",
        soc: this.runtime?.soc ?? "unknown",
        modelPath: this.loadedRef?.filePath ?? "",
        runtimeModelName: this.loadedRef?.runtimeModelName ?? "",
        contextSize: this.runtime?.contextSize ?? -1,
        // The device-binding evidence, and its own caveat. `hybrid` logs no
        // device list at all — an absent HTP0 there is silence, not a negative.
        sawHtpDevice: devices?.sawHtpDevice ?? false,
        sawHexagonBackend: devices?.sawHexagonBackend ?? false,
        sawNoValidDevices: devices?.sawNoValidDevices ?? false,
        deviceEvidenceScoped: devices?.scopedToThisLoad ?? false,
        deviceLines: devices?.lines?.join("\n") ?? "",
        // Never true here. `hybrid` is HTP+CPU by construction and GenieX
        // reports nothing about where a generation actually ran.
        computeAttested: false,
        lastError: this.lastError ?? "",
        ttftMs: this.lastProfile?.ttftMs ?? -1,
        prefillTokensPerSecond: this.lastProfile?.prefillSpeed ?? -1,
        decodeTokensPerSecond: this.lastProfile?.decodeSpeed ?? -1,
        stopReason: this.lastProfile?.stopReason ?? "n/a",
      },
    };
  }
}
