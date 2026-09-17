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

import { aiHubDisplayName } from "../models/npu-hub";
import type { PullabilityReport } from "../models/npu-pullability";

const Npu = NativeModules.VestaNpuModule as NpuNativeModule | undefined;

interface NpuNativeModule {
  /** Runtime present AND usable here. Always resolves; see NpuProbeResult. */
  probe(): Promise<NpuProbeResult>;
  deviceChipset(): Promise<NpuChipsetReport>;
  pull(configJson: string): Promise<NpuBundleInfo>;
  importBundle(configJson: string): Promise<NpuBundleInfo>;
  hubModels(chipset: string | null): Promise<NpuHubModelsResult>;
  hubPullability(): Promise<PullabilityReport>;
  resolveModelAlias(modelName: string): Promise<string | null>;
  logDiagnostic(message: string): void;
  hubCacheReport(configJson: string): Promise<NpuHubCacheReport>;
  hubListProbe(configJson: string): Promise<NpuHubListProbe>;
  genieXLogReport(configJson: string): Promise<NpuGenieXLogReport>;
  installedReport(configJson: string): Promise<NpuInstalledReport>;
  cancelPull(): void;
  bundleInfo(modelName: string): Promise<NpuBundleInfo | null>;
  removeBundle(modelName: string): Promise<void>;
  load(configJson: string): Promise<NpuRuntimeInfo>;
  loadLlamaCpp(configJson: string): Promise<NpuRuntimeInfo>;
  externalImportDir(): Promise<string | null>;
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

/**
 * A load on the GenieX **llama.cpp** lane (spike). Separate from
 * {@link NpuLoadConfig} because the two runtimes take different settings and
 * neither set is valid for the other: QAIRT rejects a non-zero `nCtx`, and
 * llama.cpp needs one.
 */
export interface NpuLlamaCppLoadConfig {
  /**
   * The GenieX model name the import registered ("local/gemma-4-e2b-q4-0").
   * Required: this lane only loads a model the model manager owns, because
   * only the manager can say which runtime the model is for.
   */
  modelName: string;
  /**
   * `"hybrid"` (default), `"npu"`, `"gpu"` or `"cpu"`.
   *
   * Never omitted on the wire — see {@link npuLoadLlamaCppRequest}.
   */
  computeUnit?: GenieXComputeUnit;
  /** llama.cpp's `n_ctx`. Defaults to 4096 on the native side. */
  contextSize?: number;
}

/** The compute-unit aliases `sdk/src/device.cpp` accepts. */
export type GenieXComputeUnit = "cpu" | "gpu" | "npu" | "hybrid";

/**
 * What GenieX said about device binding during a llama.cpp load.
 *
 * Evidence, not a verdict. `hybrid` resolves to an EMPTY device id, and
 * `resolve_devices()` returns before logging anything in that case — so an
 * absent "HTP0" under hybrid means nothing was logged, not that nothing bound.
 * Load once with `computeUnit: "npu"` to get the explicit sentence.
 */
export interface NpuDeviceSelection {
  /** The matching GenieX log lines, verbatim. */
  lines?: string[];
  /** An `HTP0`-shaped ggml device name appeared. */
  sawHtpDevice?: boolean;
  /** The ggml Hexagon backend logged at all (`ggml-hex: …`). */
  sawHexagonBackend?: boolean;
  /** GenieX resolved a device list and none of it existed. */
  sawNoValidDevices?: boolean;
  /** False when the capture could not be narrowed to this load. */
  scopedToThisLoad?: boolean;
  error?: string | null;
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
  /** The two paths the session was actually CREATED with. */
  modelPath?: string | null;
  tokenizerPath?: string | null;
  /**
   * Set only on a load: `ModelPaths` as the model manager answered it, whole.
   * Kept beside the two paths above so a diagnostics screen can show what
   * GenieX said next to what the create used — the load failure that produced
   * `failed to open file: null` was invisible precisely because only the
   * second half was ever reported.
   */
  resolvedModelName?: string | null;
  modelDir?: string | null;
  manifestModelPath?: string | null;
  manifestTokenizerPath?: string | null;
  manifestMmprojPath?: string | null;
  manifestModelType?: string | null;
  loadMs?: number;
  loaded?: boolean;
  loadedModel?: string | null;
  /** Set only on a llama.cpp load: `n_ctx` the session was created with. */
  contextSize?: number;
  /** Set only on a llama.cpp load: what the runtime logged about devices. */
  deviceSelection?: NpuDeviceSelection;
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
  /** `ModelPaths.mmproj_path` — null for a text-only bundle. */
  mmprojPath?: string | null;
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

/** What a cached manifest says about one model, without shipping the manifest. */
export interface NpuManifestAnalysis {
  parseError?: string | null;
  topLevelKeys?: string[];
  /** Every top-level key containing "version", with its value. */
  versionFields?: Record<string, string | null>;
  /** Which key held the model array, so a schema change is visible. */
  modelsKey?: string | null;
  modelCount?: number;
  /** A model whose display_name matches exactly. */
  exactDisplayName?: boolean;
  /** A model whose id matches exactly. */
  exactId?: boolean;
  /** Whole entries whose id or display_name contains the needle. Logcat only. */
  matches?: string[];
  /**
   * The same entries, reduced to the fields a pull's manifest inference reads:
   * id, display_name, domain, supported_runtimes, supported_chipsets.
   *
   * This is the line that answers whether an entry the hub lists actually
   * carries a `RUNTIME_GENIEX_QAIRT` asset for this chipset — the two runtime
   * values in libgeniex.so are that and `RUNTIME_GENIE`, and this SDK consumes
   * only the first.
   */
  matchSummaries?: string[];
}

/**
 * listHubModels(), with the manifest's stat taken either side of it.
 *
 * If the listing refreshes or replaces the file the pull then reads, these two
 * differ — which would explain a catalogue and a download disagreeing about
 * the same model without either being wrong.
 */
export interface NpuHubListProbe {
  /** The chipset the listing was filtered by; absent means it was not. */
  chipset?: string | null;
  before?: { exists: boolean; sizeBytes: number; modifiedAt: number };
  after?: { exists: boolean; sizeBytes: number; modifiedAt: number };
  count?: number;
  models?: NpuHubModel[];
  error?: string | null;
}

/** One file in the runtime's own hub-metadata cache. */
export interface NpuCacheFile {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  /** Present only for small .json — platform.json fits, the manifest does not. */
  content?: string | null;
  /** The targeted answer for any .json, however large. */
  analysis?: NpuManifestAnalysis;
}

/**
 * Where the AI Hub data this app is acting on actually came from.
 *
 * The runtime caches its hub metadata under our own data directory, so the
 * manifests `listHubModels()` and `pull()` consulted are files we own and may
 * read. This is the only way to answer whether the two are looking at the same
 * release — the SDK exposes no API for it.
 */
export interface NpuHubCacheReport {
  env?: {
    GENIEX_AIHUBBASEURL: string | null;
    GENIEX_AIHUBVERSION: string | null;
    GENIEX_DATADIR: string | null;
    /** "set" or "unset". The value is never read or reported. */
    GENIEX_HFTOKEN: string | null;
  };
  dataDir?: string;
  dataDirExists?: boolean;
  files?: NpuCacheFile[];
  error?: string | null;
}

/**
 * GenieX's own native logging, as captured from this process's logcat.
 *
 * There is no verbosity setting behind this and none was added: `GENIEX_LOG`
 * does not exist in geniex-android 0.4.0, `geniex_log_level` is a `.bss` int
 * that stays 0 (TRACE) because nothing in the AAR writes it, and the SDK's own
 * `JNI_OnLoad` has already routed every level — plus stdout and stderr — into
 * logcat under one tag. The native module carries the symbol-level evidence.
 *
 * So this reads what is already there. It does NOT carry the AI Hub endpoint,
 * manifest URL, cache hits or HTTP status: the Rust model manager reaches the
 * log sink through six call sites and none of them writes those. Those stay
 * the job of {@link NpuHubCacheReport}.
 */
export interface NpuGenieXLogReport {
  /** The logcat tag every GenieX line arrives under. */
  tag?: string;
  /** The exact argv that produced this capture. */
  command?: string;
  /** Whether the SDK was up when the capture was taken. */
  sdkStarted?: boolean;
  initError?: string | null;
  /** The captured lines, credential-shaped values already blanked natively. */
  lines?: string[];
  /** How many lines came back — the newest ones, when the budget bit. */
  lineCount?: number;
  /** How many GenieX lines the buffer held in all. */
  totalLines?: number;
  /** True when the budget bit, so older lines were dropped from this capture. */
  truncated?: boolean;
  byPriority?: { V: number; D: number; I: number; W: number; E: number };
  /** JNI_OnLoad's own stdout/stderr probes — proof the redirect is live. */
  sawStdoutSelfTest?: boolean;
  sawStderrSelfTest?: boolean;
  /** A VERBOSE line got through, so the TRACE gate is still open. */
  verboseSeen?: boolean;
  error?: string | null;
}

/**
 * One identity, as every read-only GenieX API answers about it.
 *
 * `getPaths` is the field that matters: `pull()` already uses a non-null
 * `getPaths()` as its own completion test, so a true here means the manager
 * finished the download and moved the bundle out of `.inflight/`.
 */
export interface NpuInstalledProbe {
  /** The identity we asked with. */
  asked: string;
  /** Whether `list()` — the runtime's own register — holds this name. */
  inList: boolean;
  resolveAlias?: string | null;
  /** True when `getPaths()` resolved. The download-finished signal. */
  getPaths?: boolean;
  getPathsError?: string | null;
  /** `ModelPaths.model_name` — the manager's own key, which may differ. */
  resolvedName?: string | null;
  modelPath?: string | null;
  modelDir?: string | null;
  tokenizerPath?: string | null;
  mmprojPath?: string | null;
  runtimeId?: string | null;
  modelType?: string | null;
  getType?: string | null;
  dirExists?: boolean;
  fileCount?: number;
  totalBytes?: number;
  files?: { path: string; sizeBytes: number }[];
  /** Exactly the set `checkBundle()` reads as "the download did not finish". */
  zeroLengthFiles?: string[];
}

/**
 * What GenieX considers installed, read without changing anything.
 *
 * Nothing here pulls, removes, cleans or loads — it exists to be run over a
 * bundle whose fate is undecided.
 */
export interface NpuInstalledReport {
  installed?: string[];
  installedCount?: number;
  probes?: NpuInstalledProbe[];
  error?: string | null;
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
  return Npu!.load(JSON.stringify(npuLoadRequest(config)));
}

/**
 * The load request as it will actually be serialised: a key the caller left
 * null is DROPPED, not sent as a JSON null.
 *
 * `JSON.stringify` keeps nulls, and Android's org.json then reads one back as
 * the four-character string "null" — `optString(key, fallback)` returns
 * `JSON.toString()` of the JSONObject.NULL sentinel and never takes the
 * fallback branch. That is how `tokenizerPath: null` reached QAIRT as a path
 * called "null" and killed the session with
 * `qwen3::makePipeline failed: failed to open file: null`.
 *
 * The native side no longer reads a JSON null as a value (see
 * `VestaNpuModule.stringOrNull`). This is the other half of the same fix, and
 * the half that can be tested without a Qualcomm device.
 *
 * Exported for the tests.
 */
export function npuLoadRequest(config: NpuLoadConfig): NpuLoadConfig {
  return withoutNulls(config);
}

/** The compute unit an omitted one means on the llama.cpp lane. */
export const DEFAULT_GENIEX_COMPUTE_UNIT: GenieXComputeUnit = "hybrid";

/**
 * The llama.cpp load request as it will be serialised.
 *
 * The one rule that is not shared with {@link npuLoadRequest}: `computeUnit` is
 * always present. GenieX treats an absent or null compute unit as `npu` —
 *
 *     if (alias.empty() || alias == kAliasAuto) { alias = kAliasNPU; }
 *     — sdk/src/device.cpp, v0.4.0
 *
 * — which pins one HTP0 session, NOT the hybrid scheduler the SDK's own KDoc
 * claims null selects. So the alias is filled in here and sent explicitly, and
 * null is never used as a stand-in for hybrid.
 *
 * Exported for the tests.
 */
export function npuLoadLlamaCppRequest(
  config: NpuLlamaCppLoadConfig,
): NpuLlamaCppLoadConfig {
  return withoutNulls({
    ...config,
    computeUnit: config.computeUnit ?? DEFAULT_GENIEX_COMPUTE_UNIT,
  });
}

/**
 * Creates a GenieX llama.cpp session over an imported GGUF.
 *
 * Distinct from {@link npuLoad}, which is the QAIRT path. Both end up holding
 * the same single native `LlmWrapper`, so loading either releases the other.
 */
export async function npuLoadLlamaCpp(
  config: NpuLlamaCppLoadConfig,
): Promise<NpuRuntimeInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm GenieX runtime in this build.");
  return Npu!.loadLlamaCpp(JSON.stringify(npuLoadLlamaCppRequest(config)));
}

/**
 * A directory `adb push` can write and this app can read without a runtime
 * permission, for side-loading a GGUF into the spike. Null when there is no
 * runtime in this build, or when external storage is unavailable.
 */
export async function npuExternalImportDir(): Promise<string | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.externalImportDir();
  } catch {
    return null;
  }
}

/**
 * One request object with every null and undefined key REMOVED.
 *
 * The contract is deliberately narrow: only the two values JavaScript uses to
 * mean "nothing" are dropped. The four-character STRING "null" is a value like
 * any other and survives — if a hub ever names a precision that, it must reach
 * the runtime spelled the way it was given.
 */
function withoutNulls<T extends object>(config: T): T {
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && value !== undefined) request[key] = value;
  }
  return request as T;
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

/**
 * The one place an AI Hub pull request is finalised before it crosses to the
 * runtime — so every catalogue model gets the same treatment, not just the one
 * the Models screen happens to feature.
 *
 * The only thing decided here is `display_name`. Callers pass a human-readable
 * card title (`Qwen3 4B Instruct 2507`), and that is what has been going out on
 * the wire — it is the string GenieX 0.4.0 quotes back in `model … not found on
 * hub`. For a row `listHubModels()` returned, the hub's real display name is
 * recoverable exactly from the identifier, so it is derived instead. See
 * {@link aiHubDisplayName} for the rule; it is a prefix removal and nothing
 * more. A name from any other hub keeps whatever the caller passed, unchanged.
 *
 * Nothing else about the request is touched: model_name stays the full string
 * the catalogue returned, and hub, chipset and precision are passed through.
 */
export async function npuPull(config: NpuPullConfig): Promise<NpuBundleInfo> {
  if (!moduleAvailable()) throw new Error("No Qualcomm NPU runtime in this build.");
  return Npu!.pull(JSON.stringify(npuPullRequest(config)));
}

/**
 * The pull request as it will actually be serialised.
 *
 * `aiHubPullRequest` decides the one field this path decides — `display_name`
 * — and this drops the keys the caller left null so none of them crosses as a
 * JSON null. In practice that is exactly `precision`: `NpuInstallSpec` types
 * `modelName`, `chipset` and `displayName` as non-null strings, and a null
 * precision is the hub case, meaning "let GenieX pick the bundle's only one".
 * It was reaching the runtime as the precision "null".
 *
 * Exported for the tests.
 */
export function npuPullRequest(config: NpuPullConfig): NpuPullConfig {
  return withoutNulls(aiHubPullRequest(config));
}

/** Exported for the tests: the request as it will actually be serialised. */
export function aiHubPullRequest(config: NpuPullConfig): NpuPullConfig {
  const derived = aiHubDisplayName(config.modelName);
  if (derived === null) return config;
  return { ...config, displayName: derived };
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
 * ## Unfiltered, deliberately
 *
 * `listHubModels` in geniex-android 0.4.0 is `(chipset: String? = null)` — the
 * parameter is named `chipset` in the released bytecode, carries `@Nullable`,
 * and has a Kotlin default, which is null. So absent is the SDK's OWN
 * "everything the hub has" query, not a gap in it, and that is what this asks
 * for: the catalogue whole, filtered against this device afterwards by
 * `breakDownHubModels` where the rule is testable without a Qualcomm phone.
 * On device that is 19 models returned and 14 compatible here.
 *
 * A string is only meaningful if it is a key in the runtime's platform.json —
 * anything else fails the whole call with `chipset "…" not found in
 * platform.json`, and "" fails separately as `empty chipset`. The SoC id
 * (`SM8850`) and AI Hub's asset key are different vocabularies (see
 * CompatibleHubModel), so neither is a safe guess at that key, and nothing
 * here guesses.
 *
 * @param chipset A platform.json chipset key. Null — the default — asks for
 *   every model the hub has.
 */
export async function npuHubModels(
  chipset: string | null = null,
): Promise<NpuHubModelsResult | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.hubModels(chipset);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Which hub models Qualcomm actually distributes a bundle for.
 *
 * Read out of the cached release manifest in our own data directory — no
 * network, no pull attempt, no internal SDK class. `listHubModels()` cannot
 * answer this: it filters on runtime and chipset only, so it returns models
 * whose `manifest_urls.release_assets` is empty and which no pull can ever
 * fetch. See npu-pullability.ts for the rule and where it comes from.
 *
 * Null when there is no bridge; a report with no models when the manifest has
 * not been fetched yet. Both mean "unknown", never "not distributed".
 */
export async function npuHubPullability(): Promise<PullabilityReport | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.hubPullability();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Writes a diagnostic block to logcat under the VestaNpu tag.
 *
 * So one `adb logcat -s VestaNpu` capture carries the identity probe, the pull
 * request and its failure together — three things that have to be read side by
 * side and were landing under two different tags.
 *
 * Silently does nothing in a default build; the caller logs to the console
 * either way, so nothing is lost.
 */
export function npuLogDiagnostic(message: string): void {
  if (!moduleAvailable()) return;
  try {
    Npu!.logDiagnostic(message);
  } catch {
    // A logging call must never be the thing that breaks a screen.
  }
}

/**
 * Reads the runtime's own hub-metadata cache. Null in a default build.
 *
 * Read-only, and it triggers no fetch: the point is to report what the app has
 * already acted on, not to go and get a fresh answer that nothing else saw.
 */
export async function npuHubCacheReport(query: {
  /** Substring to search ids and display names for, case-insensitively. */
  needle: string;
  /** An exact display_name to test for. */
  displayName: string;
  /** An exact id to test for. */
  id: string;
}): Promise<NpuHubCacheReport | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.hubCacheReport(JSON.stringify(query));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lists hub models and stats the manifest either side of the call.
 *
 * The stat is the only thing this has that `npuHubModels()` does not, and it
 * answers one question: did the listing rewrite the file the pull then reads?
 *
 * @param chipset the SDK's own parameter, with the SDK's own meaning — see
 *   `npuHubModels`. Null is the supported unfiltered query. A string must be a
 *   platform.json key the runtime supplied; this is not a place to try
 *   spellings, because a rejected guess fails the call instead of measuring
 *   anything.
 */
export async function npuHubListProbe(
  chipset: string | null = null,
): Promise<NpuHubListProbe | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.hubListProbe(JSON.stringify(npuHubListProbeRequest(chipset)));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The probe request as it will actually be serialised.
 *
 * "No chipset" is the whole point of the unfiltered probe, and it must arrive
 * as no chipset — omitted from the object, not present with a null value.
 * Sent as a JSON null it arrived as the string "null", because that is what
 * Android's `optString` does with the JSON null sentinel, and the runtime then
 * went looking for a chipset by that name: `chipset "null" not found in
 * platform.json`. The key is therefore dropped here AND read with
 * `stringOrNull` natively — either alone would be enough, and both is what
 * keeps it true after the next edit to one of them.
 *
 * A real chipset string is passed straight through, untouched.
 *
 * Exported for the tests.
 */
export function npuHubListProbeRequest(
  chipset: string | null,
): { chipset?: string | null } {
  return withoutNulls({ chipset });
}

/**
 * Reads back what GenieX has already written to logcat. Null in a default build.
 *
 * Nothing is enabled or configured on the way in — the SDK logs at TRACE from
 * its first instruction and routes it to logcat itself. See the native module
 * for why there is no level to set.
 */
export async function npuGenieXLogReport(
  options: { maxLines?: number } = {},
): Promise<NpuGenieXLogReport | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.genieXLogReport(JSON.stringify(options));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Asks GenieX what it considers installed. Null in a default build.
 *
 * Read-only by construction — see the native module. Safe to run over a bundle
 * whose fate is undecided, which is the only reason it exists.
 *
 * @param names identities to probe even if `list()` does not hold them. Asking
 *   for a name that is absent is the only way to get "it is missing" as an
 *   answer rather than as an omission.
 */
export async function npuInstalledReport(
  names: string[] = [],
): Promise<NpuInstalledReport | null> {
  if (!moduleAvailable()) return null;
  try {
    return await Npu!.installedReport(JSON.stringify({ names }));
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
