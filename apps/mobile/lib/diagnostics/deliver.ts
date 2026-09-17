// The two ways a diagnostics report leaves the device, and the line between
// them.
//
//   Copy summary       a few KB of identity, state and outcome, through the
//                      clipboard, for pasting into a chat or an issue.
//   Share full report  everything, as a UTF-8 .txt file, through Android's
//                      share sheet.
//
// The split is not a preference. `Clipboard.setString` is
// `ClipboardManager.setPrimaryClip`, which is a Binder call, and every Binder
// transaction in a process shares a buffer of about a megabyte. The full
// report has been 3.38 MB; the kernel refuses a parcel that size and the
// exception is fatal. Capping the clipboard payload (clipboard-safe.ts) stopped
// the crash, but a capped report is a report with the answer possibly below the
// cut line — so the full report needed a transport with no such ceiling.
//
// A content:// URI is that transport. It is a handle, not a payload: the
// recipient streams the bytes through ContentResolver, so the size of the
// report stops being a transport concern at all.
//
// Clipboard is imported in this file and is used by exactly one function.
// `shareFullReport` must never reach it, whatever it is asked to send — that is
// the property `__tests__/deliver.test.ts` pins down.

import { Clipboard } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

import { CLIPBOARD_MAX_BYTES, clipboardSafe, utf8ByteLength } from "./clipboard-safe";
import { diagnosticsFileName, isDiagnosticsFileName } from "./report";
import { shareFile } from "../native/system-actions";

/** Subdirectory of the app cache. Matches res/xml/vesta_file_paths.xml. */
export const DIAGNOSTICS_DIR = "diagnostics";

/**
 * How many reports the cache may hold.
 *
 * Small on purpose. These are debugging artefacts with a lifetime of one
 * conversation, they live in the cache directory (which Android may clear
 * whenever it likes), and keeping a handful is what makes "share the one from
 * before the reboot" possible without letting a session's worth of reports
 * accumulate. Three is two more than strictly needed.
 */
export const MAX_KEPT_REPORTS = 3;

export interface CopyOutcome {
  copied: boolean;
  bytes: number;
  /** True only if the summary somehow exceeded the cap — a bug, not a mode. */
  truncated: boolean;
  error?: string;
}

/**
 * Puts the SUMMARY on the clipboard, never the full report.
 *
 * `clipboardSafe` should be a no-op here: the summary is built without any
 * per-file inventory and runs a few KB. It stays because it is the last thing
 * between any string and Binder, and it makes this function structurally
 * incapable of crashing the app if some future section grows — rather than
 * relying on nobody letting it.
 */
export function copySummary(summary: string): CopyOutcome {
  const safe = clipboardSafe(summary, CLIPBOARD_MAX_BYTES);
  try {
    Clipboard.setString(safe.text);
    return { copied: true, bytes: safe.bytes, truncated: safe.truncated };
  } catch (err) {
    // Report the failure rather than claim a copy that did not happen.
    return {
      copied: false,
      bytes: safe.bytes,
      truncated: safe.truncated,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ShareOutcome {
  shared: boolean;
  /** The name the recipient sees. Never a private filesystem path. */
  fileName: string;
  bytes: number;
  /** How many old reports were removed on the way out. */
  cleaned: number;
  error?: string;
}

/** Injected in tests; production uses the real modules. */
export interface ShareDeps {
  cacheDirectory: string | null;
  makeDirectoryAsync: typeof FileSystem.makeDirectoryAsync;
  writeAsStringAsync: typeof FileSystem.writeAsStringAsync;
  readDirectoryAsync: typeof FileSystem.readDirectoryAsync;
  deleteAsync: typeof FileSystem.deleteAsync;
  share: typeof shareFile;
}

function defaultDeps(): ShareDeps {
  return {
    cacheDirectory: FileSystem.cacheDirectory,
    makeDirectoryAsync: FileSystem.makeDirectoryAsync,
    writeAsStringAsync: FileSystem.writeAsStringAsync,
    readDirectoryAsync: FileSystem.readDirectoryAsync,
    deleteAsync: FileSystem.deleteAsync,
    share: shareFile,
  };
}

/**
 * Writes the full report to the app cache and opens the share sheet.
 *
 * The report is never abbreviated on this path — that is the whole point of it
 * existing — and it never touches the clipboard. No storage permission is
 * asked for or needed: the file is written inside the app's own cache, and the
 * recipient reads it through a one-URI FileProvider grant.
 *
 * Every failure is caught and returned. A diagnostics screen that crashed while
 * trying to report a problem would be a poor diagnostics screen.
 */
export async function shareFullReport(
  full: string,
  at: Date = new Date(),
  deps: ShareDeps = defaultDeps(),
): Promise<ShareOutcome> {
  const fileName = diagnosticsFileName(at);
  const bytes = utf8ByteLength(full);
  let cleaned = 0;

  try {
    const root = deps.cacheDirectory;
    if (!root) throw new Error("No cache directory on this platform");
    const dir = `${root.endsWith("/") ? root : `${root}/`}${DIAGNOSTICS_DIR}`;

    await deps.makeDirectoryAsync(dir, { intermediates: true });
    // Default encoding is UTF-8, which is what the .txt claims to be.
    await deps.writeAsStringAsync(`${dir}/${fileName}`, full);

    // Bounded before the share, not after: if the chooser never comes back —
    // the user swipes it away, the process is killed — the directory has
    // already been pruned. Best-effort, and never allowed to fail the share.
    cleaned = await pruneOldReports(dir, deps).catch(() => 0);

    const result = await deps.share(
      `${dir}/${fileName}`,
      "text/plain",
      fileName,
    );
    if (result.status !== "shared") {
      return {
        shared: false,
        fileName,
        bytes,
        cleaned,
        error:
          result.status === "no-handler"
            ? "No app on this device can receive a text file"
            : "Vesta is not in the foreground",
      };
    }
    return { shared: true, fileName, bytes, cleaned };
  } catch (err) {
    return {
      shared: false,
      fileName,
      bytes,
      cleaned,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Keeps the newest MAX_KEPT_REPORTS and deletes the rest.
 *
 * Sorted by NAME, which is legitimate only because the name is a fixed-width
 * timestamp (`vesta-diagnostics-2026-09-16-1819.txt`) — so lexicographic order
 * is chronological order, with no `getInfoAsync` call per file. Entries that do
 * not match that shape are left alone: this directory is ours, but deleting
 * something we did not write is not the cleanup's job.
 */
async function pruneOldReports(dir: string, deps: ShareDeps): Promise<number> {
  const entries = await deps.readDirectoryAsync(dir);
  const ours = entries.filter(isDiagnosticsFileName).sort().reverse();
  const stale = ours.slice(MAX_KEPT_REPORTS);
  let removed = 0;
  for (const name of stale) {
    try {
      await deps.deleteAsync(`${dir}/${name}`, { idempotent: true });
      removed++;
    } catch {
      // A file we cannot delete is not a reason to fail the share.
    }
  }
  return removed;
}
