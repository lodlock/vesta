// A diagnostics report that cannot take the app down on its way to the clipboard.
//
// It did. Three Copy attempts, three crashes, all at the same size:
//
//   android.os.TransactionTooLargeException: data parcel size 3377296 bytes
//     at ClipboardManager.setPrimaryClip()
//     at ReactNative ClipboardModule.setString()
//
// Not OOM, not the lowmemorykiller, not GenieX. `setPrimaryClip` is a Binder
// call, every Binder transaction shares a ~1 MB per-process buffer, and a 3.38
// MB parcel cannot be delivered — the kernel refuses it and the exception takes
// the process with it. No amount of free memory changes that, and a report that
// grows will hit it again.
//
// So two rules, and this module is both of them:
//
//   1. the report that goes to the clipboard is a SUMMARY, not a dump
//   2. whatever it is, it is measured against a conservative ceiling before it
//      is handed to Binder, and trimmed with a visible marker if it exceeds one
//
// The ceiling is deliberately far below the Binder limit. It is not a budget to
// spend — it is the line past which a diagnostic has stopped being a diagnostic
// and become a dump, and something should be fixed rather than raised.

/**
 * 64 KiB.
 *
 * Roughly one sixteenth of the Binder buffer, which leaves room for the other
 * transactions the process is making at the same time — the buffer is shared,
 * so being under it alone is not enough. A compact report of this system runs
 * about 6-12 KB, so this is five to ten times what the thing it guards
 * actually needs, and still two orders of magnitude clear of the crash.
 */
export const CLIPBOARD_MAX_BYTES = 64 * 1024;

/**
 * UTF-8 byte length, counted rather than encoded.
 *
 * `TextEncoder` is not guaranteed on Hermes, and `.length` is UTF-16 code
 * units — which under-counts every non-ASCII character in a report that
 * routinely carries "…" and "→". Binder measures bytes, so this measures bytes.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte character; skip its low half.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** One titled block of the report. */
export interface ReportSection {
  /** Short name, used in the "omitted" notice when it has to go. */
  name: string;
  body: string;
  /**
   * Kept even when the report must be trimmed.
   *
   * The sections that answer the question currently being asked — the pull
   * trace, the errors, the cache summary, the chipset identity. Everything
   * else is context and context is what gets dropped first.
   */
  essential?: boolean;
}

export interface AssembledReport {
  /** Safe to hand to the clipboard. Always within the limit. */
  text: string;
  bytes: number;
  /** Whether anything at all was left out. */
  truncated: boolean;
  /** Names of whole sections that were dropped, in the order they were. */
  omitted: string[];
}

const SEPARATOR = "\n\n";

/**
 * Builds the largest report that still fits, and says what it left out.
 *
 * Non-essential sections are dropped from the end backwards — the report is
 * ordered with the most-wanted first, so the end is the cheapest thing to lose.
 * Essential sections are never dropped; if they alone do not fit, the text is
 * cut on a line boundary and marked, because half of the pull trace beats a
 * crash and beats nothing.
 *
 * Nothing is ever split across two clipboard writes. A second silent write
 * would replace the first, so the user would be handed the tail of a report and
 * no way to know the head existed.
 */
export function assembleReport(
  sections: ReportSection[],
  limitBytes: number = CLIPBOARD_MAX_BYTES,
): AssembledReport {
  const present = sections.filter((s) => s.body.trim().length > 0);
  const omitted: string[] = [];

  const kept = [...present];
  // Drop from the back, non-essential only, until it fits.
  for (let i = kept.length - 1; i >= 0; i--) {
    if (fits(render(kept, omitted), limitBytes)) break;
    if (kept[i].essential) continue;
    omitted.unshift(kept[i].name);
    kept.splice(i, 1);
  }

  let text = render(kept, omitted);
  let truncated = omitted.length > 0;

  if (!fits(text, limitBytes)) {
    // Essentials alone are over. Cut rather than refuse: the top of this
    // report is the part that answers the question.
    text = cutToBytes(text, limitBytes - utf8ByteLength(HARD_CUT_NOTICE)) + HARD_CUT_NOTICE;
    truncated = true;
  }

  return { text, bytes: utf8ByteLength(text), truncated, omitted };
}

const HARD_CUT_NOTICE =
  "\n\n--- REPORT CUT HERE: it exceeded the clipboard-safe size even after " +
  "dropping optional sections. Everything below this point is missing. The " +
  "full report is in logcat under the VestaNpu tag. ---";

function render(sections: ReportSection[], omitted: string[]): string {
  const parts = sections.map((s) => s.body);
  if (omitted.length > 0) {
    parts.push(
      `--- OMITTED, to stay within the clipboard-safe size: ${omitted.join(", ")}. ` +
        "These sections were left out of this copy, not missing from the device. " +
        "The full report is in logcat under the VestaNpu tag. ---",
    );
  }
  return parts.join(SEPARATOR);
}

function fits(text: string, limitBytes: number): boolean {
  return utf8ByteLength(text) <= limitBytes;
}

/** Cuts on a line boundary so the tail is never half a field. */
function cutToBytes(text: string, limitBytes: number): string {
  if (limitBytes <= 0) return "";
  let out = text;
  while (utf8ByteLength(out) > limitBytes) {
    const lastLine = out.lastIndexOf("\n");
    // No newline left to cut on: fall back to halving, which terminates.
    out = lastLine > 0 ? out.slice(0, lastLine) : out.slice(0, Math.floor(out.length / 2));
    if (out.length === 0) break;
  }
  return out;
}

/**
 * The last thing between any string and `Clipboard.setString`.
 *
 * `assembleReport` should already have kept the text small, but this is what
 * makes the Copy button structurally incapable of crashing the app: it is not
 * possible to reach the clipboard through here with an oversized payload,
 * whatever some future caller assembles.
 */
export function clipboardSafe(
  text: string,
  limitBytes: number = CLIPBOARD_MAX_BYTES,
): { text: string; bytes: number; truncated: boolean } {
  if (fits(text, limitBytes)) {
    return { text, bytes: utf8ByteLength(text), truncated: false };
  }
  const cut =
    cutToBytes(text, limitBytes - utf8ByteLength(HARD_CUT_NOTICE)) + HARD_CUT_NOTICE;
  return { text: cut, bytes: utf8ByteLength(cut), truncated: true };
}
