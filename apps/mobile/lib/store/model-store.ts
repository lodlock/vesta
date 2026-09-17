// Zustand store for the model manager. Coordinates the catalog, HuggingFace
// download, the SQLite registry, and llama.rn (load/unload), and exposes live
// download progress to the Models screen.

import { create } from "zustand";
import * as FileSystem from "expo-file-system/legacy";
import type {
  CatalogModel,
  DownloadProgress,
  InstalledModel,
  ModelArtifact,
  ModelRole,
  ModelTrust,
} from "../models/types";
import {
  listInstalled,
  getModelById,
  getActiveModel,
  insertModel,
  setModelState,
  setResumeToken,
  finalizeModel,
  finalizeBundle,
  setModelIntegrity,
  setActiveModel,
  removeModel,
} from "../models/model-registry";
import {
  downloadModel,
  cancelDownload as cancelTask,
  deleteModelFile,
  ensureModelsDir,
  modelPathFor,
} from "../models/download-manager";
import {
  listGgufFiles,
  resolveUrl,
  fetchExpectedSha256,
  type HfFile,
} from "../models/hf-client";
import { canActivate } from "../models/activation";
import { backendModelRef, npuRefusalFor } from "../llm/backends/registry";
import {
  npuCatalogFor,
  pullIdentifier,
  type NpuCatalogModel,
} from "../models/npu-catalog";
import { prepareNpuBackend, type NpuReadiness } from "../models/npu-ready";
import {
  checkBundle,
  toBundleFiles,
  verifyAgainstBaseline,
  type MeasuredBundle,
} from "../models/npu-bundle";
import { isNpuModel } from "../models/npu-compat";
import {
  genieXImportRequest,
  genieXImportedRow,
  genieXModelUri,
} from "../models/geniex-gguf-import";
import {
  pullabilityIndex,
  pullabilityOf,
  MANUAL_EXPORT_EXPLANATION,
  type PullabilityReport,
} from "../models/npu-pullability";
import {
  npuPull,
  npuPullRequest,
  npuHubPullability,
  npuLogDiagnostic,
  npuImportBundle,
  npuHubModels,
  npuResolveAlias,
  npuCancelPull,
  npuBundleInfo,
  npuRemoveBundle,
  onNpuPullProgress,
} from "../native/npu";
import {
  hubAvailability,
  hubModelLabel,
  parseSnapshot,
  serializeSnapshot,
  EMPTY_HUB,
  type HubState,
  type CompatibleHubModel,
} from "../models/npu-hub";
import {
  describeGenieXFailure,
  isTransientPullFailure,
} from "../models/npu-errors";
import {
  getDownloadRetrySettings,
  retryAllowed,
  retryDelayMs,
  waitForRetry,
} from "../models/download-retry";
import {
  recordPullAttempt,
  recordPullOutcome,
  formatPullTrace,
} from "../models/npu-pull-trace";
import { checkGgufFile } from "../models/gguf-header";
import { parseSha256File, readAdjacentChecksum } from "../models/integrity";
import { sha256File, normalizeSha256 } from "../native/file-hash";
import { getDeviceCaps, type DeviceCaps } from "../models/device-caps";
import {
  loadModel,
  unloadModel,
  validateGguf,
  getModelInfo,
  sessionMatches,
} from "../llm/llm-engine";
import { warmSessionCache } from "../orchestrator/session-warmer";
import { getPerfSettings, perfToLlmOptions } from "../llm/perf-config";
import { useChatStore } from "./chat-store";

// Serializes the "first model auto-activates" decision so two near-simultaneous
// downloads can't both fire a (multi-GB) load (H1 TOCTOU).
let autoActivateInFlight = false;

/**
 * The activation that is running, and the promise every later caller joins.
 *
 * Module-level rather than store state because a promise is not renderable and
 * must not be: `activating` is what the screen reads, this is what the code
 * awaits. The two are set and cleared together.
 *
 * Why it exists at all. The engine's own lock (llm-engine.withLock) already
 * stopped two native sessions from being created at once, so repeated taps
 * never built two LlmWrappers. What it did NOT stop is everything activate()
 * does AROUND the load — the registry read, the bundle probe, warmSessionCache,
 * setActiveModel, refresh — none of which is under that lock. Two activations
 * of different models therefore race to write `is_active`, and the one that
 * loses the load can win the write, leaving the registry naming a model the
 * engine is not running. Single-flight here removes the window instead of
 * papering over it downstream.
 */
let inFlightActivation: { id: string; promise: Promise<void> } | null = null;

/** Exposed for tests: the activation currently running, by model id. */
export function activationInFlight(): string | null {
  return inFlightActivation?.id ?? null;
}

// Pure: choose which file in a repo to download. Exact filename wins, then a
// filename containing the desired quant, then the first GGUF.
export function pickFile(
  files: HfFile[],
  preferred: string,
  quant: string,
): HfFile | null {
  if (files.length === 0) return null;
  const base = (p: string) => p.split("/").pop() ?? p;
  const exact = files.find(
    (f) => base(f.path).toLowerCase() === preferred.toLowerCase(),
  );
  if (exact) return exact;
  const byQuant = files.find((f) =>
    base(f.path).toLowerCase().includes(quant.toLowerCase()),
  );
  if (byQuant) return byQuant;
  return files[0];
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * What this build and this phone can do with the Qualcomm NPU.
 *
 * The facts are kept separate because they fail separately, and a user staring
 * at "NPU unavailable" deserves to know which one it was. Produced by
 * npu-ready, which is also what the cold-start load path uses — one place that
 * decides, so the Models screen and the loader can never disagree.
 */
export type NpuStatus = NpuReadiness;

interface ModelState {
  installed: InstalledModel[];
  progress: Record<string, DownloadProgress>;
  freeBytes: number | null;
  caps: DeviceCaps | null;
  busy: boolean;
  error: string | null;
  npu: NpuStatus;
  /** Curated NPU entries for THIS chipset. Empty on every other device. */
  npuCatalog: NpuCatalogModel[];
  /**
   * What Qualcomm's hub says it has, once asked. Null until then.
   *
   * Kept in state rather than fetched per install so the Models screen can say
   * up front whether an asset exists for this phone, instead of only after a
   * download has failed.
   */
  npuHub: HubState;
  /**
   * The last failure per model, keyed by catalog id or hub model name.
   *
   * Keyed rather than global so one doomed model cannot make the whole hub
   * catalogue look broken: the other cards stay installable and the snapshot
   * stays on screen.
   */
  npuInstallErrors: Record<string, string>;
  /**
   * Installs whose cancel has been requested but whose pull has not yet
   * stopped.
   *
   * Keyed by registry row id. It exists because those are two different moments
   * and the UI was pretending they were one: GenieX can take ~30 seconds to
   * unwind a pull, and for all of that time the screen said "Starting
   * download…" while the user tapped Cancel again and again.
   */
  npuCanceling: Record<string, true>;
  /**
   * Which hub models Qualcomm actually distributes a bundle for.
   *
   * Null until the cached manifest has been read. Absent is "unknown", never
   * "not distributed" — see npu-pullability.ts.
   */
  npuPullability: PullabilityReport | null;
  /**
   * The model whose activation is running right now, or null.
   *
   * The Models screen draws its whole pending state from this one field, and
   * the field lives here rather than in the screen because the load does: a
   * QAIRT session takes ~14 s to create, which is long enough for the user to
   * leave the screen, and a `useState` on the card would have unmounted with
   * it. Coming back re-renders the same truth.
   *
   * One observation, not reproduced: in a single early test, Back and the
   * header back button appeared unresponsive for the length of a model load.
   * Later CPU and NPU runs all navigated normally, so nothing here works
   * around it — recorded only so a second sighting is recognised as a second.
   */
  activating: string | null;
  /**
   * The last activation failure, per model id.
   *
   * Keyed, like npuInstallErrors and for the same reason: the message belongs
   * to the row it is about. The global `error` banner still gets a copy —
   * reloadActive() reads it to decide whether a perf change took — but the
   * banner alone could not say WHICH card failed.
   */
  activationErrors: Record<string, string>;

  refresh: () => Promise<void>;
  /**
   * The Qualcomm runtime's own state, and nothing else.
   *
   * Exists because the Diagnostics screen needs it and had no way to get it:
   * `npu` was populated only by `refresh()`, which the Models screen owns, so
   * every Qualcomm section was invisible until the user had been to Models.
   * A screen that reports on a capability must be able to establish that
   * capability itself.
   *
   * Local and cheap — a device-info read and the process-cached native probe.
   * It queries no network, installs nothing, and does not touch the catalogue,
   * which is the Models screen's business.
   */
  ensureNpuReadiness: () => Promise<NpuStatus>;
  loadNpuHub: (force?: boolean) => Promise<HubState>;
  /**
   * The last hub snapshot as it was left on disk, and never a query.
   *
   * The counterpart to `loadNpuHub()`, split off it so that a screen can show
   * what is already known without deciding, on the user's behalf, to go to the
   * network. Offline-first is the whole premise: opening Diagnostics must cost
   * nothing but a file read.
   */
  loadCachedNpuHub: () => Promise<HubState>;
  installHubModel: (m: CompatibleHubModel) => Promise<void>;
  installNpuModel: (model: NpuCatalogModel) => Promise<void>;
  importNpuBundle: (model: NpuCatalogModel, uri: string) => Promise<void>;
  /**
   * SPIKE: registers a side-loaded GGUF directory with the GenieX model
   * manager and adds it as a `geniex_llama_cpp` row.
   *
   * Deliberately not on the Models screen and not fed by a catalog — it exists
   * so the llama.cpp lane can be driven on a real device. See
   * lib/models/geniex-gguf-import.
   */
  importGenieXGguf: (localPath: string, displayName: string) => Promise<void>;
  cancelNpuInstall: (id: string) => Promise<void>;
  verifyNpuBundle: (id: string) => Promise<void>;
  downloadFromCatalog: (model: CatalogModel) => Promise<void>;
  downloadFromRepo: (
    repo: string,
    file: HfFile,
    displayName: string,
  ) => Promise<void>;
  importLocalModel: (
    uri: string,
    name: string,
    expectedSha256?: string | null,
  ) => Promise<void>;
  verifyIntegrity: (id: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  reloadActive: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  clearError: () => void;
}

// Said in one place so the hub-resolution refusal and the -100010 message
// point at the same escape hatch.
// Where the last successful catalogue is kept between launches.
//
// A FILE, in the cache directory, rather than a row in `config`. It is a
// disposable copy of someone else's data: losing it costs one network call,
// the OS is welcome to evict it, and it is not a setting the user chose. It is
// also never authoritative — every rendering of it says so and offers a
// refresh, and an absence read from it is shown with its age.
const HUB_CACHE_FILE = "npu-hub.json";

function hubCachePath(): string | null {
  return FileSystem.cacheDirectory
    ? `${FileSystem.cacheDirectory}${HUB_CACHE_FILE}`
    : null;
}

/** The cached catalogue, or null for anything at all that goes wrong. */
async function readHubCache(): Promise<string | null> {
  const path = hubCachePath();
  if (!path) return null;
  try {
    return await FileSystem.readAsStringAsync(path);
  } catch {
    // No cache, unreadable cache, no cache directory — all the same answer:
    // nothing is known yet. parseSnapshot turns this into "not checked".
    return null;
  }
}

async function writeHubCache(body: string): Promise<void> {
  const path = hubCachePath();
  if (!path) return;
  try {
    await FileSystem.writeAsStringAsync(path, body);
  } catch {
    // A catalogue that could not be cached is not a failed query.
  }
}

const MANUAL_IMPORT_HINT =
  "If you have exported a compatible bundle yourself, use Import bundle.";

type Setter = (
  partial: Partial<ModelState> | ((s: ModelState) => Partial<ModelState>),
) => void;
type Getter = () => ModelState;

/**
 * One NPU install, whatever chose it.
 *
 * Module-level rather than a store action because it is not part of the
 * surface: the two entry points above decide WHAT to install, and this is the
 * single definition of HOW. Everything past this line is identical by
 * construction for a curated entry and a hub row — the same compatibility
 * refusal, the same placeholder row, the same bundle validation, the same
 * storage, the same registry shape.
 */
interface NpuInstallSpec {
  /** Exactly what to pull by. The hub's own spelling wherever the hub knew it. */
  modelName: string;
  /** Exactly what chipset to pull for. The hub's own spelling, never ours. */
  chipset: string;
  /**
   * The canonical SoC the row records — what the load-time guard compares
   * against Build.SOC_MODEL on every later boot, long after the catalogue that
   * produced it is gone.
   */
  targetSoc: string;
  displayName: string;
  /** Null lets GenieX pick the bundle's only precision, which is the hub case. */
  precision: string | null;
  /** Null skips the runtime-version gate; the hub does not publish one. */
  runtimeVersion: string | null;
  /** Null means "not published" — the fit label reads "unknown", not a guess. */
  minRamMb: number | null;
  role: ModelRole;
  artifact: ModelArtifact;
  /**
   * Which hub to resolve through. AUTO lets the runtime route by model-name
   * prefix instead of being told; AIHUB names it outright.
   */
  hub: "AIHUB" | "AUTO";
  /** Which card shows a failure from this install. */
  errorKey: string;
}

/**
 * Records a per-model failure.
 *
 * Keyed rather than global so one doomed model cannot make the whole hub
 * catalogue look broken — the other cards stay installable and the snapshot
 * stays on screen.
 */
function failInstall(set: Setter, key: string, message: string): void {
  set((s) => ({ npuInstallErrors: { ...s.npuInstallErrors, [key]: message } }));
}

/**
 * Records an activation failure, on the row it belongs to and in the banner.
 *
 * The message is whatever the layer below actually said — the backend's
 * refusal, GenieX's own words for why it could not create the session. It is
 * never replaced with a generic one: "could not load the model" is not a thing
 * anyone can act on, and the native message is the only description of the
 * failure that exists.
 */
function failActivation(set: Setter, id: string, message: string): void {
  set((s) => ({
    activationErrors: { ...s.activationErrors, [id]: message },
    error: message,
  }));
}

/**
 * Cancellation that reaches a retry backoff, not just an active pull.
 *
 * Keyed by registry row id, which is the id Cancel already carries. Module
 * level for the same reason runNpuInstall is: the store action decides whether
 * an install may start, this is the state one install has while it runs.
 */
interface LiveInstall {
  abort: AbortController;
  /** Carried so a cancel can name the model without a database round trip. */
  modelName: string;
}

const installAborts = new Map<string, LiveInstall>();

/**
 * Models whose cancel has been requested and whose pull has not yet stopped.
 *
 * By MODEL NAME, not row id, because that is what a second Download press
 * would ask for. Starting a new pull for a bundle GenieX is still unwinding is
 * how a cancel and an install end up fighting over the same `.inflight`
 * directory, and the native side would answer the race with NPU_PULL_BUSY.
 */
const cancelingModels = new Set<string>();

/** Cancels the wait as well as the pull. No-op for an install already gone. */
function abortInstall(id: string): void {
  installAborts.get(id)?.abort.abort();
}

/** Whether a runNpuInstall is currently running for this row. */
function installIsLive(id: string): boolean {
  return installAborts.has(id);
}

/** The model a live install is pulling, or null when there is no live install. */
function liveInstallModel(id: string): string | null {
  return installAborts.get(id)?.modelName ?? null;
}

/**
 * Clears the module-level install bookkeeping.
 *
 * These maps outlive a Zustand `setState`, which is the point — an install is
 * not screen state — but it also means one test's half-finished cancel would
 * block the next test's install. Same reason npu-ready has one.
 */
export function resetNpuInstallStateForTests(): void {
  installAborts.clear();
  cancelingModels.clear();
}

/**
 * One pull, asked for again while the failure is transient and the user said to.
 *
 * ## Why this is a loop and not a scheduler
 *
 * Each attempt is `await`ed to completion before the next is even considered,
 * so two pullFlows cannot overlap by construction — there is no timer holding a
 * reference to a pull, no queue, and nothing that fires while a request is in
 * flight. That matters because the native side enforces the same rule from the
 * other side (`pull()` rejects with NPU_PULL_BUSY while `pullJob` is active),
 * and a retry that raced its own predecessor would turn a transient network
 * failure into a permanent-looking BUSY.
 *
 * ## What is deliberately not here
 *
 * Nothing is deleted between attempts. No `removeBundle`, no `clean()`, no
 * touching the SDK's cache — GenieX keeps the partial download in `.inflight`
 * and resumes it, which is the entire reason retrying is cheaper than
 * restarting. See download-retry.ts for the evidence.
 *
 * The settings are read INSIDE the loop, once per decision, so a user who turns
 * auto-retry off mid-backoff is obeyed by the next decision rather than by the
 * value that was current when the download started.
 */
async function pullWithRetry(
  set: Setter,
  request: Parameters<typeof npuPull>[0],
  rowId: string,
  signal: AbortSignal,
  seenProgress: () => { events: number; bytes: number },
): Promise<Awaited<ReturnType<typeof npuPull>>> {
  let failures = 0;

  for (;;) {
    // TEMPORARY DIAGNOSTIC, records only — see npu-pull-trace.ts. The request
    // is captured as it will actually be serialised, not as it was written, so
    // an absent key and the word "null" are distinguishable afterwards.
    const before = seenProgress();
    const entry = recordPullAttempt(
      failures + 1,
      npuPullRequest(request) as unknown as Record<string, unknown>,
      signal.aborted,
    );

    try {
      const bundle = await npuPull(request);
      const after = seenProgress();
      recordPullOutcome(entry, {
        ok: true,
        elapsedMs: Date.now() - entry.startedAt,
        progressEvents: after.events - before.events,
        bytesWritten: after.bytes,
      });
      npuLogDiagnostic(formatPullTrace());
      return bundle;
    } catch (err) {
      const after = seenProgress();
      recordPullOutcome(entry, {
        ok: false,
        elapsedMs: Date.now() - entry.startedAt,
        // Zero here is the whole point: it separates a failure during setup
        // — manifest resolution, chipset lookup, asset selection, creating
        // .inflight — from one inside the transfer.
        progressEvents: after.events - before.events,
        bytesWritten: after.bytes,
        error: err instanceof Error ? err.message : String(err),
      });
      npuLogDiagnostic(formatPullTrace());
      // Read now, not at install time: this is what makes the setting live.
      const settings = await getDownloadRetrySettings();

      // Three separate reasons to stop, and the user sees the ORIGINAL error
      // in every one of them — a retry policy that swallowed the runtime's own
      // words would be worse than no retry at all.
      if (
        signal.aborted ||
        !isTransientPullFailure(err) ||
        !retryAllowed(failures, settings)
      ) {
        throw err;
      }

      failures += 1;
      const max = settings.maxRetries === "unlimited" ? null : settings.maxRetries;
      const reason = describeGenieXFailure(err);

      // No byte counts while nothing is transferring. The last progress event
      // is stale the moment the pull failed, and a bar frozen at 97% reads as a
      // hung download rather than a waiting one.
      const publish = (secondsRemaining: number) =>
        set((state) => {
          const current = state.progress[rowId];
          if (!current) return {};
          return {
            progress: {
              ...state.progress,
              [rowId]: {
                ...current,
                retry: { attempt: failures, max, secondsRemaining, reason },
              },
            },
          };
        });

      const proceed = await waitForRetry(
        retryDelayMs(failures),
        signal,
        publish,
      );
      if (!proceed) throw err; // cancelled during the wait

      // Back to the ordinary download UI for the next attempt.
      set((state) => {
        const current = state.progress[rowId];
        if (!current) return {};
        const { retry: _retry, ...rest } = current;
        return { progress: { ...state.progress, [rowId]: rest } };
      });
    }
  }
}

async function runNpuInstall(
  set: Setter,
  get: Getter,
  spec: NpuInstallSpec,
): Promise<void> {
  set((s) => {
    const errors = { ...s.npuInstallErrors };
    delete errors[spec.errorKey];
    return { npuInstallErrors: errors };
  });

  // The same refusal the backend would give at load time, applied BEFORE
  // several gigabytes are spent rather than after. A hub row does not skip
  // this: its targetSoc came from the hub's own chipset list resolved through
  // the runtime's table, so the guard is checking a real claim.
  const refusal = npuRefusalFor(
    backendModelRef({
      filePath: "",
      artifact: spec.artifact,
      contextSize: 4096,
      displayName: spec.displayName,
      targetSoc: spec.targetSoc,
      runtimeVersion: spec.runtimeVersion,
      quant: spec.precision,
    }),
  );
  if (refusal) {
    failInstall(set, spec.errorKey, refusal);
    return;
  }

  if (get().installed.some((m) => m.runtimeModelName === spec.modelName)) {
    failInstall(set, spec.errorKey, `${spec.displayName} is already installed.`);
    return;
  }

  // A cancel that has been asked for but not yet finished. Starting here would
  // hand GenieX a pull for a bundle it is still tearing down — the native side
  // would answer NPU_PULL_BUSY, and the user would read that as a new fault
  // rather than as the old one still finishing.
  // The hub lists models it does not distribute. `AiHubSource::plan()` refuses
  // them on the first line it runs — an empty `manifest_urls.release_assets` —
  // and the refusal reaches us as a bare rc=-100000 with the reason dropped.
  // There is nothing to retry and nothing to accept: the asset is not
  // published. So the download is not attempted, and the card says why.
  if (
    pullabilityOf(spec.modelName, pullabilityIndex(get().npuPullability)) ===
    "manual-export"
  ) {
    failInstall(set, spec.errorKey, `${spec.displayName}: ${MANUAL_EXPORT_EXPLANATION}`);
    return;
  }

  if (cancelingModels.has(spec.modelName)) {
    failInstall(
      set,
      spec.errorKey,
      `${spec.displayName} is still being canceled. The Qualcomm runtime can ` +
        "take up to a minute to stop a download; try again once it has.",
    );
    return;
  }

  // A placeholder row so the download is visible, cancellable and -- above
  // all -- recoverable: a process killed mid-pull leaves a row in
  // "downloading" that the user can see and cancel, rather than gigabytes in
  // a cache directory nothing references.
  const row = await insertModel({
    displayName: `${spec.displayName} (NPU)`,
    filePath: "",
    quant: spec.precision,
    sizeBytes: 0,
    minRamMb: spec.minRamMb,
    contextSize: 4096,
    role: spec.role,
    state: "downloading",
    backend: "qualcomm_npu",
    artifact: spec.artifact,
    targetSoc: spec.targetSoc,
    runtimeVersion: spec.runtimeVersion,
    runtimeModelName: spec.modelName,
    trust: "unverified",
  });
  await get().refresh();

  // TEMPORARY DIAGNOSTIC, counted beside the existing subscription so it costs
  // nothing and cannot drift from what the UI saw. "Did any byte move before
  // this failed" is the one fact that separates a setup failure from a
  // transfer failure, and nothing was recording it.
  let progressEvents = 0;
  let progressBytes = 0;
  const seenProgress = () => ({ events: progressEvents, bytes: progressBytes });

  const unsubscribe = onNpuPullProgress((p) => {
    if (p.modelName !== spec.modelName) return;
    progressEvents += 1;
    progressBytes = Math.max(progressBytes, p.downloaded);
    set((state) => ({
      progress: {
        ...state.progress,
        [row.id]: {
          modelId: row.id,
          status: "downloading",
          bytesWritten: p.downloaded,
          bytesTotal: p.total,
          bytesPerSec: 0,
          etaSeconds: null,
        },
      },
    }));
  });

  // One controller per install, so Cancel reaches the WAIT as well as the pull.
  // During a backoff there is no pullFlow to cancel — npuCancelPull() would be
  // a no-op — and a user who has decided to stop should not sit through ten
  // seconds of countdown for a download that is already over.
  const abort = new AbortController();
  installAborts.set(row.id, { abort, modelName: spec.modelName });

  try {
    // The same request, asked again. Byte for byte the same: the identity a
    // resume depends on is `modelName` + `chipset` + `precision`, and a retry
    // that changed any of them would be a different download, not a
    // continuation of this one.
    const request = {
      modelName: spec.modelName,
      chipset: spec.chipset,
      precision: spec.precision,
      hub: spec.hub,
      displayName: spec.displayName,
    };
    const bundle = await pullWithRetry(
      set,
      request,
      row.id,
      abort.signal,
      seenProgress,
    );

    // Everything that could make this unloadable, decided from the file
    // listing rather than from a load attempt that costs 20+ seconds and an
    // out-of-memory risk to learn the same thing.
    const check = checkBundle(bundle as MeasuredBundle);
    if (!check.ok) {
      // NOTHING IS DELETED HERE, and that is the point.
      //
      // Reaching this line means the runtime already committed the bundle:
      // npuPull() only resolves after PullEvent.Completed AND a non-null
      // getPaths(), which is the manager's own test for "moved out of
      // .inflight/". So this is Vesta disagreeing with a runtime that has
      // already said yes — and a disagreement is not grounds for throwing away
      // gigabytes the user waited for. This branch used to call
      // npuRemoveBundle() before the message was even on screen, and a 2.38 GB
      // AI Hub pull that GenieX reported as rc=0 was destroyed by it.
      //
      // Instead the row is kept as a real handle on what is on disk: the
      // measured manifest is recorded so Verify has something to check, and
      // the state is then set to "error" so canActivate() refuses it. The user
      // gets the reason, the Delete button, and the choice. A GenieX pull that
      // actually FAILED never gets here — npuPull() rejects, and the catch
      // below still removes the row.
      await finalizeBundle(row.id, {
        filePath: bundle.modelPath,
        tokenizerPath: bundle.tokenizerPath ?? null,
        sizeBytes: bundle.totalBytes,
        bundleFiles: toBundleFiles(bundle.files),
      });
      await setModelState(row.id, "error");
      await get().refresh();
      failInstall(
        set,
        spec.errorKey,
        `${check.message} The download itself completed and has been KEPT — ` +
          "delete it from this screen if you want the space back.",
      );
      return;
    }

    await finalizeBundle(row.id, {
      filePath: bundle.modelPath,
      tokenizerPath: bundle.tokenizerPath ?? null,
      sizeBytes: bundle.totalBytes,
      bundleFiles: toBundleFiles(bundle.files),
    });
    await get().refresh();

    if (check.warnings.length > 0) {
      failInstall(set, spec.errorKey, check.warnings.join(" "));
    }

    // Activation stays the user's call — see the Models screen. Only a device
    // with NOTHING active gets one chosen for it, which is the first-run case.
    const active = await getActiveModel();
    if (!active) await get().activate(row.id);
  } catch (err) {
    // A cancelled or failed pull leaves partial files in the SDK's cache,
    // where a later pull resumes them — and automatic retry is built on
    // exactly that, so a FAILURE removes no bundle, calls no remove() and
    // calls no clean(). The ROW goes, because a row pointing at an incomplete
    // bundle is what makes a later load fail confusingly; pressing Download
    // again starts a fresh retry cycle on top of the bytes left behind.
    //
    // An explicit CANCEL is the exception, and this is the only correct place
    // for it. The user asked for the bytes to go, but `remove()` cannot take a
    // bundle GenieX is still writing — it blocks until the pull lets go. Doing
    // it from the Cancel handler meant awaiting that unwind before the screen
    // was touched at all, which is why a tap produced no visible response for
    // thirty seconds. Here, the pull has already exited.
    if (get().npuCanceling[row.id]) {
      await npuRemoveBundle(spec.modelName).catch(() => {});
    }
    await removeModel(row.id);
    await get().refresh();
    // Readable, with the runtime's own code kept on the end — see npu-errors.
    // The raw rc must survive: it is the only token that can be looked up
    // against Qualcomm's error definitions.
    //
    // The REQUEST goes with it. An rc with no subject cannot be acted on, and
    // the three values below are exactly what decides whether an asset
    // resolves — twice now a -100010 has turned out to be one of them being
    // wrong rather than the asset being absent.
    failInstall(
      set,
      spec.errorKey,
      `${describeGenieXFailure(err)} — asked for ${spec.modelName} · chipset ${spec.chipset} · ${spec.precision ?? "default precision"}`,
    );
  } finally {
    unsubscribe();
    installAborts.delete(row.id);
    cancelingModels.delete(spec.modelName);
    set((state) => {
      const progress = { ...state.progress };
      delete progress[row.id];
      // Cleared only now. "Canceling" ends when the pull has actually stopped,
      // not when the request was made — anything else is the screen claiming
      // something it does not know.
      const npuCanceling = { ...state.npuCanceling };
      delete npuCanceling[row.id];
      return { progress, npuCanceling };
    });
  }
}

/**
 * One activation, start to finish: the checks, the load, and the registry write
 * that records it.
 *
 * Module-level rather than a store action for the same reason runNpuInstall is:
 * the action decides WHETHER an activation may start, this is the single
 * definition of what one does. It never throws — every failure is reported as
 * state — which is what lets the single-flight wrapper clear itself in one
 * place whatever happened.
 */
async function runActivation(
  set: Setter,
  get: Getter,
  id: string,
): Promise<void> {
  // Set before the first await, so the card changes in the same frame as the
  // tap. This is the whole of the reported bug: ~14 s of a button that looked
  // dead is what made the user press it again.
  set((s) => {
    const errors = { ...s.activationErrors };
    delete errors[id];
    return { activating: id, error: null, activationErrors: errors };
  });
  const model = await getModelById(id);
  if (!model) {
    failActivation(set, id, "Model is not ready.");
    return;
  }
  // The SAME check the Models screen draws its buttons from, so a row that
  // looks selectable is selectable and a row that isn't says why. Note what
  // it does not consider: trust. An unverified model is labelled, not
  // blocked — blocking here while the UI didn't would be a second, invisible
  // policy.
  const check = canActivate(model);
  if (!check.ok) {
    failActivation(set, id, check.message);
    return;
  }
  const npuModel = isNpuModel(model);

  // A bundle is a DIRECTORY the GenieX model manager owns, so the single-file
  // checks below do not describe it. Its equivalents are the structural check
  // (metadata.json + shards + tokenizer, all non-empty) and the recorded
  // per-file sizes, both of which Verify runs — asking the manager whether it
  // still resolves the name is the cheap gate that belongs on every load.
  if (npuModel) {
    const stillThere = model.runtimeModelName
      ? await npuBundleInfo(model.runtimeModelName)
      : null;
    if (!stillThere) {
      await setModelState(id, "error");
      await get().refresh();
      failActivation(
        set,
        id,
        `${model.displayName}: the bundle is gone — reinstall it.`,
      );
      return;
    }
  } else {
    const info = await FileSystem.getInfoAsync(model.filePath);
    if (!info.exists) {
      await setModelState(id, "error");
      await get().refresh();
      failActivation(set, id, "Model file is missing — re-download it.");
      return;
    }
    // Cheap integrity gate on every load: the size must still be the size we
    // recorded. Re-hashing a multi-GB file here would add seconds to every cold
    // start, so the full check lives in verifyIntegrity(); this catches the
    // common case (a file replaced or truncated under us) for free.
    if (model.sizeBytes > 0 && (info.size ?? 0) !== model.sizeBytes) {
      await setModelState(id, "error");
      await get().refresh();
      failActivation(
        set,
        id,
        `${model.displayName} changed on disk (${info.size ?? 0} bytes, expected ${model.sizeBytes}). Tap Verify to check it against its source.`,
      );
      return;
    }
  }
  try {
    const perf = perfToLlmOptions(await getPerfSettings());
    await loadModel(model.filePath, {
      ...perf,
      contextSize: model.contextSize,
      gpuLayers: 0,
      chatTemplate: model.chatTemplate ?? undefined,
      // What tells the engine WHICH runtime this row belongs to. Without it
      // the engine does what it always did and loads a GGUF on llama.cpp,
      // which is right for every caller that has only a path.
      backendModel: backendModelRef({
        filePath: model.filePath,
        artifact: model.artifact,
        backend: model.backend,
        contextSize: model.contextSize,
        displayName: model.displayName,
        chatTemplate: model.chatTemplate,
        targetSoc: model.targetSoc,
        runtimeVersion: model.runtimeVersion,
        quant: model.quant,
        tokenizerPath: model.tokenizerPath,
        runtimeModelName: model.runtimeModelName,
      }),
    });
    // Same as the app-start path (chat-store.init): restore this model's
    // persisted prefix KV before any completion. Switching back to a model
    // whose session file is on disk skips the ~30s cold prefill. A no-op on
    // the Qualcomm path, which has no KV state to restore.
    await warmSessionCache();
    await setActiveModel(id);
    await get().refresh();
  } catch (err) {
    // Whatever the backend or GenieX actually said, kept verbatim. The
    // installed model is left exactly where it is: a session that could not
    // be created says nothing about the bytes on disk.
    failActivation(set, id, err instanceof Error ? err.message : String(err));
  }
}

export const useModelStore = create<ModelState>((set, get) => ({
  installed: [],
  progress: {},
  freeBytes: null,
  caps: null,
  busy: false,
  error: null,
  npu: {
    inBuild: false,
    probed: false,
    available: false,
    reason: null,
    runtimeVersion: null,
    soc: null,
    runtimeChipset: undefined,
    canonicalSoc: null,
    chipsets: undefined,
  },
  npuCatalog: [],
  npuHub: EMPTY_HUB,
  npuInstallErrors: {},
  npuCanceling: {},
  npuPullability: null,
  activating: null,
  activationErrors: {},

  /**
   * Asks GenieX for the hub's own catalogue.
   *
   * The hub IS the catalogue — a hard-coded list of one downloadable model was
   * wrong the moment Qualcomm's list changed, and on device it is wrong now
   * (19 models, and Vesta's preferred one not among them). So this is the
   * source, and Vesta's own entry is a preference expressed against it.
   *
   * Three rules the UI depends on:
   *   - a cached catalogue loads first, so the screen has something to show
   *     before the network answers, and it is MARKED as cached
   *   - a failure never clears the last good snapshot; it lands beside it
   *   - nothing is ever final. `force` re-queries, and the screen always
   *     offers that, because Qualcomm can publish at any time
   */
  ensureNpuReadiness: async () => {
    const npu = await prepareNpuBackend();
    set({ npu });
    return npu;
  },

  loadCachedNpuHub: async () => {
    const current = get().npuHub;
    // A snapshot already in state is at least as fresh as the file it was
    // written from, so re-reading it would only risk replacing a live answer
    // with an older one.
    if (current.snapshot) return current;
    const cached = parseSnapshot(await readHubCache());
    if (cached) set({ npuHub: { ...current, snapshot: cached } });
    return get().npuHub;
  },

  loadNpuHub: async (force = false) => {
    const current = get().npuHub;
    if (!force && current.snapshot && !current.snapshot.cached) return current;

    if (!force && !current.snapshot) {
      // Cheap, local, and enough to render: shown as cached until a real
      // query replaces it.
      const cached = parseSnapshot(await readHubCache());
      if (cached) set({ npuHub: { ...current, snapshot: cached } });
    }

    set((s) => ({ npuHub: { ...s.npuHub, checking: true } }));
    const result = await npuHubModels();
    const models = result?.models;

    if (!models) {
      const message =
        result?.error ??
        result?.nativeMessage ??
        "The Qualcomm model hub could not be reached.";
      // Beside, not instead of. Losing a good answer because a later query
      // timed out would be strictly worse than showing an older one.
      set((s) => ({ npuHub: { ...s.npuHub, error: message, checking: false } }));
      return get().npuHub;
    }

    // Read in the same breath as the catalogue, because it is the same
    // question half-answered: listHubModels() says which models fit this
    // silicon, and the manifest says which of those the hub will actually hand
    // over. A failure here leaves it null, which means "unknown" and changes
    // no behaviour.
    const pullability = await npuHubPullability();

    const snapshot = { models, checkedAt: Date.now(), cached: false };
    set({ npuHub: { snapshot, error: null, checking: false }, npuPullability: pullability });
    await writeHubCache(serializeSnapshot(snapshot));
    return get().npuHub;
  },

  refresh: async () => {
    const [installed, caps] = await Promise.all([listInstalled(), getDeviceCaps()]);
    // Tells the NPU backend what chipset it is on and whether its runtime
    // works. Until this has run the backend knows neither, and therefore
    // claims nothing. Cached per process, and free in a default build.
    const npu = await prepareNpuBackend(caps.soc);

    set({
      installed,
      caps,
      freeBytes: Number.isFinite(caps.freeBytes) ? caps.freeBytes : null,
      npu,
      // Offered only where it can run. An NPU entry is several gigabytes that
      // work on one chipset family and nowhere else, so showing it on the wrong
      // phone is not a harmless extra option.
      npuCatalog: npu.available ? npuCatalogFor(caps.soc, npu.chipsets) : [],
    });
  },

  // -- NPU install --------------------------------------------------------
  //
  // Nothing here shares code with the GGUF download path, and that is the
  // point. A GGUF is one file Vesta fetches over HTTP into its own models
  // directory. A context bundle is many files whose URLs are resolved from a
  // chipset-keyed release manifest only the GenieX SDK can read, landing in the
  // SDK's own cache under filesDir/geniex. The two never touch the same
  // directory, so a failed NPU install cannot truncate, overwrite or delete a
  // working GGUF -- see npu-bundle.bundleIsolatedFromGguf.
  //
  // Two callers, one operation. Vesta's curated entry and an arbitrary row from
  // Qualcomm's hub differ only in where the metadata came from; by the time
  // either reaches a download they are the same install, and duplicating it
  // would be two places for the same bug.
  installNpuModel: async (model: NpuCatalogModel) => {
    const npu = get().npu;
    if (!npu.available) {
      failInstall(
        set,
        model.id,
        npu.reason ??
          "There is no Qualcomm NPU runtime in this build, so an NPU model cannot be installed.",
      );
      return;
    }

    // What the hub says about OUR preferred model, right now. resolveAlias is
    // asked alongside: the catalogue may list a model under a name the manager
    // resolves ours to, and it is one of the few genuinely public ways to ask
    // the runtime anything about a name.
    const [hub, alias] = await Promise.all([
      get().loadNpuHub(),
      npuResolveAlias(model.modelName),
    ]);
    const availability = hubAvailability(
      hub,
      model.modelName,
      npu.soc,
      npu.chipsets,
      alias,
    );

    if (availability.status === "absent") {
      // Proven absent by a real answer. Saying so beats a download that can
      // only 404, and the card offers Import bundle for exactly this case.
      failInstall(
        set,
        model.id,
        `Qualcomm's hub did not list ${model.displayName} for ${npu.soc ?? "this chipset"}. ${MANUAL_IMPORT_HINT}`,
      );
      return;
    }

    // `unchecked` still attempts the pull with the catalog's own target: the
    // hub being unreachable is not evidence of anything, and the runtime's
    // verdict is the authority regardless.
    await runNpuInstall(set, get, {
      // The ROUTING identifier, which is not always the catalogue one. The
      // card is still found in the hub list by modelName — see
      // npu-catalog.pullIdentifier.
      modelName: pullIdentifier(model),
      // Which hub the entry declares. AUTO lets the runtime route by
      // model-name prefix rather than being told.
      hub: model.hub,
      // The SoC identifier, never the catalogue asset key — see
      // CompatibleHubModel for why those are two different vocabularies.
      chipset:
        availability.status === "listed"
          ? availability.canonicalSoc
          : model.targetSoc,
      targetSoc:
        availability.status === "listed"
          ? availability.canonicalSoc
          : model.targetSoc,
      displayName: model.displayName,
      precision: model.precision,
      runtimeVersion: model.runtimeVersion,
      minRamMb: model.minRamMb,
      role: model.role,
      artifact: model.artifact,
      errorKey: model.id,
    });
  },

  /**
   * Installs any model the hub offers for this silicon.
   *
   * Every string comes from the hub's own answer — the model name it published
   * and the chipset spelling it published it under. Nothing is matched fuzzily,
   * nothing is aliased by hand, and the canonical id recorded on the row is the
   * one the load-time guard will check on every later boot.
   *
   * Precision and runtime version are null because `HubModel` does not carry
   * them: null precision lets GenieX pick the bundle's own, and a null runtime
   * version skips a gate rather than inventing a bound. minRamMb is null for the
   * same reason — the fit label then reads "unknown", which is true.
   */
  installHubModel: async (hubModel: CompatibleHubModel) => {
    const npu = get().npu;
    if (!npu.available) {
      failInstall(
        set,
        hubModel.entry.name,
        npu.reason ?? "There is no Qualcomm NPU runtime in this build.",
      );
      return;
    }
    await runNpuInstall(set, get, {
      modelName: hubModel.entry.name,
      // Unchanged, and deliberately so: the AUTO / ai-hub-models experiment is
      // scoped to one known model. A generic hub row still asks for exactly
      // the identifier the catalogue returned, on the hub it came from.
      hub: "AIHUB",
      // The SoC IDENTIFIER, never the catalogue asset key. `ModelPullInput`
      // documents this field with SM8850/SM8750; `HubModel.chipsets` is a
      // different field on a different bean carrying AI Hub's manifest key
      // ("qualcomm-snapdragon-8-elite-gen5"). See CompatibleHubModel.
      chipset: hubModel.canonicalSoc,
      targetSoc: hubModel.canonicalSoc,
      displayName: hubModelLabel(hubModel.entry.name),
      precision: null,
      runtimeVersion: null,
      minRamMb: null,
      role: "primary",
      artifact: "qairt_context",
      errorKey: hubModel.entry.name,
    });
  },

  // -- Manual bundle import -----------------------------------------------
  //
  // The hub path can fail for a reason no client code can fix: Qualcomm has
  // not published the asset for this chipset. A user who exported one
  // themselves with `qai-hub-models` should not be blocked on someone else's
  // release schedule.
  //
  // What this is NOT is a way around the compatibility guard. The identical
  // refusal runs first, on the identical catalog entry, so an imported bundle
  // still has to be for THIS silicon; and the manager does the same layout
  // validation, the same measurement and the same hashing it does for a
  // download, so the row that lands is indistinguishable from a pulled one
  // except in where the bytes came from.
  //
  // Deliberately separate from importLocalModel(), which imports a .gguf. The
  // two share no code, no directory and no validation, and merging them would
  // mean one function that sometimes means a file and sometimes a directory.
  importNpuBundle: async (model: NpuCatalogModel, uri: string) => {
    set({ error: null });

    const npu = get().npu;
    if (!npu.available) {
      set({
        error:
          npu.reason ??
          "There is no Qualcomm NPU runtime in this build, so an NPU bundle cannot be imported.",
      });
      return;
    }

    // The same gate the download path runs, before the same work. An import
    // skips the hub, not the chipset check.
    const refusal = npuRefusalFor(
      backendModelRef({
        filePath: "",
        artifact: model.artifact,
        contextSize: 4096,
        displayName: model.displayName,
        targetSoc: model.targetSoc,
        runtimeVersion: model.runtimeVersion,
        quant: model.precision,
      }),
    );
    if (refusal) {
      set({ error: refusal });
      return;
    }

    if (
      get().installed.some((m) => m.runtimeModelName === pullIdentifier(model))
    ) {
      set({ error: `${model.displayName} is already installed.` });
      return;
    }

    const row = await insertModel({
      displayName: `${model.displayName} (NPU)`,
      filePath: "",
      quant: model.precision,
      sizeBytes: 0,
      minRamMb: model.minRamMb,
      contextSize: 4096,
      role: model.role,
      state: "downloading",
      backend: "qualcomm_npu",
      artifact: model.artifact,
      targetSoc: model.targetSoc,
      runtimeVersion: model.runtimeVersion,
      runtimeModelName: pullIdentifier(model),
      trust: "unverified",
    });
    await get().refresh();

    // An import still emits progress — unpacking a multi-gigabyte .zip is not
    // instant, and a screen that looks frozen gets force-quit.
    const unsubscribe = onNpuPullProgress((p) => {
      if (p.modelName !== pullIdentifier(model)) return;
      set((state) => ({
        progress: {
          ...state.progress,
          [row.id]: {
            modelId: row.id,
            status: "downloading",
            bytesWritten: p.downloaded,
            bytesTotal: p.total,
            bytesPerSec: 0,
            etaSeconds: null,
          },
        },
      }));
    });

    // The picker hands back a content:// URI, which is not a filesystem path
    // and cannot be opened as a File by the native side. So the archive is
    // staged into app storage first — the same thing the GGUF import does —
    // and removed as soon as the manager has unpacked it. That costs a second
    // copy of a multi-gigabyte file for the duration of the import, which is
    // the price of the picker handing out URIs rather than paths.
    let staged: string | null = null;
    try {
      const dir = `${FileSystem.cacheDirectory}npu-import/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
        () => {},
      );
      staged = `${dir}bundle-${row.id}.zip`;
      await FileSystem.copyAsync({ from: uri, to: staged });

      const bundle = await npuImportBundle({
        modelName: pullIdentifier(model),
        localPath: staged,
        precision: model.precision,
        displayName: model.displayName,
      });

      // Identical to the download path on purpose: one definition of "a
      // bundle Vesta will load", applied to both sources — and that includes
      // not destroying one the manager has already committed. npuImportBundle()
      // resolves on the same two conditions the download does, a completed
      // pullFlow and a non-null getPaths(), so a failure here is again Vesta
      // disagreeing after the runtime said yes. The row is kept, recorded and
      // marked errored; the user decides whether it goes.
      const check = checkBundle(bundle as MeasuredBundle);
      if (!check.ok) {
        await finalizeBundle(row.id, {
          filePath: bundle.modelPath,
          tokenizerPath: bundle.tokenizerPath ?? null,
          sizeBytes: bundle.totalBytes,
          bundleFiles: toBundleFiles(bundle.files),
        });
        await setModelState(row.id, "error");
        await get().refresh();
        set({
          error:
            `${model.displayName}: ${check.message} The imported bundle has been ` +
            "KEPT — delete it from this screen if you want the space back.",
        });
        return;
      }

      await finalizeBundle(row.id, {
        filePath: bundle.modelPath,
        tokenizerPath: bundle.tokenizerPath ?? null,
        sizeBytes: bundle.totalBytes,
        bundleFiles: toBundleFiles(bundle.files),
      });
      await get().refresh();

      if (check.warnings.length > 0) set({ error: check.warnings.join(" ") });

      const active = await getActiveModel();
      if (!active) await get().activate(row.id);
    } catch (err) {
      await npuRemoveBundle(pullIdentifier(model)).catch(() => {});
      await removeModel(row.id);
      await get().refresh();
      set({ error: `${model.displayName}: ${describeGenieXFailure(err)}` });
    } finally {
      unsubscribe();
      // The staging copy has served its purpose either way: on success the
      // manager holds its own unpacked copy, on failure there is nothing to
      // resume from a half-read archive.
      if (staged) {
        await FileSystem.deleteAsync(staged, { idempotent: true }).catch(() => {});
      }
      set((state) => {
        const progress = { ...state.progress };
        delete progress[row.id];
        return { progress };
      });
    }
  },

  /**
   * Asks for a download to stop, and says so at once.
   *
   * ## Why this used to look broken
   *
   * On device: tap Cancel, nothing happens, tap it four more times, and about
   * thirty seconds later "Download canceled" appears. Two separate faults,
   * and only one of them was GenieX's.
   *
   * GenieX's half: `pullJob.cancel()` cancels a Kotlin coroutine, and
   * coroutine cancellation is cooperative. The pull is a blocking native call
   * collecting a Flow, so the runtime unwinds at its own pace — finishing or
   * aborting in-flight range requests, flushing `.progress`, releasing the
   * `.lock`. Thirty seconds is that, and nothing here can make it faster.
   *
   * Ours: this function used to `await npuRemoveBundle(...)` — which is
   * `ModelManagerWrapper.remove()`, and cannot take a bundle the pull still
   * holds — BEFORE it touched a single piece of state. So the whole unwind
   * elapsed before the screen changed, and every extra tap fired another
   * native cancel and another remove() at a bundle mid-unwind.
   *
   * Now: the flag goes up synchronously, the native cancel is sent exactly
   * once, and the teardown moved into the install's own unwind path where the
   * pull has already exited. The screen says "Canceling…" for as long as that
   * takes, which is the truth.
   */
  cancelNpuInstall: async (id: string) => {
    // Idempotent by design: the button is disabled the moment this runs, but a
    // double-tap can still land two calls, and two cancels are one cancel.
    if (get().npuCanceling[id]) return;

    if (!installIsLive(id)) {
      // No install running for this row — a leftover "downloading" row from a
      // process that was killed mid-pull. There is nothing to unwind, so the
      // teardown happens here, as it always did.
      const model = await getModelById(id);
      if (model?.runtimeModelName) {
        await npuRemoveBundle(model.runtimeModelName).catch(() => {});
      }
      if (model) await removeModel(id);
      set((s) => {
        const progress = { ...s.progress };
        delete progress[id];
        return { progress };
      });
      await get().refresh();
      return;
    }

    // Synchronous, and first: this is the frame the user sees.
    const modelName = liveInstallModel(id);
    if (modelName) cancelingModels.add(modelName);
    set((s) => ({ npuCanceling: { ...s.npuCanceling, [id]: true } }));

    // The wait before the pull. During a retry backoff there is nothing for
    // npuCancelPull() to stop, and without the abort the loop would sit out
    // the countdown and then start an attempt already cancelled.
    abortInstall(id);
    npuCancelPull();
    // Nothing is awaited here. runNpuInstall's catch removes the bundle and
    // the row once pullFlow has actually exited, and its finally clears the
    // canceling flag — so the state reaches "canceled" when it is true.
  },

  // The NPU equivalent of Verify. It cannot appeal to an upstream digest --
  // there is none -- so it compares what is on disk against the baseline
  // recorded at install, and says plainly how much of the bundle that actually
  // covered. See npu-bundle.verifyAgainstBaseline.
  verifyNpuBundle: async (id: string) => {
    set({ busy: true, error: null });
    try {
      const model = await getModelById(id);
      if (!model?.runtimeModelName) return;

      const bundle = await npuBundleInfo(model.runtimeModelName);
      if (!bundle) {
        await setModelState(id, "error");
        await get().refresh();
        set({ error: `${model.displayName}: the bundle is gone -- reinstall it.` });
        return;
      }

      const structure = checkBundle(bundle as MeasuredBundle);
      if (!structure.ok) {
        await setModelState(id, "error");
        await get().refresh();
        set({ error: `${model.displayName}: ${structure.message}` });
        return;
      }

      const result = verifyAgainstBaseline(model.bundleFiles, bundle.files);
      if (!result.ok) {
        await setModelState(id, "error");
        await get().refresh();
        set({
          error: `${model.displayName} has changed since it was installed: ${result.problems.join(" ")}`,
        });
        return;
      }
      await setModelIntegrity(id, { state: "ready", sizeBytes: bundle.totalBytes });
      await get().refresh();
      set({
        error:
          `${model.displayName} still matches what was recorded at install ` +
          `(${result.checked} file${result.checked === 1 ? "" : "s"} by checksum, ` +
          `${result.unchecked} by size only -- Qualcomm publishes no checksums ` +
          `for these bundles).`,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  downloadFromCatalog: async (model: CatalogModel) => {
    set({ error: null });

    // Resolve the actual downloadable file from the live repo tree; fall back to
    // the catalog hint if the network/listing is unavailable.
    let file: HfFile;
    let exactSize = true; // size came from the HF tree API → safe to verify
    try {
      const files = await listGgufFiles(model.hfRepo);
      const picked = pickFile(files, model.preferredFile, model.quant);
      if (!picked) throw new Error("No .gguf files found in this repo.");
      file = picked;
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "GATED") {
        set({
          error: `${model.displayName} requires a HuggingFace login (gated). Support coming soon.`,
        });
        return;
      }
      // Network/listing failure — fall back to the catalog's approximate size.
      file = {
        path: model.preferredFile,
        sizeBytes: model.sizeBytesApprox,
        sha256: null,
      };
      exactSize = false;
    }

    await runDownload(set, get, {
      repo: model.hfRepo,
      file,
      exactSize,
      displayName: model.displayName,
      quant: model.quant,
      minRamMb: model.minRamMb,
      contextSize: model.contextSize,
      role: model.role,
    });
  },

  downloadFromRepo: async (repo, file, displayName) => {
    set({ error: null });
    await runDownload(set, get, {
      repo,
      file,
      exactSize: true,
      displayName,
      quant: null,
      minRamMb: null,
      contextSize: 4096,
      role: "primary",
    });
  },

  // SPIKE: hand a side-loaded GGUF directory to the GenieX model manager.
  //
  // The user chose these bytes — pushed over adb into the spike directory — so
  // no external digest exists for them and none ever will. That is the whole
  // reason this has its own integrity policy rather than borrowing the
  // downloader's, and the reason it may not borrow the downloader's CONCLUSION
  // either:
  //
  //   source        a local file the user supplied.
  //   integrity     established here, against a baseline computed at import.
  //   authenticity  NOT established. Nothing on this path can say who built
  //                 the file, and a locally computed hash cannot be made to.
  //
  // So the absence of a supplied checksum is not a reason to refuse, to warn,
  // or to withhold the model: there was never a checksum to be had, and
  // treating "the user gave us a file" as suspicious would make the only
  // import path this lane has unusable for the thing it was built to do. What
  // it IS a reason for is recording our own digest, which is what turns "we
  // know nothing about this file" into "we know what it was at import" — a
  // real, checkable property, and the strongest true one available.
  importGenieXGguf: async (localPath: string, displayName: string) => {
    set({ busy: true, error: null });
    const request = genieXImportRequest(localPath, displayName);
    try {
      if (
        get().installed.some((m) => m.runtimeModelName === request.modelName)
      ) {
        set({ error: `${displayName} is already imported.` });
        return;
      }

      // The same native import the QAIRT path uses, with GGUF-shaped
      // arguments. `hub` is pinned to LOCALFS by the native side.
      const bundle = await npuImportBundle({
        modelName: request.modelName,
        localPath: request.localPath,
        displayName: request.displayName,
        precision: request.precision,
      });

      // The manifest's own word, before a row exists. The manager infers
      // `plugin_id = "llama_cpp"` for any directory of GGUFs; anything else
      // means this is not the lane that should own it, and the import is undone
      // rather than left behind as a row nothing can load.
      if (bundle.runtimeId !== "llama_cpp") {
        await npuRemoveBundle(request.modelName).catch(() => {});
        set({
          error:
            `${displayName} imported as a ${bundle.runtimeId ?? "runtime-less"} ` +
            "model, not a GenieX llama.cpp GGUF. It has been removed.",
        });
        return;
      }

      // The file the manager now owns, addressed the way expo-file-system
      // addresses files. Everything below and every later Verify reads THIS,
      // so the structural check, the baseline and the activation size check
      // are all about the same bytes.
      const modelUri = genieXModelUri(bundle.modelPath);

      // "Usable GGUF" established before the row exists, exactly as the SAF
      // import does it. The manager infers its manifest from FILE NAMES and
      // never opens the weights, so a renamed .zip or a truncated adb push
      // imports perfectly happily and only fails later, inside llama.cpp.
      const header = await checkGgufFile(modelUri);
      if (!header.ok) {
        await npuRemoveBundle(request.modelName).catch(() => {});
        set({
          error: `${displayName}: ${header.error ?? "not a valid GGUF file."} It has been removed.`,
        });
        return;
      }

      // The integrity baseline, computed over the imported copy. This is the
      // ONLY digest that can exist for this model: the user supplied the file,
      // so there is no published checksum to check it against and never will
      // be. It therefore establishes integrity FROM NOW ON — a later change is
      // detectable — and says nothing whatever about who published the bytes.
      //
      // A hash failure is not an import failure. There is no expected digest
      // for it to disagree with, so nothing is in doubt; the row simply records
      // no baseline and says so. Fail-closed belongs where a checksum was
      // supplied and did not match, which cannot happen on this path.
      let baseline: string | null = null;
      try {
        baseline = await sha256File(modelUri);
      } catch {
        baseline = null;
      }

      await insertModel(
        genieXImportedRow(bundle, {
          displayName,
          modelName: request.modelName,
          sha256: baseline,
        }),
      );
      await get().refresh();
    } catch (err) {
      // Nothing half-imported is left behind: the manager's copy goes even if
      // it was the row insert that failed.
      await npuRemoveBundle(request.modelName).catch(() => {});
      set({ error: `${displayName}: ${describeGenieXFailure(err)}` });
    } finally {
      set({ busy: false });
    }
  },

  // Import an arbitrary local .gguf — one the user downloaded elsewhere, merged
  // themselves, or quantized by hand. No HuggingFace repo, no catalog entry and
  // no filename convention is required; the file comes in through the system
  // file picker (SAF) exactly as before.
  //
  // STORAGE: the picked URI is used ONCE, as a copy source. The bytes land in
  // the app-private models directory and everything afterwards — the header
  // check, the hash, llama.cpp, every later load — reads that copy. Nothing
  // outside the app can rewrite it, which is why an import-time baseline plus
  // a size check on load is enough and no multi-GB re-hash happens at startup.
  //
  // Checksum policy, in order:
  //   1. a digest the user supplied (pasted, or an adjacent `.sha256`) → the
  //      file MUST match it. Mismatch, or hashing that fails, rejects the
  //      import — same fail-closed rule as a HuggingFace download. This is the
  //      stronger claim, and stays distinct: the user vouched for a specific
  //      digest and the bytes agreed with it.
  //   2. no digest → the import proceeds, because explicitly picking a file IS
  //      the trust decision. We hash it anyway and keep that as a baseline, so
  //      an unexpected change to the file later is detectable. That is
  //      integrity from import onwards; it says nothing about provenance.
  //
  // (2) is NOT a weaker version of (1) that could be upgraded by asking harder.
  // It is a different claim about a different thing, which is why the two get
  // different trust values and different words on the card.
  importLocalModel: async (
    uri: string,
    name: string,
    expectedSha256?: string | null,
  ) => {
    set({ busy: true, error: null });
    try {
      await ensureModelsDir();
      const fileName = name.endsWith(".gguf") ? name : `${name}.gguf`;
      // Never import onto an existing file. Two different models can easily
      // share a name ("model.gguf"), and adopting the bytes already there would
      // silently import the WRONG file — worse, a checksum mismatch would then
      // delete a model the user still has installed. Take a free name instead.
      const finalPath = await freeModelPath(fileName);
      // Single copy straight to the final path (no temp-then-load double write).
      await FileSystem.copyAsync({ from: uri, to: finalPath });

      // Cheap structural check before the native parser sees the path: catches a
      // truncated copy or a mis-picked file with a clear message. Not a safety
      // boundary — see gguf-header.ts.
      const header = await checkGgufFile(finalPath);
      if (!header.ok) {
        await deleteModelFile(finalPath);
        set({ error: header.error ?? "Not a valid GGUF file." });
        return;
      }

      // A digest the user gave us wins; otherwise look for one next to the file.
      const expected =
        normalizeSha256(expectedSha256) ??
        parseSha256File(expectedSha256) ??
        (await readAdjacentChecksum(uri));

      let digest: string | null = null;
      try {
        digest = await sha256File(finalPath);
      } catch (err) {
        if (expected) {
          await deleteModelFile(finalPath);
          set({
            error: `Could not verify the file: ${
              err instanceof Error ? err.message : String(err)
            }. Nothing was imported.`,
          });
          return;
        }
        digest = null; // no digest to check against — carry on without one
      }

      if (expected) {
        if (digest === null) {
          await deleteModelFile(finalPath);
          set({
            error:
              "Could not verify the file: hashing is unavailable on this build. " +
              "Nothing was imported.",
          });
          return;
        }
        if (digest !== expected) {
          await deleteModelFile(finalPath);
          set({
            error:
              "That file does not match the SHA-256 you provided. Nothing was " +
              "imported.",
          });
          return;
        }
      }

      const trust: ModelTrust = expected
        ? "verified_user_checksum"
        : digest
          ? "user_supplied_baseline"
          : "unverified";

      const valid = await validateGguf(finalPath);
      if (!valid.ok) {
        await deleteModelFile(finalPath);
        set({ error: valid.error ?? "Invalid GGUF file." });
        return;
      }

      const info = await FileSystem.getInfoAsync(finalPath);
      const model = await insertModel({
        displayName: fileName.replace(/\.gguf$/i, ""),
        filePath: finalPath,
        hfFile: finalPath.split("/").pop() ?? fileName,
        sizeBytes: info.exists ? (info.size ?? 0) : 0,
        contextSize: 4096,
        role: "primary",
        state: "ready",
        sha256: digest,
        trust,
      });

      await get().refresh();
      const active = await getActiveModel();
      if (!active) await get().activate(model.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  // On-demand re-check, and the way back for a model that has been marked
  // unusable.
  //
  // Re-downloading multi-GB weights to fix a DATABASE row is the wrong answer,
  // and deleting the user's file to "fix" it is worse. So this re-establishes
  // the facts from the bytes that are already on disk:
  //
  //   digest matches the repo's published oid → verified_upstream, usable again
  //   digest matches the one on record        → trust kept, usable again
  //   digest mismatch                         → errored, NOT activated, said plainly
  //   no digest obtainable                    → stays unverified (nothing is
  //                                             claimed), but an intact file is
  //                                             made usable rather than stranded
  //
  // Manual by design: hashing several GB takes seconds, which does not belong
  // in a cold start (activate() does the cheap size check instead).
  verifyIntegrity: async (id: string) => {
    set({ busy: true, error: null });
    try {
      const model = await getModelById(id);
      if (!model) return;

      const info = await FileSystem.getInfoAsync(model.filePath);
      if (!info.exists) {
        await setModelState(id, "error");
        await get().refresh();
        set({ error: `${model.displayName}: the file is gone — re-download it.` });
        return;
      }
      const actualSize = info.size ?? 0;

      const digest = await sha256File(model.filePath);
      if (digest === null) {
        set({ error: "File hashing is unavailable on this build." });
        return;
      }

      // The authoritative digest, when the model came from a repo. A network
      // failure here is NOT a verification failure — it is not knowing.
      let upstream: string | null = null;
      let upstreamReachable = true;
      if (model.hfRepo && model.hfFile) {
        try {
          upstream = normalizeSha256(await fetchExpectedSha256(model.hfRepo, model.hfFile));
        } catch {
          upstreamReachable = false;
        }
      }

      if (upstream) {
        if (digest === upstream) {
          await setModelIntegrity(id, {
            sha256: digest,
            trust: "verified_upstream",
            state: "ready",
            sizeBytes: actualSize,
          });
          await get().refresh();
          set({ error: `${model.displayName} verified against ${model.hfRepo}. Ready to use.` });
          return;
        }
        await setModelState(id, "error");
        await get().refresh();
        set({
          error: `${model.displayName} does NOT match the SHA-256 published by ${model.hfRepo}. It has not been activated — delete and re-download it.`,
        });
        return;
      }

      // No upstream digest. Fall back to whatever was recorded for this file.
      const recorded = normalizeSha256(model.sha256);
      if (recorded) {
        if (digest === recorded) {
          await setModelIntegrity(id, { state: "ready", sizeBytes: actualSize });
          await get().refresh();
          set({ error: `${model.displayName} still matches its recorded SHA-256.` });
          return;
        }
        await setModelState(id, "error");
        await get().refresh();
        set({
          error: `${model.displayName} has CHANGED since it was recorded. It has not been activated.`,
        });
        return;
      }

      // Nothing authoritative to check against. Say so rather than implying a
      // pass — but an intact file should not be stranded either, so record the
      // digest as a baseline and let it be used, still labelled unverified.
      await setModelIntegrity(id, {
        sha256: digest,
        trust: "unverified",
        state: "ready",
        sizeBytes: actualSize,
      });
      await get().refresh();
      set({
        error: upstreamReachable
          ? `${model.displayName}: its repository publishes no SHA-256, so it stays unverified. The file is intact and usable.`
          : `${model.displayName}: couldn't reach ${model.hfRepo} to check it, so it stays unverified. The file is intact and usable.`,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  activate: async (id: string) => {
    // Already active AND actually resident: the tap has nothing to do.
    // Deliberately synchronous, read from store state before anything awaits,
    // so a card that is already Active never flashes "Loading model…" on its
    // way to finding that out. Tearing down a warm QAIRT session and building
    // an identical one costs the user 14 s to arrive where they already were,
    // and the ~6 ms warm reuse in the diagnostics is exactly what that would
    // throw away.
    // "Already active AND the loaded session is the one a load would build now."
    //
    // The second half used to be `engine.loaded && engine.path === filePath` —
    // model IDENTITY, which is not the same question. A GenieX llama.cpp model
    // loaded as `npu` and then re-activated after the compute unit was switched
    // to `hybrid` satisfied that test perfectly, so activation returned here,
    // the native session was never rebuilt, and the run went on executing on
    // pinned HTP0 while everything downstream called it hybrid. sessionMatches()
    // asks the backend what configuration it WOULD load with and compares it to
    // what the live session was built with, so a changed setting reloads and an
    // unchanged one still costs nothing.
    const known = get().installed.find((m) => m.id === id);
    if (known?.isActive && sessionMatches(backendModelRef(known))) {
      return;
    }

    // The second tap on the card that is already loading. Join the load that is
    // running rather than start another: awaiting activate() has to mean "this
    // model is now active", and a caller told that early (remove(),
    // reloadActive()) would act on a model still ten seconds away.
    if (inFlightActivation?.id === id) return inFlightActivation.promise;

    // A DIFFERENT model while one is loading. Refused, not queued: the load in
    // flight owns the single runtime slot for the next ~14 s, and a queue would
    // only mean waiting 28 s for a model that was asked for once. Refusing says
    // so on the row — it is never a silent no-op.
    if (inFlightActivation) {
      const pendingId = inFlightActivation.id;
      const other =
        get().installed.find((m) => m.id === pendingId)?.displayName ??
        "another model";
      failActivation(
        set,
        id,
        `Still loading ${other}. Wait for it to finish, then try again.`,
      );
      return;
    }

    const promise = runActivation(set, get, id).finally(() => {
      inFlightActivation = null;
      set({ activating: null });
      // Always reflect what's actually loaded in native, even if the registry
      // write failed after a successful load (H2).
      useChatStore.getState().updateModelStatus();
    });
    inFlightActivation = { id, promise };
    return promise;
  },

  // Reload the active model so changed perf settings (threads/mlock/KV quant)
  // take effect — a no-op if nothing is active.
  reloadActive: async () => {
    // Never unload from underneath a load that is already running. Without
    // this, a perf change landing during an activation would release the
    // session GenieX is still building, and the activate() below would join
    // that same pending load instead of starting the reload it was asked for.
    if (inFlightActivation) await inFlightActivation.promise.catch(() => {});
    const active = await getActiveModel();
    if (!active) return;
    await unloadModel().catch(() => {});
    await get().activate(active.id);
    // activate() reports load failures via store state, never by throwing —
    // surface them here so callers (Settings updatePerf) can actually revert
    // a rejected setting instead of silently ending up with no model loaded.
    if (!getModelInfo().loaded) {
      throw new Error(get().error ?? "Model reload failed");
    }
  },

  remove: async (id: string) => {
    // Deleting the bundle a QAIRT session is being created from is the one
    // overlap the engine lock cannot help with: the native load holds no
    // reference the model manager would refuse to remove, and the unload below
    // would race the build. Refused while that load is in flight, and said so.
    if (inFlightActivation?.id === id) {
      const name =
        get().installed.find((m) => m.id === id)?.displayName ?? "This model";
      failActivation(set, id, `${name} is still loading — wait, then delete.`);
      return;
    }
    const model = await getModelById(id);
    if (!model) return;
    const wasActive = model.isActive;
    // Unload before deleting the file so llama isn't holding the mmap.
    if (wasActive) {
      await unloadModel().catch(() => {});
      useChatStore.getState().updateModelStatus();
    }
    // Deleting a bundle means asking the runtime that owns it; the path in
    // file_path points INTO the GenieX cache, and unlinking one file out of a
    // multi-file bundle would leave the rest stranded and the manager still
    // believing it has the model.
    //
    // The test is OWNERSHIP — a `runtime_model_name` — not the artifact type.
    // It used to be `isNpuModel(model) && …`, which described the same set only
    // because every GenieX-owned row was a QAIRT bundle, whose artifact is
    // `qairt_context`. A GenieX llama.cpp model breaks that coincidence: its
    // artifact is `gguf`, so isNpuModel() is false, and its file_path points at
    // a .gguf INSIDE the manager's own model directory. The old branch would
    // have unlinked that one file and left geniex.json, the tokenizer and the
    // .lock behind — with the manager still listing the model and getPaths()
    // still resolving to a path that no longer exists. The next load would then
    // fail inside the runtime instead of at a check Vesta could explain.
    // Pinned in both directions by lib/store/__tests__/geniex-gguf-lifecycle.
    if (model.runtimeModelName) {
      await npuRemoveBundle(model.runtimeModelName).catch(() => {});
    } else {
      await deleteModelFile(model.filePath);
    }
    await removeModel(id);

    // Removing the active model: promote another ready model so the app isn't
    // left with no model loaded while others are installed (M1).
    if (wasActive) {
      const replacement = (await listInstalled()).find(
        (m) => m.id !== id && m.state === "ready",
      );
      if (replacement) await get().activate(replacement.id);
    }
    await get().refresh();
  },

  cancel: async (id: string) => {
    // Asked synchronously, before any database round trip: a live NPU install
    // is the case where the first frame after the tap has to say "Canceling",
    // and a read on the way there is a frame the user spends looking at a
    // button that appears to have done nothing.
    if (installIsLive(id)) {
      await get().cancelNpuInstall(id);
      return;
    }
    const model = await getModelById(id);
    // An NPU install is not an HTTP download task and has no file of its own to
    // unlink; it is cancelled through the runtime that started it.
    if (model && isNpuModel(model)) {
      await get().cancelNpuInstall(id);
      return;
    }
    await cancelTask(id);
    if (model) {
      await deleteModelFile(model.filePath);
      await removeModel(id);
    }
    set((s) => {
      const progress = { ...s.progress };
      delete progress[id];
      return { progress };
    });
    await get().refresh();
  },

  clearError: () => set({ error: null }),
}));

// The first unused path for this filename: `model.gguf`, then `model-2.gguf`,
// `model-3.gguf`... Bounded, so a filesystem that reports every path as
// existing can't spin here.
async function freeModelPath(fileName: string): Promise<string> {
  const base = fileName.replace(/\.gguf$/i, "");
  for (let n = 1; n <= 50; n++) {
    const candidate = modelPathFor(n === 1 ? fileName : `${base}-${n}.gguf`);
    const info = await FileSystem.getInfoAsync(candidate);
    if (!info.exists) return candidate;
  }
  // 50 files of the same name is not a real situation; fall back to a unique
  // suffix rather than failing the import.
  return modelPathFor(`${base}-${Date.now()}.gguf`);
}

// Shared download flow for catalog + ad-hoc repo downloads.
async function runDownload(
  set: (partial: Partial<ModelState> | ((s: ModelState) => Partial<ModelState>)) => void,
  get: () => ModelState,
  args: {
    repo: string;
    file: HfFile;
    exactSize: boolean;
    displayName: string;
    quant: string | null;
    minRamMb: number | null;
    contextSize: number;
    role: InstalledModel["role"];
  },
): Promise<void> {
  const fileName = baseName(args.file.path);
  const model = await insertModel({
    displayName: args.displayName,
    hfRepo: args.repo,
    hfFile: fileName,
    filePath: modelPathFor(fileName),
    quant: args.quant,
    sizeBytes: args.file.sizeBytes,
    minRamMb: args.minRamMb,
    sha256: args.file.sha256,
    contextSize: args.contextSize,
    role: args.role,
    state: "downloading",
  });

  const id = model.id;
  set((s) => ({
    progress: {
      ...s.progress,
      [id]: {
        modelId: id,
        status: "downloading",
        bytesWritten: 0,
        bytesTotal: args.file.sizeBytes,
        bytesPerSec: 0,
        etaSeconds: null,
      },
    },
  }));
  await get().refresh();

  const outcome = await downloadModel({
    modelId: id,
    url: resolveUrl(args.repo, args.file.path),
    fileName,
    expectedBytes: args.file.sizeBytes,
    verifySize: args.exactSize,
    // HuggingFace's LFS oid for this file. When present the downloader refuses
    // to promote a file that doesn't hash to it; when absent (non-LFS file, or
    // the repo listing failed and we fell back to the catalog) the download is
    // committed unverified and the user is told so below.
    expectedSha256: args.file.sha256,
    onProgress: (p) =>
      set((s) => ({
        progress: {
          ...s.progress,
          [id]: { modelId: id, status: "downloading", ...p },
        },
      })),
    onResumeToken: (token) => {
      setResumeToken(id, token).catch(() => {});
    },
  });

  // If the row was removed mid-flight (user cancel), stop — and sweep any file
  // the download may have committed in the cancel race so it can't orphan (C1).
  const stillExists = await getModelById(id);
  if (!stillExists) {
    await deleteModelFile(modelPathFor(fileName));
    return;
  }

  // Canceled: drop the row + partial entirely (cancel() usually already did,
  // but cover the race where downloadModel returned canceled first).
  if (outcome.canceled) {
    await deleteModelFile(stillExists.filePath);
    await removeModel(id);
    set((s) => {
      const progress = { ...s.progress };
      delete progress[id];
      return { progress };
    });
    await get().refresh();
    return;
  }

  // Paused: keep the row + partial so the user can resume later.
  if (outcome.paused) {
    await setModelState(id, "paused");
    await get().refresh();
    return;
  }

  if (!outcome.ok) {
    await setModelState(id, "error");
    set((s) => ({
      progress: {
        ...s.progress,
        [id]: {
          modelId: id,
          status: "error",
          bytesWritten: 0,
          bytesTotal: args.file.sizeBytes,
          bytesPerSec: 0,
          etaSeconds: null,
          error: outcome.error,
        },
      },
    }));
    await get().refresh();
    set({ error: outcome.error ?? "Download failed." });
    return;
  }

  // Verify it actually loads as a GGUF before marking ready.
  const valid = await validateGguf(outcome.filePath!);
  if (!valid.ok) {
    await deleteModelFile(outcome.filePath!);
    await setModelState(id, "error");
    await get().refresh();
    set({ error: valid.error ?? "Downloaded file is not a valid model." });
    return;
  }

  await finalizeModel(id, {
    filePath: outcome.filePath,
    sizeBytes: outcome.sizeBytes,
    // Only a digest we computed AND matched is recorded as such.
    sha256: outcome.sha256 ?? null,
    trust: outcome.verified ? "verified_upstream" : "unverified",
  });

  // Reaching here unverified means one thing only: the repo published no
  // SHA-256, so there was nothing authoritative to check (a failed or
  // impossible check against an existing digest never commits). Say so rather
  // than letting "ready" imply the bytes were vouched for.
  if (!outcome.verified) {
    set({
      error: `${args.displayName} was installed without an integrity check — its repository publishes no SHA-256 for this file.`,
    });
  }
  set((s) => {
    const progress = { ...s.progress };
    delete progress[id];
    return { progress };
  });
  await get().refresh();

  // Auto-activate the first model the user installs. Guarded so concurrent
  // downloads don't both pass the no-active-model check and double-load (H1).
  if (!autoActivateInFlight) {
    autoActivateInFlight = true;
    try {
      const active = await getActiveModel();
      if (!active) await get().activate(id);
    } finally {
      autoActivateInFlight = false;
    }
  }
}
