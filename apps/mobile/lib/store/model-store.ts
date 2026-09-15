// Zustand store for the model manager. Coordinates the catalog, HuggingFace
// download, the SQLite registry, and llama.rn (load/unload), and exposes live
// download progress to the Models screen.

import { create } from "zustand";
import * as FileSystem from "expo-file-system/legacy";
import type {
  CatalogModel,
  DownloadProgress,
  InstalledModel,
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
import { npuCatalogFor, type NpuCatalogModel } from "../models/npu-catalog";
import { prepareNpuBackend, type NpuReadiness } from "../models/npu-ready";
import {
  checkBundle,
  toBundleFiles,
  verifyAgainstBaseline,
  type MeasuredBundle,
} from "../models/npu-bundle";
import { isNpuModel } from "../models/npu-compat";
import {
  npuPull,
  npuCancelPull,
  npuBundleInfo,
  npuRemoveBundle,
  onNpuPullProgress,
} from "../native/npu";
import { checkGgufFile } from "../models/gguf-header";
import { parseSha256File, readAdjacentChecksum } from "../models/integrity";
import { sha256File, normalizeSha256 } from "../native/file-hash";
import { getDeviceCaps, type DeviceCaps } from "../models/device-caps";
import { loadModel, unloadModel, validateGguf, getModelInfo } from "../llm/llm-engine";
import { warmSessionCache } from "../orchestrator/session-warmer";
import { getPerfSettings, perfToLlmOptions } from "../llm/perf-config";
import { useChatStore } from "./chat-store";

// Serializes the "first model auto-activates" decision so two near-simultaneous
// downloads can't both fire a (multi-GB) load (H1 TOCTOU).
let autoActivateInFlight = false;

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

  refresh: () => Promise<void>;
  installNpuModel: (model: NpuCatalogModel) => Promise<void>;
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

export const useModelStore = create<ModelState>((set, get) => ({
  installed: [],
  progress: {},
  freeBytes: null,
  caps: null,
  busy: false,
  error: null,
  npu: {
    inBuild: false,
    available: false,
    reason: null,
    runtimeVersion: null,
    soc: null,
    runtimeChipset: undefined,
    canonicalSoc: null,
    chipsets: undefined,
  },
  npuCatalog: [],

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

  // -- NPU bundle install -------------------------------------------------
  //
  // Nothing here shares code with the GGUF download path, and that is the
  // point. A GGUF is one file Vesta fetches over HTTP into its own models
  // directory. A context bundle is many files whose URLs are resolved from a
  // chipset-keyed release manifest only the GenieX SDK can read, landing in the
  // SDK's own cache under filesDir/geniex. The two never touch the same
  // directory, so a failed NPU install cannot truncate, overwrite or delete a
  // working GGUF -- see npu-bundle.bundleIsolatedFromGguf.
  installNpuModel: async (model: NpuCatalogModel) => {
    set({ error: null });

    const npu = get().npu;
    if (!npu.available) {
      set({
        error:
          npu.reason ??
          "There is no Qualcomm NPU runtime in this build, so an NPU model cannot be installed.",
      });
      return;
    }

    // The same refusal the backend would give at load time, applied BEFORE
    // several gigabytes are spent rather than after.
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

    if (get().installed.some((m) => m.runtimeModelName === model.modelName)) {
      set({ error: `${model.displayName} is already installed.` });
      return;
    }

    // A placeholder row so the download is visible, cancellable and -- above
    // all -- recoverable: a process killed mid-pull leaves a row in
    // "downloading" that the user can see and cancel, rather than gigabytes in
    // a cache directory nothing references.
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
      runtimeModelName: model.modelName,
      trust: "unverified",
    });
    await get().refresh();

    const unsubscribe = onNpuPullProgress((p) => {
      if (p.modelName !== model.modelName) return;
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

    try {
      const bundle = await npuPull({
        modelName: model.modelName,
        // The runtime's OWN name for this chip when it has one, and only the
        // catalog's SoC id as a fallback. `listChipsets()` is the vocabulary
        // the AI Hub release manifest is keyed by, so asking for assets in the
        // runtime's own words is the request most likely to resolve; the
        // canonical layer has already established the two name one chip.
        chipset: npu.runtimeChipset ?? model.targetSoc,
        precision: model.precision,
        hub: model.hub,
        displayName: model.displayName,
      });

      // Everything that could make this unloadable, decided from the file
      // listing rather than from a load attempt that costs 20+ seconds and an
      // out-of-memory risk to learn the same thing.
      const check = checkBundle(bundle as MeasuredBundle);
      if (!check.ok) {
        // Removes the bundle, and only the bundle: this addresses the GenieX
        // cache entry for this model name and nothing else on disk.
        await npuRemoveBundle(model.modelName).catch(() => {});
        await removeModel(row.id);
        await get().refresh();
        set({ error: `${model.displayName}: ${check.message}` });
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
      const message = err instanceof Error ? err.message : String(err);
      // A cancelled or failed pull leaves partial files in the SDK's cache,
      // where a later pull resumes them. The ROW goes, because a row pointing
      // at an incomplete bundle is what makes a later load fail confusingly.
      await removeModel(row.id);
      await get().refresh();
      set({ error: `${model.displayName}: ${message}` });
    } finally {
      unsubscribe();
      set((state) => {
        const progress = { ...state.progress };
        delete progress[row.id];
        return { progress };
      });
    }
  },

  cancelNpuInstall: async (id: string) => {
    npuCancelPull();
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
  //      import — same fail-closed rule as a HuggingFace download.
  //   2. no digest → the import proceeds, because explicitly picking a file IS
  //      the trust decision. We hash it anyway and keep that as a baseline, so
  //      an unexpected change to the file later is detectable. That is
  //      integrity from import onwards; it says nothing about provenance.
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
    set({ error: null });
    const model = await getModelById(id);
    if (!model) {
      set({ error: "Model is not ready." });
      return;
    }
    // The SAME check the Models screen draws its buttons from, so a row that
    // looks selectable is selectable and a row that isn't says why. Note what
    // it does not consider: trust. An unverified model is labelled, not
    // blocked — blocking here while the UI didn't would be a second, invisible
    // policy.
    const check = canActivate(model);
    if (!check.ok) {
      set({ error: check.message });
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
        set({ error: `${model.displayName}: the bundle is gone — reinstall it.` });
        return;
      }
    } else {
      const info = await FileSystem.getInfoAsync(model.filePath);
      if (!info.exists) {
        await setModelState(id, "error");
        await get().refresh();
        set({ error: "Model file is missing — re-download it." });
        return;
      }
      // Cheap integrity gate on every load: the size must still be the size we
      // recorded. Re-hashing a multi-GB file here would add seconds to every cold
      // start, so the full check lives in verifyIntegrity(); this catches the
      // common case (a file replaced or truncated under us) for free.
      if (model.sizeBytes > 0 && (info.size ?? 0) !== model.sizeBytes) {
        await setModelState(id, "error");
        await get().refresh();
        set({
          error: `${model.displayName} changed on disk (${info.size ?? 0} bytes, expected ${model.sizeBytes}). Tap Verify to check it against its source.`,
        });
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
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      // Always reflect what's actually loaded in native, even if the registry
      // write failed after a successful load (H2).
      useChatStore.getState().updateModelStatus();
    }
  },

  // Reload the active model so changed perf settings (threads/mlock/KV quant)
  // take effect — a no-op if nothing is active.
  reloadActive: async () => {
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
    if (isNpuModel(model) && model.runtimeModelName) {
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
