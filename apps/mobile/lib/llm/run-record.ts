// What actually ran, recorded by whoever ran it.
//
// The rule this exists to enforce: **nothing reports NPU unless the Qualcomm
// backend created the session and produced the tokens.** A diagnostics screen
// that infers the backend from settings, or from which model is selected, will
// eventually say "Hexagon NPU" about work the CPU did — the selected model can
// be an NPU model while the load fell back, the runtime can register and then
// fail, a session can be created and the generation still come from elsewhere.
//
// So the record is written at the point of execution, by the backend itself,
// and the screen shows only what it was told. A field the runtime does not
// report stays undefined and is displayed as "not reported", never as zero.

export type RunBackendId = "llama_cpp" | "qualcomm_npu";

export interface RunRecord {
  backend: RunBackendId;
  /** How the backend describes itself: "llama.cpp", "Qualcomm GenieX / QAIRT". */
  backendLabel: string;
  /** What executed it: "CPU", "Hexagon HTP / NPU". */
  computeLabel: string;
  modelName: string;
  /** The on-disk shape: "GGUF Q4_K_M", "w4a16 context bundle". */
  artifactLabel: string;
  /** The chipset, when the run was hardware-specific. */
  soc?: string;
  /** Runtime version, when the runtime reports one. */
  runtimeVersion?: string;

  // Timings and counts — all optional, all measured, none inferred.
  coldLoadMs?: number;
  reusedSession?: boolean;
  promptTokens?: number;
  ttftMs?: number;
  prefillTokensPerSecond?: number;
  generatedTokens?: number;
  decodeTokensPerSecond?: number;
  totalMs?: number;
  unloadMs?: number;
  /** Why generation stopped, when the runtime says ("eos", "max_tokens", …). */
  stopReason?: string;
}

let lastRun: RunRecord | null = null;

/** Called by a backend once it has actually produced a generation. */
export function recordRun(run: RunRecord): void {
  lastRun = run;
}

export function getLastRun(): RunRecord | null {
  return lastRun;
}

/** Forgets the last run — used when a model is unloaded or swapped. */
export function clearLastRun(): void {
  lastRun = null;
}

/** A measured value, or the honest absence of one. */
export function reportedOr(value: number | undefined, unit = ""): string {
  if (value === undefined || value < 0 || !Number.isFinite(value)) {
    return "not reported";
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit ? `${rounded} ${unit}` : String(rounded);
}
