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
// See docs/NPU-BACKEND.md for the licensing position and the build setup.

import { checkNpuCompatibility } from "../../models/npu-compat";
import {
  isNpuRuntimeAvailable,
  npuRuntimeInfo,
  npuLoad,
  npuGenerate,
  npuUnload,
  type NpuRuntimeInfo,
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
  private loadedPath: string | null = null;
  private lastError: string | null = null;

  /** The chipset this device reports, needed to match an artifact's target. */
  private soc: string | null = null;

  constructor(soc: string | null = null) {
    this.soc = soc;
  }

  /** The device's chipset, once device-caps has read it. */
  setSoc(soc: string | null): void {
    this.soc = soc;
  }

  isAvailable(): boolean {
    return isNpuRuntimeAvailable();
  }

  supports(model: BackendModelRef): boolean {
    return checkNpuCompatibility(
      {
        artifact: model.artifact,
        targetSoc: model.targetSoc ?? null,
        runtimeVersion: model.runtimeVersion ?? null,
        displayName: model.displayName,
      },
      {
        soc: this.soc,
        runtimeAvailable: this.isAvailable(),
        runtimeVersion: this.runtime?.version ?? npuRuntimeInfo()?.version ?? null,
      },
    ).ok;
  }

  /** The reason this model is refused, for the UI. Null when it is accepted. */
  refusalFor(model: BackendModelRef): string | null {
    const check = checkNpuCompatibility(
      {
        artifact: model.artifact,
        targetSoc: model.targetSoc ?? null,
        runtimeVersion: model.runtimeVersion ?? null,
        displayName: model.displayName,
      },
      {
        soc: this.soc,
        runtimeAvailable: this.isAvailable(),
        runtimeVersion: this.runtime?.version ?? npuRuntimeInfo()?.version ?? null,
      },
    );
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
      this.runtime = await npuLoad(model.filePath, model.contextSize);
      this.loadedPath = model.filePath;
      this.lastError = null;
    } catch (err) {
      this.loadedPath = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
  ): Promise<BackendGenerateResult> {
    if (!this.loadedPath) throw new Error("No NPU model loaded.");
    try {
      const result = await npuGenerate(messages, {
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        // Assist mode turns the reasoning pass off at the runtime, exactly as
        // llama.rn does — GenieX takes the same flag on its chat template.
        enableThinking: options?.enableThinking,
      });
      this.lastError = null;
      return {
        text: result.text,
        content: result.text,
        tokensPredicted: result.tokensPredicted,
        tokensPerSecond: result.tokensPerSecond,
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async unload(): Promise<void> {
    if (!this.loadedPath) return;
    try {
      await npuUnload();
    } finally {
      this.loadedPath = null;
      this.runtime = null;
    }
  }

  getDiagnostics(): BackendDiagnostics {
    const available = this.isAvailable();
    const info = this.runtime ?? npuRuntimeInfo();
    return {
      id: this.id,
      displayName: this.displayName,
      available,
      loaded: this.loadedPath !== null,
      unavailableReason: available
        ? null
        : "No Qualcomm NPU runtime in this build — models run on llama.cpp.",
      details: {
        soc: this.soc ?? "unknown",
        runtimeVersion: info?.version ?? "n/a",
        modelPath: this.loadedPath ?? "",
        lastError: this.lastError ?? "",
      },
    };
  }
}
