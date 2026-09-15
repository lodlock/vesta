// Qualcomm NPU backend.
//
// The TypeScript half is real: availability, compatibility, diagnostics and
// the refusals are all decided here and are fully testable without a Qualcomm
// device. The native half — binding GenieX's Kotlin API — is only present in a
// build made with VESTA_ENABLE_NPU=1, so `isAvailable()` is false in a default
// build and this backend claims nothing.
//
// It claims nothing under any doubt, either. `supports()` delegates to
// checkNpuCompatibility, which refuses on every unknown: an unreported
// chipset, an artifact that doesn't say what it was compiled for, a runtime
// older than the artifact needs. A backend that claims a model it cannot run
// turns a clean fallback to llama.cpp into a failed load, and the user has
// already waited for gigabytes by then.
//
// ## What "NPU" is allowed to mean here
//
// GenieX exposes no post-hoc attestation — nothing in its API says "that
// generation executed on the Hexagon DSP". So the claim this backend makes is
// precisely the one it can support, and the diagnostics screen says so in those
// words. All four of these must hold before a run is labelled NPU:
//
//   1. the QAIRT plugin registered (the SDK returned a version for it)
//   2. the session was created with runtime_id = "qairt"
//   3. the session was created with compute_unit = "npu"
//   4. THIS backend's wrapper produced the tokens
//
// Plus one fact from the runtime rather than from us: the QAIRT plugin refuses
// to run anywhere else. Its own words are "qairt plugin only supports NPU
// inference; ignoring device='…'". So a successful create on that plugin is a
// strong claim — but it is still an inference from a successful create, not an
// attestation, and `computeAttested: false` in the diagnostics details says so.
//
// There is deliberately NO fallback. If QAIRT/NPU creation fails the error
// propagates. Falling back to the CPU while keeping the label is the exact bug
// this design exists to prevent; a CPU fallback with an honest warning is a
// later feature, not this one.
//
// See docs/NPU-BACKEND.md for the licensing position and the build setup.

import { checkNpuCompatibility } from "../../models/npu-compat";
import {
  canonicalChipset,
  type ChipsetIdentity,
  type RuntimeChipset,
} from "../../models/chipset-identity";
import { recordRun } from "../run-record";
import {
  isNpuBuild,
  isNpuRuntimeAvailable,
  npuRuntimeInfo,
  npuUnavailableReason,
  npuLoad,
  npuGenerate,
  npuUnload,
  npuCancel,
  onNpuToken,
  type NpuRuntimeInfo,
  type NpuRawResult,
} from "../../native/npu";
import type {
  BackendDiagnostics,
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendMessage,
  BackendModelRef,
  ModelBackend,
} from "./types";

export class QualcommNpuBackend implements ModelBackend {
  readonly id = "qualcomm_npu";
  readonly displayName = "Qualcomm Hexagon NPU";

  private runtime: NpuRuntimeInfo | null = null;
  private loadedRef: BackendModelRef | null = null;
  private lastError: string | null = null;
  private lastProfile: NpuRawResult | null = null;
  private lastLoadMs: number | null = null;
  private turnsSinceLoad = 0;

  /** The chipset this device reports, needed to match an artifact's target. */
  private soc: string | null = null;

  /**
   * The runtime's own chipset vocabulary, once it has been read. `undefined`
   * means "not asked yet" and is passed through as such — see
   * NpuDevice.chipsets, where the three states are load-bearing.
   */
  private chipsets: RuntimeChipset[] | undefined = undefined;

  constructor(soc: string | null = null) {
    this.soc = soc;
  }

  /** The device's chipset, once device-caps has read it. */
  setSoc(soc: string | null): void {
    this.soc = soc;
  }

  /**
   * Feeds in the runtime's own chipset table so the two sources can be
   * cross-checked. Called once, after the probe.
   */
  setRuntimeChipsets(known: RuntimeChipset[] | undefined): void {
    this.chipsets = known;
  }

  /**
   * This device's chipset as one canonical id, resolved through the runtime's
   * own table — with the raw strings both sources reported kept alongside it.
   * Null only when the device reports no chipset at all.
   */
  chipsetIdentity(): ChipsetIdentity | null {
    return canonicalChipset(this.soc, this.chipsets);
  }

  isAvailable(): boolean {
    return isNpuRuntimeAvailable();
  }

  private device() {
    return {
      soc: this.soc,
      runtimeAvailable: this.isAvailable(),
      runtimeVersion: this.runtime?.version ?? npuRuntimeInfo()?.version ?? null,
      chipsets: this.chipsets,
    };
  }

  private modelFor(model: BackendModelRef) {
    return {
      artifact: model.artifact,
      targetSoc: model.targetSoc ?? null,
      runtimeVersion: model.runtimeVersion ?? null,
      displayName: model.displayName,
    };
  }

  supports(model: BackendModelRef): boolean {
    return checkNpuCompatibility(this.modelFor(model), this.device()).ok;
  }

  /** The reason this model is refused, for the UI. Null when it is accepted. */
  refusalFor(model: BackendModelRef): string | null {
    const check = checkNpuCompatibility(this.modelFor(model), this.device());
    return check.ok ? null : check.message;
  }

  async load(model: BackendModelRef): Promise<void> {
    // Checked again here, not just in supports(): load() is reachable directly
    // and an incompatible artifact must never reach the runtime.
    if (!this.supports(model)) {
      const reason = this.refusalFor(model) ?? "Not supported on this device.";
      this.lastError = reason;
      throw new Error(reason);
    }
    try {
      const started = Date.now();
      const runtime = await npuLoad({
        // A bundle is addressed by NAME — the model manager owns its layout and
        // resolves the paths. The path is a fallback for a bundle it doesn't
        // know, and is never how a catalog install is loaded.
        modelName: model.runtimeModelName ?? null,
        modelPath: model.filePath,
        tokenizerPath: model.tokenizerPath ?? null,
      });

      // The manifest's own runtime, reported back by the native side. A
      // mismatch here means the session was created against something that is
      // not a Qualcomm AI Engine Direct bundle, and nothing after this point
      // may call itself NPU.
      if (
        runtime.manifestRuntimeId &&
        runtime.manifestRuntimeId !== "qairt"
      ) {
        await npuUnload().catch(() => {});
        throw new Error(
          `${model.displayName} is a ${runtime.manifestRuntimeId} model, not a Qualcomm NPU bundle.`,
        );
      }

      this.runtime = runtime;
      this.lastLoadMs = Date.now() - started;
      this.turnsSinceLoad = 0;
      this.loadedRef = model;
      this.lastError = null;
    } catch (err) {
      this.loadedRef = null;
      this.runtime = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  isLoaded(): boolean {
    return this.loadedRef !== null;
  }

  async generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
    onToken?: (token: string) => void,
  ): Promise<BackendGenerateResult> {
    const model = this.loadedRef;
    if (!model) throw new Error("No NPU model loaded.");
    const started = Date.now();
    // Subscribe only when someone is watching, so an unwatched turn doesn't pay
    // a bridge hop per token.
    const unsubscribe = onToken ? onNpuToken(onToken) : null;
    try {
      const result = await npuGenerate(messages, {
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        // Assist mode turns the reasoning pass off at the runtime, exactly as
        // llama.rn does — GenieX takes the same flag on its chat template.
        enableThinking: options?.enableThinking,
        streamTokens: !!onToken,
      });
      this.lastError = null;
      this.lastProfile = result;

      // Only reached because THIS backend created the session and produced the
      // tokens — which, with the pinned runtime and compute unit, is the entire
      // basis on which anything may say "NPU".
      const coldLoad = this.turnsSinceLoad === 0;
      this.turnsSinceLoad++;
      recordRun({
        backend: "qualcomm_npu",
        backendLabel: "Qualcomm GenieX / QAIRT",
        computeLabel: "Hexagon HTP / NPU",
        modelName: model.displayName,
        artifactLabel: model.quant
          ? `${model.quant} context bundle`
          : "context bundle",
        soc: this.soc ?? undefined,
        runtimeVersion: this.runtime?.version ?? undefined,
        // The load cost belongs to the FIRST turn after a load; a warm turn
        // reused the session and must not re-report it.
        coldLoadMs: coldLoad ? (this.lastLoadMs ?? undefined) : undefined,
        reusedSession: !coldLoad,
        // The runtime's own measurements; absent stays absent.
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
        // Absent when the runtime didn't report it — see NpuRawResult.
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

  /** Stops an in-flight turn. Safe when nothing is running. */
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
      this.lastLoadMs = null;
      this.turnsSinceLoad = 0;
    }
  }

  getDiagnostics(): BackendDiagnostics {
    const available = this.isAvailable();
    const info = this.runtime ?? npuRuntimeInfo();
    const identity = this.chipsetIdentity();
    return {
      id: this.id,
      displayName: this.displayName,
      available,
      loaded: this.loadedRef !== null,
      unavailableReason: available
        ? null
        : // Three genuinely different situations, told apart rather than
          // flattened into "unavailable": no bridge in this build, a bridge
          // that could not start (with the SDK's own words), or a bridge that
          // has not been asked yet.
          !isNpuBuild()
          ? "No Qualcomm NPU runtime in this build — models run on llama.cpp."
          : (npuUnavailableReason() ??
            "The Qualcomm runtime has not been probed yet."),
      details: {
        // Raw first, canonical second, and both always shown. The canonical id
        // is what the compatibility guard compares; the raw strings are how we
        // find out what Qualcomm actually reported when it refuses.
        soc: this.soc ?? "unknown",
        runtimeChipset:
          identity === null
            ? "unknown"
            : !identity.tableConsulted
              ? "not checked"
              : (identity.runtimeName ?? "not recognised"),
        runtimeChipsetAliases: identity?.aliases.join(", ") || "n/a",
        canonicalChipset: identity?.canonical ?? "unknown",
        // What the runtime's table actually holds. Only useful in one
        // situation, and that is the situation it exists for: when the chip is
        // NOT in the table, every field above goes blank and this is the only
        // thing on the screen that says what Qualcomm did report.
        runtimeChipsetTable: this.chipsets
          ? this.chipsets
              .slice(0, 12)
              .map((c) => c.name)
              .join(", ") || "empty"
          : "not read",
        runtimeVersion: info?.version ?? "n/a",
        // What the session was REQUESTED with. Named that way on purpose.
        requestedRuntime: info?.runtimeId ?? "qairt",
        requestedComputeUnit: info?.computeUnit ?? "npu",
        manifestRuntime: info?.manifestRuntimeId ?? "n/a",
        // The honesty flag the diagnostics screen turns into a sentence: NPU
        // execution is inferred from a successful QAIRT+NPU create, not
        // attested by the runtime afterwards.
        computeAttested: false,
        modelPath: this.loadedRef?.filePath ?? "",
        lastError: this.lastError ?? "",
        // The runtime's own numbers from the last turn, or absent.
        ttftMs: this.lastProfile?.ttftMs ?? -1,
        prefillTokensPerSecond: this.lastProfile?.prefillSpeed ?? -1,
        decodeTokensPerSecond: this.lastProfile?.decodeSpeed ?? -1,
        stopReason: this.lastProfile?.stopReason ?? "n/a",
      },
    };
  }
}
