// LLM Engine — TypeScript adapter wrapping llama.rn into Vesta's interface.
// Handles model lifecycle (load/unload) and completion with streaming support.

import {
  initLlama,
  loadLlamaModelInfo,
  LlamaContext,
  type RNLlamaOAICompatibleMessage,
  type NativeCompletionResult,
  type TokenData,
} from "llama.rn";
import type { LlmOptions, GenerateOptions, ModelInfo } from "./types";
import { npuBackend } from "./backends/npu-instance";
import { genieXLlamaCppBackend } from "./backends/geniex-llamacpp-instance";
import { routeModel } from "./backends/routing";
import type { BackendModelRef, ModelBackend } from "./backends/types";
import type { ModelBackendId } from "../models/types";

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  text: string;
  // llama.rn's reasoning- and tool-call-filtered text. Empty when the runtime
  // could not parse a reasoning format for this model, so treat it as a hint
  // and not a guarantee — assist mode sanitizes on top of it.
  content: string;
  reasoningContent: string;
  tokensPredicted: number;
  tokensEvaluated: number;
  timings: {
    promptMs: number;
    predictedMs: number;
    predictedPerSecond: number;
  };
  stoppedByLimit: boolean;
  // True when this completion ended because the user tapped Stop (vs. a natural
  // finish or token-limit). Lets callers avoid follow-up work after a stop.
  stoppedByUser: boolean;
}

const DEFAULT_OPTIONS: Required<
  Pick<LlmOptions, "contextSize" | "gpuLayers" | "threads" | "useMlock">
> = {
  contextSize: 4096,
  gpuLayers: 0,
  threads: 4,
  useMlock: false,
};

const DEFAULT_GENERATE: Required<
  Pick<
    GenerateOptions,
    | "maxTokens"
    | "temperature"
    | "topP"
    | "stopSequences"
    | "penaltyRepeat"
    | "penaltyLastN"
  >
> = {
  maxTokens: 4096,
  temperature: 0.7,
  topP: 0.95,
  stopSequences: [],
  // Anti-loop defaults. 1.1 is the conventional llama.cpp repeat penalty; the
  // engine default is 1.0 (off), which lets greedy/low-temp decoding degenerate
  // into endless repetition on long chat answers.
  penaltyRepeat: 1.1,
  penaltyLastN: 256,
};

// --- Async mutex: serializes load/unload/generate to prevent races ---
let operationLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = operationLock;
  operationLock = next;
  return prev.then(fn).finally(() => release!());
}

let context: LlamaContext | null = null;
let currentModelPath: string | null = null;
// The NPU session, when one is loaded. Mutually exclusive with `context` —
// loading either releases the other, because both are multi-gigabyte
// allocations and a phone that holds two of them holds neither for long.
let npuModel: import("./backends/types").BackendModelRef | null = null;
// The GenieX llama.cpp session (spike), when one is loaded. Kept in its OWN
// variable rather than folded into `npuModel`: the two share the native
// wrapper and its lifecycle, but not their claims. `isNpuSession()` means
// QAIRT, and a GGUF running across HTP and CPU must not turn it true.
let genieXLlamaModel: import("./backends/types").BackendModelRef | null = null;
let currentContextSize: number = DEFAULT_OPTIONS.contextSize;
// Set by stopGeneration(), read+cleared by the active generate(). Distinguishes a
// user-initiated Stop from a natural finish (the native layer exposes no such flag).
let stopRequested = false;
// True once any completion has touched the KV cache since the last model load
// (or explicit clear). Restoring a session file over live conversation state
// would discard it and force a full history re-prefill on the next turn, so
// loadSessionFile only runs while this is false.
let kvStateDirty = false;
// KV cache tensor type of the loaded context ("f16" default, "q8_0" when the
// perf setting is on). Session files store KV cells in this type, so the
// session cache folds it into its key — a perf toggle must invalidate the
// file deterministically instead of failing the load at the llama.cpp layer.
let currentKvCacheType = "f16";

// Stats from the most recent completion, for the diagnostics screen. promptMs +
// promptTokens are the JS-visible proxy for prefill work: a warm KV append
// evaluates only the new tokens (small), a cold turn re-prefills the whole
// prompt (large). null until the first completion of this process.
export interface LastCompletionStats {
  promptMs: number;
  promptTokens: number; // tokens_evaluated — the prefill this turn
  /** tokens the runtime reused from the KV cache; null when it didn't say. */
  cachedTokens: number | null;
  predictedTokens: number;
  predictedPerSecond: number;
}
let lastCompletion: LastCompletionStats | null = null;

export function getLastCompletion(): LastCompletionStats | null {
  return lastCompletion;
}

// Rough token estimate (~3 chars/token is conservative for Italian/English
// BPE) plus per-message chat-template overhead. Used to decide whether
// context-window-sensitive background work (memory extraction, session-cache
// save) is safe to run — precision doesn't matter.
const TEMPLATE_TOKENS_PER_MESSAGE = 8;

export function estimatePromptTokens(messages: CompletionMessage[]): number {
  return messages.reduce(
    (n, m) => n + Math.ceil(m.content.length / 3) + TEMPLATE_TOKENS_PER_MESSAGE,
    0,
  );
}

// The load configuration each GenieX session was actually built with, as its
// backend described it at the time. Kept beside the model ref because model
// identity alone does not determine a session — see ModelBackend.loadFingerprint.
let npuFingerprint: string | null = null;
let genieXLlamaFingerprint: string | null = null;

/**
 * The load configuration `backend` would use for `model`, or null when it has
 * none that varies.
 *
 * Goes through the `ModelBackend` interface rather than the concrete class so
 * `loadFingerprint` stays genuinely optional: a backend that declares none is
 * saying "my sessions are determined by the model alone", and null on both
 * sides of a comparison is the same-model no-op preserved.
 */
function fingerprintFor(
  backend: ModelBackend,
  model: BackendModelRef,
): string | null {
  return backend.loadFingerprint?.(model) ?? null;
}

/**
 * Whether the session already loaded is the one a load of `model` would produce
 * right now — same model AND same load configuration.
 *
 * The single definition of "nothing to do", shared by `loadModel()` and by the
 * Models screen's activate(). They each had their own before, both comparing
 * file paths and nothing else, and so both answered "already loaded" about a
 * session built with a different compute unit. A setting that silently fails to
 * apply is worse than one that is slow to: the user gets a number from the
 * hardware they did not select, labelled as the hardware they did.
 */
export function sessionMatches(model: BackendModelRef): boolean {
  // A session on the WRONG runtime never matches, whatever its path says.
  // The GenieX lane and llama.rn address the same bytes on disk, so a file-path
  // comparison alone called a CPU session a match for a Hexagon model and left
  // re-activation with nothing to do — the state that turned a one-off bad
  // restore into one that could not be corrected from the Models screen.
  if (loadedBackendId() !== null && loadedBackendId() !== routeModel(model).lane) {
    return false;
  }
  if (npuModel) {
    return (
      npuModel.filePath === model.filePath &&
      fingerprintFor(npuBackend, model) === npuFingerprint
    );
  }
  if (genieXLlamaModel) {
    return (
      genieXLlamaModel.filePath === model.filePath &&
      fingerprintFor(genieXLlamaCppBackend, model) === genieXLlamaFingerprint
    );
  }
  // llama.rn holds no configuration this can vary: options that change the
  // context are already folded into the path-keyed reload by its callers.
  return context !== null && currentModelPath === model.filePath;
}

export function getModelInfo(): ModelInfo {
  return {
    loaded: context !== null || genieXSession() !== null,
    path: currentModelPath ?? undefined,
  };
}

export function isLoaded(): boolean {
  return context !== null || genieXSession() !== null;
}

/**
 * Which runtime actually owns the live session, or null when nothing is loaded.
 *
 * Not "which runtime should own it" — that is `routeModel()`, and the whole
 * point of having both is that they can disagree. Diagnostics prints them side
 * by side, because "loaded: yes" under a model registered for Hexagon while
 * llama.rn holds the session is the exact shape of the bug this answers.
 */
export function loadedBackendId(): ModelBackendId | null {
  if (npuModel) return "qualcomm_npu";
  if (genieXLlamaModel) return "geniex_llama_cpp";
  return context !== null ? "llama_cpp" : null;
}

/**
 * The GenieX session that is loaded, with the backend that owns it.
 *
 * One native `LlmWrapper` serves both GenieX lanes, so at most one of these is
 * ever set — but they are tracked separately because they answer to different
 * backends and may claim different things about the hardware.
 */
function genieXSession(): {
  model: import("./backends/types").BackendModelRef;
  backend: import("./backends/types").ModelBackend;
} | null {
  if (npuModel) return { model: npuModel, backend: npuBackend };
  if (genieXLlamaModel) {
    return { model: genieXLlamaModel, backend: genieXLlamaCppBackend };
  }
  return null;
}

/**
 * Whether the loaded runtime can save and restore a prefix KV session.
 *
 * llama.cpp can; the Qualcomm path cannot — a QAIRT context binary has its KV
 * layout compiled in and GenieX exposes no state save/load at all. The session
 * cache asks this instead of discovering it as a thrown error per turn, which
 * would delete the cache files a llama.cpp model still wants.
 */
export function supportsKvSessionCache(): boolean {
  return context !== null;
}

/** True when the loaded model is running on the Qualcomm NPU. */
export function isNpuSession(): boolean {
  return npuModel !== null;
}

// Context window (n_ctx) of the loaded model. Callers sizing optional
// background work (e.g. memory extraction) use this to avoid pushing past
// n_ctx, where ctx_shift would evict the cached prompt prefix.
export function getContextSize(): number {
  return currentContextSize;
}

export function loadModel(
  modelPath: string,
  options?: LlmOptions,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return withLock(async () => {
    const backendModel = options?.backendModel;
    // Which lane this model BELONGS to — its row's own `backend` where it has
    // one, the artifact-and-capability order where it does not. Asked once,
    // before anything is loaded, so that no branch below can be reached by a
    // model that a different lane has a claim on. See backends/routing.ts.
    const lane = backendModel ? routeModel(backendModel).lane : "llama_cpp";

    // A Qualcomm bundle goes to the QAIRT backend and nowhere else. The
    // decision comes from the registry row, not from the path or the file name
    // — a `.bin` could be anything, and guessing here is how a context binary
    // ends up being handed to llama.cpp.
    if (backendModel && lane === "qualcomm_npu") {
      const fingerprint = fingerprintFor(npuBackend, backendModel);
      // Same model AND same load configuration. QAIRT declares no fingerprint
      // (its compute unit is pinned in Kotlin), so both sides are null and this
      // stays the plain same-model no-op it has always been.
      if (
        npuModel &&
        npuModel.filePath === modelPath &&
        fingerprint === npuFingerprint
      ) {
        return;
      }
      await releaseAll();
      // No fallback: if the NPU cannot take it, the caller hears why. Quietly
      // loading it on the CPU instead would make every later "NPU" label a lie.
      await npuBackend.load(backendModel);
      npuModel = backendModel;
      npuFingerprint = fingerprint;
      currentModelPath = modelPath;
      currentContextSize = backendModel.contextSize;
      // The Qualcomm path has no llama.cpp KV cache to describe, and saying
      // "f16" about one that doesn't exist would be a made-up fact.
      currentKvCacheType = "n/a";
      kvStateDirty = false;
      return;
    }

    // A GGUF the GenieX model manager owns goes to the GenieX llama.cpp lane.
    //
    // This used to ask `genieXLlamaCppBackend.supports()` directly, and that
    // was the restore bug: `supports()` is false until the runtime probe has
    // finished, so on a cold start a GenieX-managed GGUF fell through to
    // llama.rn — which loaded the same file happily, on the CPU, under the
    // accelerated model's name. Routing now reads the row's declared runtime,
    // which does not move between boots, and a declared row that this lane
    // cannot load fails here with the lane's own words rather than landing
    // below. Every other GGUF still reaches llama.rn by falling through.
    if (backendModel && lane === "geniex_llama_cpp") {
      const fingerprint = fingerprintFor(genieXLlamaCppBackend, backendModel);
      // The reason this is not a path comparison: the compute unit is chosen
      // per load, so the same file loaded as `npu` and as `hybrid` are two
      // different sessions on two different arrangements of hardware. Returning
      // early on the path alone left the old session in place and every later
      // label describing the new selection.
      if (
        genieXLlamaModel &&
        genieXLlamaModel.filePath === modelPath &&
        fingerprint === genieXLlamaFingerprint
      ) {
        return;
      }
      await releaseAll();
      await genieXLlamaCppBackend.load(backendModel);
      genieXLlamaModel = backendModel;
      genieXLlamaFingerprint = fingerprint;
      currentModelPath = modelPath;
      currentContextSize = backendModel.contextSize;
      // GenieX exposes no KV state save/load from Kotlin at 0.4.0, so there is
      // no session cache on this path either — see supportsKvSessionCache.
      currentKvCacheType = "n/a";
      kvStateDirty = false;
      return;
    }

    if (context && currentModelPath === modelPath) return; // already loaded

    // Release whatever was loaded — including an NPU session, which a GGUF
    // load must not leave sitting in memory beside it.
    await releaseAll();

    const opts = { ...DEFAULT_OPTIONS, ...options };
    currentContextSize = opts.contextSize;
    context = await initLlama(
      {
        model: modelPath,
        n_ctx: opts.contextSize,
        n_gpu_layers: opts.gpuLayers,
        n_threads: opts.threads,
        use_mlock: opts.useMlock,
        // Roll the oldest tokens out of the KV cache instead of hard-failing
        // when a long chat exceeds n_ctx (LLM-6).
        ctx_shift: true,
        // Quantize the KV cache when requested (halves KV RAM). V-cache quant
        // needs flash attention, so enable it alongside.
        ...(options?.kvCacheType
          ? {
              cache_type_k: options.kvCacheType,
              cache_type_v: options.kvCacheType,
              flash_attn_type: "on" as const,
            }
          : {}),
        // Only override the embedded template when one is explicitly provided.
        ...(options?.chatTemplate ? { chat_template: options.chatTemplate } : {}),
      },
      onProgress,
    );
    currentModelPath = modelPath;
    currentKvCacheType = options?.kvCacheType ?? "f16";
    kvStateDirty = false;
  });
}

// Synchronous on purpose: the session cache computes its key inside the
// persist fast path, which must not await before reaching the engine lock.
export function getKvCacheType(): string {
  return currentKvCacheType;
}

// Cheap pre-load validation: reads GGUF header/metadata without a full context
// init. Returns ok:false for renamed/truncated/non-GGUF files so callers can
// reject before committing disk + load time.
export async function validateGguf(
  modelPath: string,
): Promise<{ ok: boolean; info?: Record<string, unknown>; error?: string }> {
  try {
    const info = (await loadLlamaModelInfo(modelPath)) as Record<string, unknown>;
    if (!info || Object.keys(info).length === 0) {
      return { ok: false, error: "Not a valid GGUF file." };
    }
    return { ok: true, info };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function unloadModel(): Promise<void> {
  return withLock(releaseAll);
}

/**
 * Releases whichever runtime is holding memory. Always called under the lock.
 *
 * Both branches run: the two are meant to be mutually exclusive, and if a
 * previous failure ever left both set, "release the one I think is loaded"
 * would strand gigabytes.
 */
async function releaseAll(): Promise<void> {
  if (context) {
    await context.release();
    context = null;
  }
  if (npuModel) {
    await npuBackend.unload().catch(() => {});
    npuModel = null;
  }
  if (genieXLlamaModel) {
    await genieXLlamaCppBackend.unload().catch(() => {});
    genieXLlamaModel = null;
  }
  // A released session has no configuration. Leaving these behind would let the
  // next load match against a fingerprint whose session is gone.
  npuFingerprint = null;
  genieXLlamaFingerprint = null;
  currentModelPath = null;
}

export function generate(
  messages: CompletionMessage[],
  options?: GenerateOptions,
  onToken?: (token: string) => void,
): Promise<CompletionResult> {
  return withLock(async () => {
    // Fresh turn: clear any stale stop request so it can't leak across turns.
    stopRequested = false;

    const gx = genieXSession();
    if (gx) {
      const result = await gx.backend.generate(
        messages,
        {
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          ...(options?.enableThinking === false ? { enableThinking: false } : {}),
        },
        onToken,
      );
      // The runtime's own numbers, mapped onto the shape callers already read.
      // Nothing is invented: GenieX reports decode speed and token counts but
      // no separate prompt-eval wall time in this shape, so promptMs stays 0
      // and the diagnostics screen reads TTFT from the run record instead.
      lastCompletion = {
        // GenieX reports TTFT and prefill SPEED but no prompt-eval wall time in
        // this shape, so promptMs stays 0 and the diagnostics screen reads TTFT
        // from the run record instead of deriving a number nobody measured.
        promptMs: 0,
        promptTokens: result.tokensEvaluated ?? 0,
        // There is no KV prefix cache on this path at all — see
        // supportsKvSessionCache. Null says "not applicable", which is what a
        // reader needs; 0 would read as "reused nothing", a different claim.
        cachedTokens: null,
        predictedTokens: result.tokensPredicted,
        predictedPerSecond: result.tokensPerSecond,
      };
      return {
        text: result.text,
        // GenieX's chat template suppresses reasoning at generation rather than
        // separating it afterwards, so there is no second filtered string to
        // hand back and `content` is the same text.
        content: result.content,
        reasoningContent: "",
        tokensPredicted: result.tokensPredicted,
        tokensEvaluated: result.tokensEvaluated ?? 0,
        timings: {
          promptMs: 0,
          predictedMs: 0,
          predictedPerSecond: result.tokensPerSecond,
        },
        stoppedByLimit: false,
        stoppedByUser: result.stoppedByUser === true || stopRequested,
      };
    }

    if (!context) throw new Error("No model loaded");

    const opts = { ...DEFAULT_GENERATE, ...options };
    kvStateDirty = true;

    const llamaMessages: RNLlamaOAICompatibleMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result: NativeCompletionResult = await context.completion(
      {
        messages: llamaMessages,
        n_predict: opts.maxTokens,
        temperature: opts.temperature,
        top_p: opts.topP,
        penalty_repeat: opts.penaltyRepeat,
        penalty_last_n: opts.penaltyLastN,
        stop: opts.stopSequences.length > 0 ? opts.stopSequences : undefined,
        // Pass through only when explicitly set, so the model's default stands otherwise.
        ...(options?.enableThinking === false ? { enable_thinking: false } : {}),
      },
      onToken
        ? (data: TokenData) => {
            if (data.token) onToken(data.token);
          }
        : undefined,
    );

    // Use raw `text` so <think> blocks are preserved for UI rendering.
    // The orchestrator / response-parser strips them when needed for tool parsing.
    const text = result.text;

    lastCompletion = {
      promptMs: result.timings.prompt_ms,
      promptTokens: result.tokens_evaluated,
      // Tokens the runtime got to reuse from the KV cache. The pair
      // (evaluated, cached) is what distinguishes a warm append from a cold
      // re-prefill of a prefix that changed underneath us.
      cachedTokens: result.timings.cache_n ?? null,
      predictedTokens: result.tokens_predicted,
      predictedPerSecond: result.timings.predicted_per_second,
    };

    return {
      text,
      content: result.content ?? "",
      reasoningContent: result.reasoning_content ?? "",
      tokensPredicted: result.tokens_predicted,
      tokensEvaluated: result.tokens_evaluated,
      timings: {
        promptMs: result.timings.prompt_ms,
        predictedMs: result.timings.predicted_ms,
        predictedPerSecond: result.timings.predicted_per_second,
      },
      stoppedByLimit: result.stopped_limit > 0,
      stoppedByUser: stopRequested,
    };
  });
}

// --- KV-session helpers (Fase 4: cold-start prefix cache + dev prefill benchmark) ---

/**
 * Clear the KV cache (and reset the dirty flag). Used by the dev prefill
 * benchmark to guarantee each arm starts from a cold cache.
 */
export function clearKvCache(): Promise<void> {
  return withLock(async () => {
    if (!context) return;
    await context.clearCache();
    kvStateDirty = false;
  });
}

/**
 * Restore a saved KV session. Returns the restored token count plus the
 * DETOKENIZED text of the restored tokens (the caller validates it actually
 * starts with the expected stable prefix — a session file whose content
 * doesn't match would be silently useless forever, since the cache key hashes
 * the prefix text, not the file). Returns null when skipped: no model, or a
 * completion already ran since load (restoring would clobber live state).
 * Callers must treat null/throw as "start cold".
 */
export function loadSessionFile(
  path: string,
): Promise<{ tokensLoaded: number; prompt: string } | null> {
  return withLock(async () => {
    if (!context || kvStateDirty) return null;
    const result = await context.loadSession(path);
    return { tokensLoaded: result.tokens_loaded, prompt: result.prompt };
  });
}

// Longest common prefix of two token arrays. Exported for unit tests.
export function commonPrefixLength(a: number[], b: number[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Persist the stable-prefix region of the current KV state to disk.
 *
 * The TOKEN LIST to save is bounded by rendering the static system message
 * followed by two probe FIRST USER MESSAGES whose time contexts diverge,
 * tokenizing both, and taking the longest common token prefix — everything
 * before the first time-derived token (the system prompt itself is static in
 * the V4 layout; the first divergence is inside the opening user message's
 * [Contesto temporale: ...] line). A future launch's prompt matches those
 * tokens exactly, so llama.rn resumes KV reuse from the boundary.
 *
 * COST CAVEAT: llama.cpp's llama_state_save_file serializes the token list
 * truncated at tokenSize but the FULL KV tensor state of every occupied cell
 * (the tail/history/answer cells too — there is no per-token trim in the save
 * path). For Qwen3-4B with f16 KV that is ~147 KB/token, so the file runs to
 * hundreds of MB and the write takes on the order of a second. The extra cells
 * are dead weight (loadSession's next completion purges what doesn't match)
 * but they make saves expensive — which is why session-cache debounces them.
 *
 * Runs as ONE lock acquisition, and callers must invoke it SYNCHRONOUSLY in
 * the same tick as the decision to persist: any completion that slips in
 * between could ctx_shift the prefix out of the cache and persist garbage.
 * Callers must only invoke this after a completion whose prompt began with
 * `prefixText` (the orchestrator's post-turn hook guarantees it).
 *
 * Returns the number of tokens the boundary covers (the reusable region).
 */
export function snapshotPrefixSession(opts: {
  path: string;
  prefixText: string;
  probeUserA: string;
  probeUserB: string;
}): Promise<number> {
  return withLock(async () => {
    if (!context) throw new Error("No model loaded");
    if (!kvStateDirty) throw new Error("No completion has populated the KV cache");

    // Sequential on purpose: two concurrent JSI calls on one context are not
    // guaranteed safe, and this whole op already holds the engine lock.
    // Each probe also gets a DIFFERENT template `now`: a chat template that
    // itself injects the current date (some imported GGUFs do) then diverges
    // at that date, the boundary lands before it, and the <64 guard below
    // correctly refuses to persist a prefix that goes stale at midnight.
    const PROBE_NOW = [946684800, 4102444800]; // epoch 2000-01-01 / 2100-01-01
    const probes: number[][] = [];
    for (const [i, probeUser] of [opts.probeUserA, opts.probeUserB].entries()) {
      const formatted = await context.getFormattedChat(
        [
          { role: "system", content: opts.prefixText },
          { role: "user", content: probeUser },
        ],
        undefined,
        { now: PROBE_NOW[i] },
      );
      probes.push((await context.tokenize(formatted.prompt)).tokens);
    }
    const boundary = commonPrefixLength(probes[0], probes[1]);
    // A tiny boundary means the probes diverged inside the stable prefix —
    // wrong inputs, or a template that injects time itself. Don't persist that.
    if (boundary < 64) {
      throw new Error(`Stable-prefix boundary too short: ${boundary} tokens`);
    }

    // llama.rn 0.11.4 strips file:// in loadSession but NOT in saveSession —
    // normalize here so both accept the same expo-file-system URI form.
    const rawPath = opts.path.startsWith("file://") ? opts.path.slice(7) : opts.path;
    await context.saveSession(rawPath, { tokenSize: boundary });
    return boundary;
  });
}

export function stopGeneration(): Promise<void> {
  // Record the user's intent so the active generate() reports stoppedByUser and
  // callers (e.g. the orchestrator's malformed-JSON retry) can avoid launching
  // follow-up work the user just asked to cancel.
  stopRequested = true;
  // stopCompletion is safe to call outside the lock (it signals the native layer).
  // It's a JSI call typed Promise<void> but can return undefined at runtime, so
  // wrap in Promise.resolve to guarantee callers always get a thenable.
  if (context) {
    return Promise.resolve(context.stopCompletion());
  }
  const gx = genieXSession();
  if (gx) {
    gx.backend.stop?.();
  }
  return Promise.resolve();
}
