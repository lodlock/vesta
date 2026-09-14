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
    return model.format === "gguf";
  }

  async load(model: BackendModelRef): Promise<void> {
    await loadModel(model.filePath, {
      contextSize: model.contextSize,
      gpuLayers: 0,
      chatTemplate: model.chatTemplate ?? undefined,
    });
  }

  async generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
  ): Promise<BackendGenerateResult> {
    const result = await generate(messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      ...(options?.enableThinking === false ? { enableThinking: false } : {}),
    });
    return {
      text: result.text,
      content: result.content,
      tokensPredicted: result.tokensPredicted,
      tokensPerSecond: result.timings.predictedPerSecond,
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
