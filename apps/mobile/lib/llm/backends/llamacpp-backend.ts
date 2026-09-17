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
  loadedBackendId,
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

  /**
   * What llama.rn itself is holding — not what the engine is holding.
   *
   * This read `isLoaded()`, which is true whenever ANY runtime has a session,
   * and `getModelInfo().path`, which is the engine's one current path whichever
   * lane set it. So while the GenieX lane held a Hexagon session, this backend
   * reported "loaded" against the GenieX model's own file, and a diagnostics
   * report showed two backends loaded with one model between them. It was the
   * line that made a genuine mis-restore look like the normal state, and it was
   * never a second session: llm-engine keeps one `LlamaContext` and one path,
   * and both are shared low-level state that only one lane at a time owns.
   *
   * `loadedBackendId()` names the owner, so these fields describe this backend
   * or say nothing at all. Diagnostics-only — nothing routes on this.
   */
  getDiagnostics(): BackendDiagnostics {
    const mine = loadedBackendId() === "llama_cpp";
    const info = getModelInfo();
    const stats = getLastCompletion();
    return {
      id: this.id,
      displayName: this.displayName,
      available: true, // bundled; there is no device on which it is missing
      loaded: mine,
      unavailableReason: null,
      details: {
        // Blank rather than the engine's path when another lane owns the
        // session: an empty value is dropped from the report, and a path here
        // is a claim that llama.rn has that file open.
        modelPath: mine ? (info.path ?? "") : "",
        // Likewise. The last completion is whoever's ran last, and attributing
        // a Hexagon turn's rate to the CPU backend is how a fast run gets
        // filed as a slow one.
        lastTokensPerSecond: mine ? (stats?.predictedPerSecond ?? 0) : 0,
      },
    };
  }
}
