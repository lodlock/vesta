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

export type ModelFormat = "gguf" | "qnn-context" | "executorch-pte" | "unknown";

/** What a backend needs to know about a model to answer `supports()`. */
export interface BackendModelRef {
  filePath: string;
  format: ModelFormat;
  contextSize: number;
  // The SoC the artifact was compiled for, when the format is target-specific
  // ("SM8850"). Null for portable formats like GGUF.
  targetSoc?: string | null;
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

/** The format of a model file, from its name. */
export function formatOf(filePath: string): ModelFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".gguf")) return "gguf";
  if (lower.endsWith(".pte")) return "executorch-pte";
  // Qualcomm context binaries ship as .bin next to a genie_config.json; the
  // extension alone is ambiguous, so this is a hint the registry double-checks
  // with the backend's own supports().
  if (lower.endsWith(".bin")) return "qnn-context";
  return "unknown";
}
