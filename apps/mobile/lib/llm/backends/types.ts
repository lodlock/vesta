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

  load(model: BackendModelRef): Promise<void>;
  generate(
    messages: BackendMessage[],
    options?: BackendGenerateOptions,
  ): Promise<BackendGenerateResult>;
  unload(): Promise<void>;

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
