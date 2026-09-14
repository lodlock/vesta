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
import { listGgufFiles, resolveUrl, type HfFile } from "../models/hf-client";
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

interface ModelState {
  installed: InstalledModel[];
  progress: Record<string, DownloadProgress>;
  freeBytes: number | null;
  caps: DeviceCaps | null;
  busy: boolean;
  error: string | null;

  refresh: () => Promise<void>;
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

  refresh: async () => {
    const [installed, caps] = await Promise.all([listInstalled(), getDeviceCaps()]);
    set({
      installed,
      caps,
      freeBytes: Number.isFinite(caps.freeBytes) ? caps.freeBytes : null,
    });
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

  // On-demand full re-check: re-hash the file and compare it to the digest on
  // record. This is what turns the import baseline into something useful — it
  // answers "is this still the file I imported?". Deliberately manual: hashing
  // a multi-GB model takes seconds, so it does not belong on every app start
  // (activate() does the cheap size check instead).
  verifyIntegrity: async (id: string) => {
    set({ busy: true, error: null });
    try {
      const model = await getModelById(id);
      if (!model) return;
      const info = await FileSystem.getInfoAsync(model.filePath);
      if (!info.exists) {
        await setModelState(id, "error");
        set({ error: "Model file is missing — re-download or re-import it." });
        return;
      }
      const digest = await sha256File(model.filePath);
      if (digest === null) {
        set({ error: "File hashing is unavailable on this build." });
        return;
      }
      if (!model.sha256) {
        // Nothing on record to compare against (an older row): adopt this as the
        // baseline rather than claiming anything about where the file came from.
        await setModelIntegrity(id, { sha256: digest, trust: "user_supplied_baseline" });
        await get().refresh();
        set({ error: `Recorded a new integrity baseline for ${model.displayName}.` });
        return;
      }
      if (digest !== model.sha256) {
        await setModelState(id, "error");
        await get().refresh();
        set({
          error: `${model.displayName} has CHANGED since it was recorded — the file no longer matches its SHA-256. It has been marked unusable.`,
        });
        return;
      }
      await get().refresh();
      set({ error: `${model.displayName} still matches its recorded SHA-256.` });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  activate: async (id: string) => {
    set({ error: null });
    const model = await getModelById(id);
    if (!model || model.state !== "ready") {
      set({ error: "Model is not ready." });
      return;
    }
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
        error: `${model.displayName} changed on disk (${info.size ?? 0} bytes, expected ${model.sizeBytes}). It was not loaded — verify or re-import it.`,
      });
      return;
    }
    try {
      const perf = perfToLlmOptions(await getPerfSettings());
      await loadModel(model.filePath, {
        ...perf,
        contextSize: model.contextSize,
        gpuLayers: 0,
        chatTemplate: model.chatTemplate ?? undefined,
      });
      // Same as the app-start path (chat-store.init): restore this model's
      // persisted prefix KV before any completion. Switching back to a model
      // whose session file is on disk skips the ~30s cold prefill.
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
    await deleteModelFile(model.filePath);
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
    await cancelTask(id);
    const model = await getModelById(id);
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
