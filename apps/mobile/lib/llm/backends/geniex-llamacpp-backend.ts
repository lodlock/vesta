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

/**
 * The runtime's echoed compute unit, when it is one we recognise.
 *
 * `NpuRuntimeInfo.computeUnit` is a bare string off the bridge. An unrecognised
 * one is dropped rather than cast, so a runtime that starts answering something
 * new cannot silently become a label nothing else in the app understands.
 */
function asComputeUnit(value: string | null | undefined): GenieXComputeUnit | null {
  return value && value in COMPUTE_LABELS ? (value as GenieXComputeUnit) : null;
}

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
  /**
   * The compute unit the NEXT load will use. Mutable at any time, including
   * while a session is running — which is exactly why it must never be used to
   * describe that session. See {@link loadedComputeUnit}.
   */
  private computeUnit: GenieXComputeUnit = DEFAULT_GENIEX_COMPUTE_UNIT;
  /**
   * The compute unit the LOADED session was actually created with, or null when
   * nothing is loaded.
   *
   * These were one field, and that was a bug with two faces. Last Run relabelled
   * a live `npu` session as `hybrid` the moment the selector moved, because the
   * label read the pending value; and nothing could tell that the session no
   * longer matched the configuration, because there was nothing to compare it
   * against. A session's compute unit is a fact about a session, so it is stored
   * with the session and set only by a load that succeeded.
   */
  private loadedComputeUnit: GenieXComputeUnit | null = null;
  private devices: NpuDeviceSelection | null = null;
  private lastError: string | null = null;
  private lastProfile: NpuRawResult | null = null;
  private lastLoadMs: number | null = null;
  private turnsSinceLoad = 0;

  /**
   * Chooses the compute unit the NEXT load will use.
   *
   * `npu` is the one alias that makes GenieX log the explicit "Found device:
   * HTP0" sentence, so it is the mode that PROVES binding, while `hybrid` is
   * the one that should be fast.
   *
   * Deliberately does not touch the running session: GenieX has no way to move
   * a live session between devices, so the only honest options are "rebuild it"
   * or "leave it alone", and rebuilding several gigabytes of weights as a side
   * effect of a tap is not something a setter should decide. It leaves the
   * session exactly as it is and makes {@link loadFingerprint} disagree, which
   * is what tells activation to reload.
   */
  setComputeUnit(unit: GenieXComputeUnit): void {
    this.computeUnit = unit;
  }

  /** The compute unit the next load will use — NOT necessarily the loaded one. */
  getComputeUnit(): GenieXComputeUnit {
    return this.computeUnit;
  }

  /** What the loaded session was created with, or null when nothing is loaded. */
  getLoadedComputeUnit(): GenieXComputeUnit | null {
    return this.loadedComputeUnit;
  }

  /**
   * What separates one GenieX llama.cpp session from another with the same
   * model: the compute unit, and the context size the session was built around.
   *
   * Compared against the fingerprint recorded at load time, so "same model" can
   * stop meaning "same session". See ModelBackend.loadFingerprint.
   */
  loadFingerprint(model: BackendModelRef): string {
    return `computeUnit=${this.computeUnit};contextSize=${model.contextSize}`;
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
      // Reached only by a model this lane OWNS — the runtimeModelName guard
      // above has already sent every portable GGUF to llama.cpp. So these words
      // must not promise a CPU fallback: routing binds a GenieX-managed row to
      // this lane, and a refusal here is a load failure, not a redirection.
      // The runtime's own sentence is kept whole and put after ours, rather
      // than spliced into the middle of it: it is the only part of this that
      // says anything specific, and reshaping it is how it stops matching what
      // the SDK actually reported.
      const why = isNpuBuild()
        ? (npuUnavailableReason() ??
          "The Qualcomm GenieX runtime has not been probed yet.")
        : "There is no Qualcomm GenieX runtime in this build.";
      return `${model.displayName} is managed by the GenieX model manager and can only run on the GenieX llama.cpp runtime. ${why}`;
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
    // Read ONCE, before the await. The selector is mutable and a load takes
    // seconds; re-reading the field afterwards would let a tap that arrived
    // mid-load decide how we describe a session it did not configure.
    const requested = this.computeUnit;
    try {
      const started = Date.now();
      const runtime = await npuLoadLlamaCpp({
        // Non-null by the guard above; the manager resolves the path itself.
        modelName: model.runtimeModelName as string,
        computeUnit: requested,
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
      // The session's own compute unit, taken from what the native side echoed
      // back rather than from what we asked for — VestaNpuModule resolves and
      // validates the alias before building LlmCreateInput, so its answer is
      // the one that describes the session. `requested` is the fallback for a
      // runtime that does not echo, and never the pending selector value.
      this.loadedComputeUnit = asComputeUnit(runtime.computeUnit) ?? requested;
      this.lastError = null;
    } catch (err) {
      this.loadedRef = null;
      this.runtime = null;
      this.devices = null;
      this.loadedComputeUnit = null;
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
        generatedChars: result.text?.length ?? 0,
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
      this.loadedComputeUnit = null;
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
    // The LOADED session's unit. Reading the pending selector here is what let
    // a turn produced by a pinned-HTP0 session be labelled "hybrid" because
    // somebody had since tapped hybrid in Diagnostics — a label describing a
    // session that did not exist yet. There is no session to label when nothing
    // is loaded, and generate() cannot be reached in that state.
    const unit = this.loadedComputeUnit;
    if (!unit) return "no session";
    const asked = COMPUTE_LABELS[unit];
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
        // The LOADED session's compute unit — the source of truth for what is
        // actually running, and "n/a" rather than the pending value when there
        // is no session, so an unloaded backend never looks like a loaded one.
        requestedComputeUnit: this.loadedComputeUnit ?? "n/a",
        // What a load right now would use. Shown beside the above precisely so
        // a disagreement between them is visible instead of being resolved
        // silently in favour of whichever field a screen happened to read.
        pendingComputeUnit: this.computeUnit,
        computeUnitStale:
          this.loadedComputeUnit !== null &&
          this.loadedComputeUnit !== this.computeUnit,
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
