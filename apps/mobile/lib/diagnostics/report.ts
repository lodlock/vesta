// The diagnostics report exists twice, on purpose.
//
// The clipboard cannot carry the whole thing. `ClipboardManager.setPrimaryClip`
// is a Binder call and the report reached 3.38 MB, which the kernel refuses
// with a fatal TransactionTooLargeException (see clipboard-safe.ts). The fix
// that stopped the crash — trim to 64 KiB and mark the cut — was safe but
// lossy: the answer to the question being asked could be below the cut line.
//
// So the clipboard stops being the transport for the whole report, and the
// report is built as two artefacts from one set of sections:
//
//   SUMMARY  a few KB, the identity/state/outcome fields, clipboard-safe by
//            construction. Never contains a per-file inventory, so it does not
//            grow with the number of cached manifests and should never trim.
//   FULL     everything, no ceiling, delivered as a file through the share
//            sheet. See deliver.ts — it never touches the clipboard.
//
// A section declares both forms. `summary` is what a reader needs to say what
// state the device is in; `full` is that plus whatever bulk answers a follow-up
// question. A section with no `full` is the same in both, which is the common
// case for a handful of fields.

import {
  CLIPBOARD_MAX_BYTES,
  assembleReport,
  utf8ByteLength,
  type ReportSection,
} from "./clipboard-safe";

export interface DiagnosticsSection {
  /** Short name, used in the summary's "omitted" notice when one is needed. */
  name: string;
  /** The compact form. Goes to the clipboard. */
  summary: string;
  /** The complete form. Defaults to `summary` when a section has no bulk. */
  full?: string;
  /**
   * Kept in the summary even if something has to go.
   *
   * See clipboard-safe.ts: non-essential sections are dropped from the end
   * before any text is cut. Nothing here affects the full report, which is
   * never reduced for any reason.
   */
  essential?: boolean;
}

export interface DiagnosticsReports {
  /** Clipboard-safe. Within `limitBytes` whatever the sections contained. */
  summary: string;
  summaryBytes: number;
  /** True if the summary had to drop or cut anything — a bug, not a mode. */
  summaryTruncated: boolean;
  /** Names of sections left out of the summary, in the order they were. */
  omitted: string[];
  /** Complete. Never trimmed, never capped, never abbreviated. */
  full: string;
  fullBytes: number;
}

const FULL_HEADER =
  "VESTA DIAGNOSTICS — FULL REPORT\n" +
  "Complete: nothing here is abbreviated or omitted. The in-app \"Copy summary\"\n" +
  "action produces a shorter form of the same sections for pasting into a chat.";

/**
 * Builds both artefacts from one ordered list of sections.
 *
 * Order matters for the summary only: it is the order the clipboard-safe
 * assembler drops things in, so the most-wanted section goes first.
 */
export function buildReports(
  sections: DiagnosticsSection[],
  limitBytes: number = CLIPBOARD_MAX_BYTES,
): DiagnosticsReports {
  const compactSections: ReportSection[] = sections.map((s) => ({
    name: s.name,
    body: s.summary,
    essential: s.essential,
  }));
  const compact = assembleReport(compactSections, limitBytes);

  const full = [
    FULL_HEADER,
    ...sections.map((s) => s.full ?? s.summary).filter((b) => b.trim().length > 0),
  ].join("\n\n");

  return {
    summary: compact.text,
    summaryBytes: compact.bytes,
    summaryTruncated: compact.truncated,
    omitted: compact.omitted,
    full,
    fullBytes: utf8ByteLength(full),
  };
}

/** The prefix every diagnostics file carries, and what cleanup recognises. */
export const REPORT_FILE_PREFIX = "vesta-diagnostics-";
const REPORT_FILE_SUFFIX = ".txt";

/**
 * `vesta-diagnostics-2026-09-16-1819.txt`, in the device's local time.
 *
 * Minute precision, and deliberately no seconds: sharing twice inside a minute
 * overwrites one file rather than leaving two, which keeps the cache directory
 * from filling with near-identical reports during a debugging session. The name
 * is built from digits and hyphens only, so there is nothing in it to escape
 * and nothing a share target can read as a path.
 */
export function diagnosticsFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${REPORT_FILE_PREFIX}${stamp}${REPORT_FILE_SUFFIX}`;
}

/** Whether a directory entry is one of ours, and therefore ours to delete. */
export function isDiagnosticsFileName(name: string): boolean {
  return (
    name.startsWith(REPORT_FILE_PREFIX) &&
    name.endsWith(REPORT_FILE_SUFFIX) &&
    /^vesta-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/.test(name)
  );
}
