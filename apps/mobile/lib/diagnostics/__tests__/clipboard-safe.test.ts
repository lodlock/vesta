// The Copy button must not be able to kill the app.
//
// It could, and did. Three attempts, three crashes, the same size each time:
//
//   android.os.TransactionTooLargeException: data parcel size 3377296 bytes
//     at ClipboardManager.setPrimaryClip() ← a Binder call
//
// The Binder buffer is about 1 MB and shared across the whole process, so a
// 3.38 MB parcel is not slow, it is impossible — the kernel refuses it and the
// exception is fatal. Free memory is irrelevant.
//
// Two defences, both tested here: the report is a summary rather than a dump,
// and whatever it is, it is measured before it is handed over.

import {
  CLIPBOARD_MAX_BYTES,
  utf8ByteLength,
  assembleReport,
  clipboardSafe,
  type ReportSection,
} from "../clipboard-safe";

const section = (name: string, body: string, essential = false): ReportSection => ({
  name,
  body,
  essential,
});

/** A realistic compact report: the shape the diagnostics screen now builds. */
const typical = (): ReportSection[] => [
  section("pull trace", "NPU pull trace\n".repeat(20), true),
  section("identity probe", "Hub identity probe\n".repeat(30), true),
  section("chipset identity", "Chipset identity\n".repeat(10), true),
  section("hub cache", "Hub cache report\n".repeat(120), true),
  section("hub listing", "listHubModels()\n".repeat(20)),
  section("installed", "installed report\n".repeat(20)),
  section("native log", "10-05 12:00:00.000 I GenieXSdk: a line\n".repeat(60)),
];

describe("measuring the payload", () => {
  it("counts bytes, not code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // The report is full of these, and they are three bytes each.
    expect(utf8ByteLength("—")).toBe(3);
    expect(utf8ByteLength("…")).toBe(3);
    // A surrogate pair is one four-byte character, not two three-byte ones.
    expect(utf8ByteLength("😀")).toBe(4);
    expect("😀".length).toBe(2);
  });

  it("is far below the Binder limit", () => {
    // The buffer is shared with every other transaction the process makes, so
    // "under 1 MB" is not the same as safe.
    expect(CLIPBOARD_MAX_BYTES).toBeLessThanOrEqual(128 * 1024);
  });
});

describe("a normal report", () => {
  const report = assembleReport(typical());

  it("stays well under the limit", () => {
    expect(report.bytes).toBeLessThan(CLIPBOARD_MAX_BYTES);
    // And with room to spare, so ordinary growth does not start trimming.
    expect(report.bytes).toBeLessThan(CLIPBOARD_MAX_BYTES / 2);
  });

  it("is nowhere near the size that crashed the app", () => {
    expect(report.bytes).toBeLessThan(3_377_296 / 20);
  });

  it("leaves nothing out and says so by saying nothing", () => {
    expect(report.truncated).toBe(false);
    expect(report.omitted).toEqual([]);
    expect(report.text).not.toContain("OMITTED");
  });

  it("keeps every section", () => {
    for (const s of typical()) {
      expect(report.text).toContain(s.body.split("\n")[0]);
    }
  });

  it("drops sections that had nothing in them", () => {
    const withEmpty = assembleReport([
      section("pull trace", "NPU pull trace", true),
      section("installed", ""),
      section("native log", "   "),
    ]);
    expect(withEmpty.omitted).toEqual([]);
    expect(withEmpty.text).toBe("NPU pull trace");
  });
});

describe("a report that has grown too big", () => {
  const huge = () => [
    section("pull trace", "PULL TRACE: rc=-100000\n" + "x".repeat(2_000), true),
    section("hub cache", "HUB CACHE SUMMARY\n" + "y".repeat(2_000), true),
    section("hub listing", "z".repeat(40_000)),
    section("installed", "w".repeat(40_000)),
    section("native log", "v".repeat(40_000)),
  ];

  const report = assembleReport(huge());

  it("comes back within the limit", () => {
    expect(report.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
  });

  it("keeps the sections that answer the question", () => {
    // The whole point of trimming rather than refusing.
    expect(report.text).toContain("PULL TRACE: rc=-100000");
    expect(report.text).toContain("HUB CACHE SUMMARY");
  });

  it("drops the optional ones from the end backwards", () => {
    expect(report.omitted.length).toBeGreaterThan(0);
    expect(report.omitted).not.toContain("pull trace");
    expect(report.omitted).not.toContain("hub cache");
    // The report is ordered most-wanted first, so the last section goes first.
    expect(report.omitted[report.omitted.length - 1]).toBe("native log");
  });

  it("says what it left out, by name, and where to find it", () => {
    expect(report.truncated).toBe(true);
    expect(report.text).toContain("OMITTED");
    for (const name of report.omitted) expect(report.text).toContain(name);
    expect(report.text).toContain("logcat");
    // Not "missing from the device" — the distinction matters to whoever reads
    // this at 2am.
    expect(report.text).toContain("not missing from the device");
  });

  it("cuts even when the essential sections alone are too big", () => {
    const enormous = assembleReport([
      section("pull trace", "PULL TRACE HEAD\n" + "x".repeat(200_000), true),
      section("hub cache", "y".repeat(200_000), true),
    ]);
    expect(enormous.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(enormous.truncated).toBe(true);
    // The head survives, because that is where the answer is.
    expect(enormous.text).toContain("PULL TRACE HEAD");
    expect(enormous.text).toContain("REPORT CUT HERE");
    expect(enormous.text).toContain("missing");
  });
});

// The guard that sits immediately before Clipboard.setString, so no future
// caller can reach Binder with an oversized payload however the text was built.
describe("the last line of defence", () => {
  it("passes a normal report through untouched", () => {
    const text = "NPU pull trace\nattempt 1 (initial)";
    const safe = clipboardSafe(text);
    expect(safe.text).toBe(text);
    expect(safe.truncated).toBe(false);
  });

  it("never returns more than the limit, whatever it is given", () => {
    // The exact size that crashed the device, and an order of magnitude more.
    for (const size of [3_377_296, 10_000_000]) {
      const safe = clipboardSafe("a".repeat(size));
      expect(safe.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
      expect(safe.truncated).toBe(true);
    }
  });

  it("marks what it cut rather than trimming silently", () => {
    const safe = clipboardSafe("HEAD\n" + "a".repeat(200_000));
    expect(safe.text).toContain("HEAD");
    expect(safe.text).toContain("REPORT CUT HERE");
    expect(safe.text).toContain("logcat");
  });

  it("counts multi-byte characters against the limit", () => {
    // 3 bytes each: a report of em-dashes must not sneak through on length.
    const safe = clipboardSafe("—".repeat(CLIPBOARD_MAX_BYTES));
    expect(safe.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(safe.truncated).toBe(true);
  });

  it("terminates on text with no line breaks at all", () => {
    // The cut walks back to a newline; with none, it must still finish.
    const safe = clipboardSafe("a".repeat(500_000));
    expect(safe.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
  });
});
