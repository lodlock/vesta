// The seam between "a model" and "the thing that runs it".
//
// Vesta has one runtime today (llama.cpp via llama.rn) and will likely have a
// second (Qualcomm's NPU stack — see docs/ARCHITECTURE.md ADR-021). These are
// not variants of each other: they take different model FORMATS, compiled for
// different targets, with different portability. A .gguf runs anywhere; a QNN
// context binary is built for one SoC family and is useless on another phone.
//
// So the abstraction deliberately does NOT try to make them interchangeable.
// `supports()` is the whole point: each backend answers for itself whether it
// can run a given model on this device, and the registry picks the first that
// can. A model no accelerated backend claims falls back to llama.cpp, which is
// the one that can always run — that fallback is a requirement, not a nicety.

import type { ModelArtifact } from "../../models/types";

/** What a backend needs to know about a model to answer `supports()`. */
export interface BackendModelRef {
  filePath: string;
  artifact: ModelArtifact;
  contextSize: number;
  displayName: string;
  // The SoC the artifact was compiled for ("SM8850"). Null for portable
  // formats like GGUF — and a Qualcomm artifact without one is refused, not
  // guessed at.
  targetSoc?: string | null;
  runtimeVersion?: string | null;
  chatTemplate?: string | null;
  // Where the tokenizer is, for bundles that don't keep it beside the weights.
  tokenizerPath?: string | null;
  // How the RUNTIME addresses this model, when it owns the files itself.
  // GenieX's model manager keys its cache by name ("ai-hub-models/Qwen3-4B-
  // Instruct-2507") and resolves the paths; handing it a path instead would
  // bypass the manifest that says which runtime the bundle is for. Null for
  // everything Vesta stores itself, which is every GGUF.
  runtimeModelName?: string | null;
  /** Quantization, for the artifact label in diagnostics ("Q4_K_M", "w4a16"). */
  quant?: string | null;
}

export interface BackendGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  enableThinking?: boolean;
}

export interface BackendMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BackendGenerateResult {
  text: string;
  // Reasoning-filtered text where the runtime can separate it; empty otherwise.
  content: string;
  tokensPredicted: number;
  tokensPerSecond: number;
  // Prompt tokens the runtime actually evaluated, when it says. Undefined is
  // "not reported" and must be displayed as such, never as 0 — on the KV-reuse
  // screens a zero here reads as a perfect cache hit.
  tokensEvaluated?: number;
  // True when the turn ended because the user stopped it. A stopped turn still
  // returns the text produced so far, so callers need this to tell "finished"
  // from "interrupted" rather than inferring it from a short answer.
  stoppedByUser?: boolean;
}

export interface BackendDiagnostics {
  id: string;
  displayName: string;
  available: boolean;
  loaded: boolean;
  // Why an unavailable backend is unavailable, in words a diagnostics screen
  // can show. Null when it is available.
  unavailableReason: string | null;
  // Free-form, backend-specific facts (SoC, runtime version, loaded path).
  details: Record<string, string | number | boolean>;
}

export interface ModelBackend {
  readonly id: string;
  readonly displayName: string;

  /**
   * Whether this backend can run this model ON THIS DEVICE. Must be honest:
   * a backend that claims a model it cannot actually run turns a fallback into
   * a failure. Called before load(), and cheap.
   */
  supports(model: BackendModelRef): boolean;

  /**
   * A stable description of the configuration this backend would load `model`
   * with RIGHT NOW — everything that changes the session it creates but is not
   * part of the model's identity.
   *
   * It exists because "the same model is already loaded" is not the same
   * question as "the loaded session is the one a load would produce now", and
   * treating them as one is how a setting silently fails to take effect. The
   * GenieX llama.cpp lane made that concrete: its compute unit (`npu` pins
   * HTP0, `hybrid` lets llama.cpp schedule across HTP and CPU) is chosen per
   * load, so flipping it and re-activating the SAME model has to rebuild the
   * native session — and did not, because every short-circuit on the way
   * compared file paths.
   *
   * Optional, and absence means "nothing outside the model ref affects my
   * session". A backend that does not implement it keeps the plain same-model
   * no-op, which is what QAIRT (compute unit pinned in Kotlin) and llama.rn
   * want. Never used to decide WHICH backend runs a model — only whether the
   * session one already holds can be reused.
   */
  loadFingerprint?(model: BackendModelRef): string;

  load(model: BackendModelRef): Promise<void>;
  generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
    // Called per token when the caller is showing the reply as it arrives.
    // Optional on both sides: a backend that cannot stream simply ignores it,
    // and a caller that is not watching lets the backend skip the per-token
    // work entirely.
    onToken?: (token: string) => void,
  ): Promise<BackendGenerateResult>;
  unload(): Promise<void>;

  /** Stops an in-flight generation, where the runtime supports it. */
  stop?(): void;

  getDiagnostics(): BackendDiagnostics;
}

/**
 * A guess at the artifact type from a file name, for IMPORT — where the user
 * hands us a path and nothing else. The registry's stored `artifact` column is
 * authoritative everywhere else; a `.bin` could be anything, which is why an
 * imported Qualcomm artifact still has to declare its target SoC before any
 * backend will touch it.
 */
export function guessArtifact(filePath: string): ModelArtifact | "unknown" {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".gguf")) return "gguf";
  if (lower.endsWith(".bin") || lower.endsWith(".serialized")) return "qairt_context";
  return "unknown";
}
