// The boundary between TypeScript and the Qualcomm runtime.
//
// Every function here is a thin call into a native module that only exists in
// a build made with VESTA_ENABLE_NPU=1 (see docs/NPU-BACKEND.md). In a default
// build `NativeModules.VestaNpuModule` is undefined, `isNpuRuntimeAvailable()`
// is false, and nothing else here is ever reached — which is what lets the NPU
// backend exist in every build while claiming nothing in most of them.
//
// Availability is probed, never assumed: the module being present is not the
// same as the runtime working on this device, so the native side reports both
// and this file reports what it is told.

import { NativeModules, Platform } from "react-native";

const Npu = NativeModules.VestaNpuModule as NpuNativeModule | undefined;

interface NpuNativeModule {
  /** Runtime present AND usable here; resolves details or null. */
  probe(): Promise<NpuRuntimeInfo | null>;
  load(configJson: string): Promise<NpuRuntimeInfo>;
  generate(messagesJson: string, optionsJson: string): Promise<NpuRawResult>;
  cancel(): void;
  unload(): Promise<void>;
}

// Exactly what the runtime reported, nothing more. A field the runtime did not
// give us is ABSENT rather than defaulted — a diagnostics screen showing
// "0 tok/s" that came from a missing measurement is worse than one saying the
// runtime didn't report it.
export interface NpuRawResult {
  text: string;
  ttftMs?: number;
  promptTimeMs?: number;
  decodeTimeMs?: number;
  promptTokens?: number;
  generatedTokens?: number;
  prefillSpeed?: number;
  decodeSpeed?: number;
  stopReason?: string;
}

export interface NpuLoadConfig {
  modelPath: string;
  /** Where the tokenizer is, when it isn't beside the weights. */
  tokenizerPath?: string | null;
  contextSize: number;
}

export interface NpuRuntimeInfo {
  /** Runtime version string, e.g. the GenieX SDK version. */
  version: string | null;
  /** What the runtime says it is executing on ("HTP", "GPU", "CPU"). */
  computeUnit: string | null;
  /** The chipset the runtime reports, when it reports one. */
  soc: string | null;
}

// Probed once and cached for the session: the answer cannot change while the
// process lives, and `supports()` is called often enough that a bridge hop per
// call would be waste.
let probed: NpuRuntimeInfo | null = null;
let probeDone = false;

function moduleAvailable(): boolean {
  return Platform.OS === "android" && !!Npu;
}

/**
 * Whether a usable Qualcomm runtime exists. False in every default build.
 *
 * Synchronous because callers ask it inside `supports()`. It reflects the last
 * completed probe; before the first probe it reports only whether the native
 * module is linked at all, which is the conservative answer (a linked module
 * that later fails to probe simply stops claiming models).
 */
export function isNpuRuntimeAvailable(): boolean {
  if (!moduleAvailable()) return false;
  return probeDone ? probed !== null : false;
}

export function npuRuntimeInfo(): NpuRuntimeInfo | null {
  return probed;
}

/** Runs the one-time probe. Safe to call repeatedly and on any device. */
export async function probeNpuRuntime(): Promise<NpuRuntimeInfo | null> {
  if (probeDone) return probed;
  probeDone = true;
  if (!moduleAvailable()) {
    probed = null;
    return null;
  }
  try {
    probed = (await Npu!.probe()) ?? null;
  } catch {
    // A runtime that cannot answer a probe is a runtime we will not use.
    probed = null;
  }
  return probed;
}

export async function npuLoad(config: NpuLoadConfig): Promise<NpuRuntimeInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  return Npu!.load(JSON.stringify(config));
}

export interface NpuGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  enableThinking?: boolean;
}

export async function npuGenerate(
  messages: { role: string; content: string }[],
  options: NpuGenerateOptions,
): Promise<NpuRawResult> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  // JSON across the bridge rather than a bespoke ReadableMap shape: the message
  // list is the only structured argument, and this keeps the native signature
  // stable while the runtime's own config surface settles.
  return Npu!.generate(JSON.stringify(messages), JSON.stringify(options));
}

/** Stops an in-flight generation. Safe when nothing is running. */
export function npuCancel(): void {
  if (!moduleAvailable()) return;
  try {
    Npu!.cancel();
  } catch {
    // Nothing in flight, or a runtime that has already gone away.
  }
}

export async function npuUnload(): Promise<void> {
  if (!moduleAvailable()) return;
  await Npu!.unload();
}
