// The llama.cpp backend — the one that can always run.
//
// A thin adapter over lib/llm/llm-engine, which stays the implementation:
// nothing here re-does model loading, the generation lock, the KV session
// cache or the perf settings. The point is to give that runtime a name and a
// `supports()` answer so a second backend can exist beside it without either
// having to know about the other.
//
// It claims GGUF and nothing else. Portability is the reason this backend is
// the fallback: a .gguf carries no target, so if the file loads at all, it runs
// — on this phone, on a different SoC, on a device with no NPU whatsoever.

import {
  loadModel,
  unloadModel,
  generate,
  isLoaded,
  getModelInfo,
  getLastCompletion,
} from "../llm-engine";
import { recordRun } from "../run-record";
import type {
  BackendDiagnostics,
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendMessage,
  BackendModelRef,
  ModelBackend,
} from "./types";

export class LlamaCppBackend implements ModelBackend {
  readonly id = "llama.cpp";
  readonly displayName = "llama.cpp (CPU)";

  supports(model: BackendModelRef): boolean {
    return model.artifact === "gguf";
  }

  private lastLoadMs: number | null = null;
  private lastModelName = "";
  private lastQuant = "";

  async load(model: BackendModelRef): Promise<void> {
    const started = Date.now();
    await loadModel(model.filePath, {
      contextSize: model.contextSize,
      gpuLayers: 0,
      chatTemplate: model.chatTemplate ?? undefined,
    });
    this.lastLoadMs = Date.now() - started;
    this.lastModelName = model.displayName;
    this.lastQuant = model.quant ?? "";
  }

  async generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
  ): Promise<BackendGenerateResult> {
    const started = Date.now();
    const result = await generate(messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      ...(options?.enableThinking === false ? { enableThinking: false } : {}),
    });
    // Written here, at the point of execution: the only place that can honestly
    // say CPU produced this. See run-record.
    recordRun({
      backend: "llama_cpp",
      backendLabel: "llama.cpp",
      computeLabel: "CPU",
      modelName: this.lastModelName,
      artifactLabel: this.lastQuant ? `GGUF ${this.lastQuant}` : "GGUF",
      coldLoadMs: this.lastLoadMs ?? undefined,
      reusedSession: this.lastLoadMs === null,
      promptTokens: result.tokensEvaluated,
      generatedTokens: result.tokensPredicted,
      generatedChars: result.text?.length ?? 0,
      decodeTokensPerSecond: result.timings.predictedPerSecond,
      // llama.rn reports prompt time, which is the prefill cost; TTFT as such
      // is not separately measured, so it is left unreported rather than
      // approximated from it.
      totalMs: Date.now() - started,
    });
    return {
      text: result.text,
      content: result.content,
      tokensPredicted: result.tokensPredicted,
      tokensPerSecond: result.timings.predictedPerSecond,
      tokensEvaluated: result.tokensEvaluated,
      stoppedByUser: result.stoppedByUser,
    };
  }

  unload(): Promise<void> {
    return unloadModel();
  }

  getDiagnostics(): BackendDiagnostics {
    const info = getModelInfo();
    const stats = getLastCompletion();
    return {
      id: this.id,
      displayName: this.displayName,
      available: true, // bundled; there is no device on which it is missing
      loaded: isLoaded(),
      unavailableReason: null,
      details: {
        modelPath: info.path ?? "",
        lastTokensPerSecond: stats?.predictedPerSecond ?? 0,
      },
    };
  }
}
