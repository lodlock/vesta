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
// — and, when it says no, WHY — and this file reports what it is told.

import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const Npu = NativeModules.VestaNpuModule as NpuNativeModule | undefined;

interface NpuNativeModule {
  /** Runtime present AND usable here. Always resolves; see NpuProbeResult. */
  probe(): Promise<NpuProbeResult>;
  deviceChipset(): Promise<NpuChipsetReport>;
  pull(configJson: string): Promise<NpuBundleInfo>;
  importBundle(configJson: string): Promise<NpuBundleInfo>;
  hubModels(domain: string | null): Promise<NpuHubModelsResult>;
  resolveModelAlias(modelName: string): Promise<string | null>;
  cancelPull(): void;
  bundleInfo(modelName: string): Promise<NpuBundleInfo | null>;
  removeBundle(modelName: string): Promise<void>;
  load(configJson: string): Promise<NpuRuntimeInfo>;
  generate(messagesJson: string, optionsJson: string): Promise<NpuRawResult>;
  cancel(): void;
  unload(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

// Exactly what the runtime reported, nothing more. A field the runtime did not
// give us is ABSENT rather than defaulted — a diagnostics screen showing
// "0 tok/s" that came from a missing measurement is worse than one saying the
// runtime didn't report it.
export interface NpuRawResult {
  text: string;
  /** True when the turn was stopped by the user; profiling is then absent. */
  canceled?: boolean;
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
  /** The GenieX model name ("ai-hub-models/Qwen3-4B-Instruct-2507"). */
  modelName?: string | null;
  /** A direct path, for a bundle the model manager does not know about. */
  modelPath?: string | null;
  /** Where the tokenizer is, when it isn't beside the weights. */
  tokenizerPath?: string | null;
}

export interface NpuRuntimeInfo {
  /** Whether the Hexagon path is actually usable. */
  available?: boolean;
  /** The QAIRT plugin's version, as the SDK reports it. */
  version: string | null;
  /** The compute unit the session was REQUESTED with ("npu"). */
  computeUnit: string | null;
  /** The runtime the session was REQUESTED with ("qairt"). */
  runtimeId?: string | null;
  /** The chipset Android reports, when it reports one. */
  soc: string | null;
  /** Where GenieX keeps its model cache. */
  dataDir?: string | null;
  /** Set only on a load: the manifest's own runtime for this bundle. */
  manifestRuntimeId?: string | null;
  modelPath?: string | null;
  tokenizerPath?: string | null;
  loadMs?: number;
  loaded?: boolean;
  loadedModel?: string | null;
}

/** What `probe()` resolves with — either a runtime, or a reason there isn't one. */
export type NpuProbeResult = NpuRuntimeInfo & { error?: string | null };

export interface NpuChipsetInfo {
  name: string;
  aliases: string[];
}

export interface NpuChipsetReport {
  /** `Build.SOC_MODEL` — "SM8850" on a Snapdragon 8 Elite Gen 5. */
  socModel: string | null;
  board?: string | null;
  hardware?: string | null;
  /**
   * GenieX's own detection. Expected to be null on Android: Qualcomm document
   * host auto-detect as Windows-on-Snapdragon only. Null here is normal and is
   * NOT treated as a failure — Build.SOC_MODEL is the primary source.
   */
  detected?: string | null;
  /** Every chipset the runtime knows, with aliases, or empty. */
  known?: NpuChipsetInfo[];
  error?: string | null;
}

export interface NpuBundleFile {
  /** Path relative to the bundle directory. */
  path: string;
  sizeBytes: number;
  /** Present only for files small enough to hash at install — see the module. */
  sha256?: string | null;
}

export interface NpuBundleInfo {
  modelName: string;
  resolvedName?: string | null;
  modelPath: string;
  modelDir: string;
  tokenizerPath?: string | null;
  /** The manifest's runtime — "qairt" for a real NPU bundle. */
  runtimeId: string | null;
  modelType?: string | null;
  files: NpuBundleFile[];
  totalBytes: number;
}

/** One row of the hub catalogue, as `listHubModels()` returns it. */
export interface NpuHubModel {
  name: string;
  modelType: string;
  /** Every chipset the hub has this model for, in the hub's own spelling. */
  chipsets: string[];
}

/**
 * Either the catalogue or the reason there isn't one.
 *
 * Resolved-with-error rather than thrown: "the hub could not be reached" is an
 * answer the install path has to act on, and it is a different answer from
 * "the hub does not have this model".
 */
export interface NpuHubModelsResult {
  models?: NpuHubModel[];
  error?: string | null;
  nativeMessage?: string | null;
}

export interface NpuImportConfig {
  modelName: string;
  /** The directory or .zip the user picked. */
  localPath: string;
  precision?: string | null;
  displayName?: string | null;
}

export interface NpuPullConfig {
  modelName: string;
  /** Required for the AI Hub path on Android. */
  chipset: string;
  /** Null lets GenieX pick the bundle's only/default precision. */
  precision?: string | null;
  hub?: "AIHUB" | "AUTO" | "HUGGINGFACE" | "LOCALFS";
  displayName?: string | null;
}

export interface NpuPullProgress {
  modelName: string;
  downloaded: number;
  total: number;
  files: { name: string; downloaded: number; total: number }[];
}

// Probed once and cached for the session: the answer cannot change while the
// process lives, and `supports()` is called often enough that a bridge hop per
// call would be waste.
let probed: NpuRuntimeInfo | null = null;
let probeError: string | null = null;
let probeDone = false;

function moduleAvailable(): boolean {
  return Platform.OS === "android" && !!Npu;
}

/**
 * Whether a usable Qualcomm runtime exists. False in every default build.
 *
 * Synchronous because callers ask it inside `supports()`. It reflects the last
 * completed probe; before the first probe it reports false, which is the
 * conservative answer (a linked module that later fails to probe simply never
 * starts claiming models).
 */
export function isNpuRuntimeAvailable(): boolean {
  if (!moduleAvailable()) return false;
  return probeDone ? probed !== null : false;
}

/** True when the NPU bridge is COMPILED IN, whether or not it works here. */
export function isNpuBuild(): boolean {
  return moduleAvailable();
}

export function npuRuntimeInfo(): NpuRuntimeInfo | null {
  return probed;
}

/**
 * Why there is no usable runtime — the native side's own words, not a guess.
 * Null when the runtime is fine, or when nothing has been probed yet.
 */
export function npuUnavailableReason(): string | null {
  return probeError;
}

/** Runs the one-time probe. Safe to call repeatedly and on any device. */
export async function probeNpuRuntime(): Promise<NpuRuntimeInfo | null> {
  if (probeDone) return probed;
  probeDone = true;
  if (!moduleAvailable()) {
    probed = null;
    probeError = null; // not a failure: this build simply has no NPU bridge
    return null;
  }
  try {
    const result = await Npu!.probe();
    if (!result || result.available !== true) {
      probed = null;
      probeError = result?.error ?? "The Qualcomm runtime did not start on this device.";
      return null;
    }
    probed = result;
    probeError = null;
  } catch (err) {
    // A runtime that cannot answer a probe is a runtime we will not use.
    probed = null;
    probeError = err instanceof Error ? err.message : String(err);
  }
  return probed;
}

/** Forgets the cached probe. Only for tests. */
export function resetNpuProbeForTests(): void {
  probed = null;
  probeError = null;
  probeDone = false;
}

export async function npuDeviceChipset(): Promise<NpuChipsetReport | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.deviceChipset();
  } catch {
    return null;
  }
}

export async function npuLoad(config: NpuLoadConfig): Promise<NpuRuntimeInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  return Npu!.load(JSON.stringify(config));
}

export interface NpuGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  enableThinking?: boolean;
  /** Off when nothing is watching, to save a bridge hop per token. */
  streamTokens?: boolean;
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

// ── Bundle install ───────────────────────────────────────────────────────

export async function npuPull(config: NpuPullConfig): Promise<NpuBundleInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  return Npu!.pull(JSON.stringify(config));
}

/**
 * Registers a bundle the user already has, through the manager's own LOCALFS
 * source — the same validation, measurement and hashing a downloaded bundle
 * gets, differing only in where the bytes came from.
 */
export async function npuImportBundle(
  config: NpuImportConfig,
): Promise<NpuBundleInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  return Npu!.importBundle(JSON.stringify(config));
}

/**
 * The hub's own catalogue. Null when there is no bridge to ask.
 *
 * @param domain Optional hub domain filter; null asks for everything.
 */
export async function npuHubModels(
  domain: string | null = null,
): Promise<NpuHubModelsResult | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.hubModels(domain);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** What the manager resolves a model alias to, or null when it cannot. */
export async function npuResolveAlias(modelName: string): Promise<string | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.resolveModelAlias(modelName);
  } catch {
    return null;
  }
}

export function npuCancelPull(): void {
  if (!moduleAvailable()) return;
  try {
    Npu!.cancelPull();
  } catch {
    // Nothing downloading.
  }
}

export async function npuBundleInfo(modelName: string): Promise<NpuBundleInfo | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.bundleInfo(modelName);
  } catch {
    return null;
  }
}

export async function npuRemoveBundle(modelName: string): Promise<void> {
  if (!moduleAvailable()) return;
  await Npu!.removeBundle(modelName);
}

// ── Events ───────────────────────────────────────────────────────────────

// One emitter for the module, created lazily: constructing a NativeEventEmitter
// over an undefined module throws on Android, and a default build has no module.
let emitter: NativeEventEmitter | null = null;

function eventEmitter(): NativeEventEmitter | null {
  if (!moduleAvailable()) return null;
  if (!emitter) emitter = new NativeEventEmitter(NativeModules.VestaNpuModule);
  return emitter;
}

export function onNpuToken(handler: (token: string) => void): () => void {
  const sub = eventEmitter()?.addListener("vestaNpuToken", (e: { token?: string }) => {
    if (e?.token) handler(e.token);
  });
  return () => sub?.remove();
}

export function onNpuPullProgress(
  handler: (progress: NpuPullProgress) => void,
): () => void {
  const sub = eventEmitter()?.addListener("vestaNpuPullProgress", handler);
  return () => sub?.remove();
}
