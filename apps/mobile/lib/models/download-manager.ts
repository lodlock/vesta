// Resumable GGUF downloader built on expo-file-system's createDownloadResumable.
// No native code — this replaces anti-vocale's Kotlin ResumeDownloadHelper +
// DownloadRetryHelper + ProgressThrottler entirely in TypeScript.
//
// Key behaviours:
//  - downloads DIRECT to `<final>.download` then renames to `<final>` (no
//    double-disk-copy: the file never exists twice except briefly at rename),
//  - free-space preflight before starting,
//  - progress throttled to ~1/sec with a sliding bytes/sec + ETA,
//  - pause/resume across app restarts via the saved resume token,
//  - size verification against the authoritative HF byte size before commit,
//  - SHA-256 verification against HuggingFace's LFS oid before commit.
//
// INTEGRITY: size alone proves nothing about content — a truncating proxy, a
// corrupted resume, or a substituted file can all land at the right length. A
// .gguf is mmap'ed and executed as model weights, so the finished temp file is
// digested (natively, streaming) and compared to the expected sha256 BEFORE the
// rename that promotes it to the usable model path. A mismatch quarantines the
// file and fails the download; it is never renamed into place.

import * as FileSystem from "expo-file-system/legacy";
import { computeRate, etaSeconds, hasEnoughSpace } from "./format";
import { sha256File, normalizeSha256 } from "../native/file-hash";

export const MODELS_DIR = FileSystem.documentDirectory + "models/";

export function modelPathFor(fileName: string): string {
  return MODELS_DIR + fileName;
}

export function tempPathFor(finalPath: string): string {
  return finalPath + ".download";
}

// A file that failed verification is moved aside rather than silently dropped:
// the bytes are evidence (truncated? substituted? corrupted resume?) and a
// fixed name means a retry can't accumulate junk. Removed on the next attempt.
export function quarantinePathFor(finalPath: string): string {
  return finalPath + ".corrupt";
}

const PROGRESS_INTERVAL_MS = 800;
// Accept a tiny mismatch (some CDNs report size off by a few bytes); a real
// truncation is far larger than this.
const SIZE_TOLERANCE_BYTES = 1024;

interface ActiveTask {
  task: FileSystem.DownloadResumable;
  canceled: boolean;
}

const active = new Map<string, ActiveTask>();

export interface DownloadParams {
  modelId: string;
  url: string;
  fileName: string; // final name inside MODELS_DIR
  expectedBytes: number; // 0 = unknown (skip preflight + size verify)
  // Whether expectedBytes is authoritative (from the HF tree API) and may be
  // used to reject a truncated download. False for the catalog's approximate
  // size, which must not fail a genuinely complete download.
  verifySize?: boolean;
  // The expected SHA-256 (HuggingFace's LFS oid). When present, the completed
  // file MUST match it or the download fails. Absent (a non-LFS file, or a repo
  // listing that failed) means the content cannot be verified — the outcome
  // reports that rather than implying a passed check.
  expectedSha256?: string | null;
  headers?: Record<string, string>;
  resumeToken?: string | null;
  onProgress?: (p: {
    bytesWritten: number;
    bytesTotal: number;
    bytesPerSec: number;
    etaSeconds: number | null;
  }) => void;
  onResumeToken?: (token: string) => void;
}

export interface DownloadOutcome {
  ok: boolean;
  canceled?: boolean; // user canceled — partial discarded, no row should survive
  paused?: boolean; // paused — partial kept, resume later via resumeToken
  resumeToken?: string;
  filePath?: string;
  sizeBytes?: number;
  // The verified digest, set only when it was computed AND matched. Undefined
  // means unverified (no expected hash, or no native hashing available).
  sha256?: string;
  // True when an expected hash was present and the file matched it.
  verified?: boolean;
  // Set when verification could not run at all (no expected hash / no native
  // support), so callers can surface "installed but unverified".
  unverifiedReason?: "no-expected-hash" | "hashing-unavailable";
  error?: string;
}

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

export async function getFreeBytes(): Promise<number> {
  try {
    return await FileSystem.getFreeDiskStorageAsync();
  } catch {
    return Number.POSITIVE_INFINITY; // unknown — don't block on it
  }
}

export function isDownloading(modelId: string): boolean {
  return active.has(modelId);
}

export async function downloadModel(
  params: DownloadParams,
): Promise<DownloadOutcome> {
  const {
    modelId,
    url,
    fileName,
    expectedBytes,
    verifySize = true,
    expectedSha256,
    headers,
    resumeToken,
    onProgress,
    onResumeToken,
  } = params;

  await ensureModelsDir();

  if (expectedBytes > 0) {
    const free = await getFreeBytes();
    if (!hasEnoughSpace(free, expectedBytes)) {
      return {
        ok: false,
        error: `Not enough free space — need ~${Math.ceil(
          (expectedBytes * 1.1) / 1e9,
        )} GB.`,
      };
    }
  }

  const finalPath = modelPathFor(fileName);
  const tempPath = tempPathFor(finalPath);

  // Drop any quarantined file from a previous failed attempt (a resume keeps
  // its own temp file; the quarantine is never resumed from).
  await safeDelete(quarantinePathFor(finalPath));

  // Throttled progress + sliding-window rate/ETA.
  let lastEmit = 0;
  let prevMs = Date.now();
  let prevBytes = 0;
  let rate = 0;

  const callback = (data: FileSystem.DownloadProgressData) => {
    const now = Date.now();
    const written = data.totalBytesWritten;
    const total = data.totalBytesExpectedToWrite;
    const instant = computeRate(prevBytes, prevMs, written, now);
    // Smooth the rate so the ETA doesn't jitter.
    rate = rate === 0 ? instant : rate * 0.7 + instant * 0.3;
    prevMs = now;
    prevBytes = written;
    if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
      lastEmit = now;
      onProgress?.({
        bytesWritten: written,
        bytesTotal: total > 0 ? total : expectedBytes,
        bytesPerSec: rate,
        etaSeconds: etaSeconds(written, total > 0 ? total : expectedBytes, rate),
      });
    }
  };

  const task = FileSystem.createDownloadResumable(
    url,
    tempPath,
    headers ? { headers } : {},
    callback,
    resumeToken ?? undefined,
  );

  const entry: ActiveTask = { task, canceled: false };
  active.set(modelId, entry);

  try {
    const result = resumeToken
      ? await task.resumeAsync()
      : await task.downloadAsync();

    // undefined => the task was paused or canceled.
    if (!result) {
      // Cancel takes priority: drop the partial entirely.
      if (entry.canceled) {
        await safeDelete(tempPath);
        return { ok: false, canceled: true };
      }
      // Paused: keep the partial and persist the resume token to continue later.
      let resumeToken: string | undefined;
      try {
        resumeToken = task.savable().resumeData;
        if (resumeToken) onResumeToken?.(resumeToken);
      } catch {
        /* best-effort */
      }
      return { ok: false, paused: true, resumeToken };
    }

    // Verify the downloaded file before committing it as the model.
    const info = await FileSystem.getInfoAsync(tempPath);
    if (!info.exists) {
      return { ok: false, error: "Downloaded file is missing." };
    }
    const actualSize = info.size ?? 0;
    // Only reject against an authoritative size; the catalog's approximate size
    // must never fail a complete download. A truncation is always smaller.
    if (
      verifySize &&
      expectedBytes > 0 &&
      actualSize < expectedBytes - SIZE_TOLERANCE_BYTES
    ) {
      await safeDelete(tempPath);
      return {
        ok: false,
        error: `Download incomplete (${actualSize} of ${expectedBytes} bytes). Try again.`,
      };
    }

    // Content verification, before anything is promoted. Runs on the temp path
    // so a mismatch can never reach the model directory.
    const expected = normalizeSha256(expectedSha256);
    let verified = false;
    let sha: string | undefined;
    let unverifiedReason: DownloadOutcome["unverifiedReason"];
    if (expected) {
      let actual: string | null;
      try {
        actual = await sha256File(tempPath);
      } catch (e) {
        await quarantine(tempPath, finalPath);
        return {
          ok: false,
          error: `Could not verify the download: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
      if (actual === null) {
        // No native hashing on this build — the file is intact as far as we can
        // tell, but say so instead of claiming it was checked.
        unverifiedReason = "hashing-unavailable";
      } else if (actual !== expected) {
        // Quarantine, never commit. The resume token is worthless too: resuming
        // would append to already-wrong bytes.
        await quarantine(tempPath, finalPath);
        return {
          ok: false,
          error:
            "Downloaded file failed its integrity check (SHA-256 mismatch). " +
            "The file was discarded — check your network and try again.",
        };
      } else {
        verified = true;
        sha = actual;
      }
    } else {
      unverifiedReason = "no-expected-hash";
    }

    // A cancel may have landed while the download was finishing (the awaits
    // above are yield points, and hashing a multi-GB file is a long one). Do
    // NOT commit, or we'd recreate a multi-GB file with no DB row pointing at
    // it (orphan). Drop the partial and bail.
    if (entry.canceled) {
      await safeDelete(tempPath);
      return { ok: false, canceled: true };
    }

    // Commit: replace any existing final file with the verified temp file.
    await safeDelete(finalPath);
    await FileSystem.moveAsync({ from: tempPath, to: finalPath });

    // Final 100% tick.
    onProgress?.({
      bytesWritten: actualSize,
      bytesTotal: actualSize,
      bytesPerSec: rate,
      etaSeconds: 0,
    });

    return {
      ok: true,
      filePath: finalPath,
      sizeBytes: actualSize,
      sha256: sha,
      verified,
      unverifiedReason,
    };
  } catch (err) {
    if (entry.canceled) {
      await safeDelete(tempPath);
      return { ok: false, canceled: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    active.delete(modelId);
  }
}

export async function cancelDownload(modelId: string): Promise<void> {
  const entry = active.get(modelId);
  if (!entry) return;
  entry.canceled = true;
  try {
    await entry.task.cancelAsync();
  } catch {
    /* already finished */
  }
  active.delete(modelId);
}

// Pause and return the resume token (to persist), or null if not pausable.
export async function pauseDownload(modelId: string): Promise<string | null> {
  const entry = active.get(modelId);
  if (!entry) return null;
  try {
    const state = await entry.task.pauseAsync();
    return state.resumeData ?? null;
  } catch {
    return null;
  }
}

export async function deleteModelFile(filePath: string): Promise<void> {
  await safeDelete(filePath);
  await safeDelete(tempPathFor(filePath));
  await safeDelete(quarantinePathFor(filePath));
}

// Move a failed download aside. Best-effort: if the move fails the file is
// deleted instead — a file that failed verification must not survive at the
// temp path, where a later resume could append to it.
async function quarantine(tempPath: string, finalPath: string): Promise<void> {
  const target = quarantinePathFor(finalPath);
  try {
    await safeDelete(target);
    await FileSystem.moveAsync({ from: tempPath, to: target });
  } catch {
    await safeDelete(tempPath);
  }
}

async function safeDelete(path: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    /* best-effort cleanup */
  }
}
