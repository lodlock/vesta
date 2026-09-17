// One set of sections, two artefacts, and the property that separates them:
// the summary is bounded and the full report is not.
//
// The bound exists because `Clipboard.setString` is a Binder call and a 3.38 MB
// parcel is fatal (see clipboard-safe.test.ts). The absence of a bound on the
// full report exists because capping it is what made it useless — the answer
// could be below the cut line. Both halves are load-bearing.

import { CLIPBOARD_MAX_BYTES, utf8ByteLength } from "../clipboard-safe";
import {
  buildReports,
  diagnosticsFileName,
  isDiagnosticsFileName,
  REPORT_FILE_PREFIX,
  type DiagnosticsSection,
} from "../report";

/** A section with real bulk in its full form, like the cache inventory. */
const HUGE = "cache entry line, about sixty characters of it, give or take\n".repeat(20_000);

const realistic = (): DiagnosticsSection[] => [
  {
    name: "device",
    summary: "Vesta diagnostics — device\nsoc: SM8850\nactive model: Qwen3 4B",
    full: "Vesta diagnostics — device\nsoc: SM8850\nactive model: Qwen3 4B\n" + HUGE,
    essential: true,
  },
  { name: "pull trace", summary: "NPU pull trace\nrc=-100000", essential: true },
  { name: "hub state", summary: "Qualcomm Hub state\nmodels returned: 19", essential: true },
  {
    name: "hub cache",
    summary: "Hub cache report\nmodelCount: 19",
    full: "Hub cache report\n" + HUGE,
    essential: true,
  },
  { name: "cache health", summary: "Cache health\nprefix session cache: present", essential: true },
  { name: "native log", summary: "GenieX log (last 40 lines)", full: "GenieX log\n" + HUGE },
];

describe("the summary", () => {
  const built = buildReports(realistic());

  it("never exceeds the clipboard cap, however large the sections are", () => {
    expect(built.summaryBytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(utf8ByteLength(built.summary)).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
  });

  // The regression this whole change exists for: the old report put the cache
  // inventory on the clipboard, and a report that grows with the cache has to
  // be trimmed sooner or later. The summary takes the compact form of every
  // section, so its size is a function of the FIELDS, not of the device.
  it("does not truncate at a realistic size", () => {
    expect(built.summaryTruncated).toBe(false);
    expect(built.omitted).toEqual([]);
    expect(built.summary).not.toContain("REPORT CUT HERE");
    expect(built.summary).not.toContain("OMITTED");
  });

  it("lands in the few-KB range a chat message can hold", () => {
    expect(built.summaryBytes).toBeGreaterThan(0);
    expect(built.summaryBytes).toBeLessThan(20 * 1024);
  });

  it("carries the identity, state and outcome fields", () => {
    expect(built.summary).toContain("soc: SM8850");
    expect(built.summary).toContain("active model: Qwen3 4B");
    expect(built.summary).toContain("rc=-100000");
    expect(built.summary).toContain("models returned: 19");
    expect(built.summary).toContain("prefix session cache: present");
  });

  it("leaves the per-file inventory out", () => {
    expect(built.summary).not.toContain("cache entry line");
  });
});

describe("the full report", () => {
  const built = buildReports(realistic());

  it("is not truncated, cut or abbreviated at any size", () => {
    expect(built.full).not.toContain("REPORT CUT HERE");
    expect(built.full).not.toContain("OMITTED");
    expect(built.fullBytes).toBeGreaterThan(CLIPBOARD_MAX_BYTES);
  });

  it("contains every section's complete form", () => {
    for (const section of realistic()) {
      const body = section.full ?? section.summary;
      if (body.trim().length > 0) expect(built.full).toContain(body);
    }
  });

  // Not a size limit in disguise: the count is whatever the sections weigh.
  it("keeps the whole inventory, all of it", () => {
    const occurrences = built.full.split("cache entry line").length - 1;
    expect(occurrences).toBe(60_000);
  });

  it("says what it is, so a reader knows nothing was dropped", () => {
    expect(built.full).toContain("FULL REPORT");
  });
});

describe("a section with no separate full form", () => {
  it("appears identically in both", () => {
    const built = buildReports([
      { name: "only", summary: "one form only", essential: true },
    ]);
    expect(built.summary).toContain("one form only");
    expect(built.full).toContain("one form only");
  });
});

describe("empty sections", () => {
  it("are left out of both rather than printed as blanks", () => {
    const built = buildReports([
      { name: "present", summary: "something", essential: true },
      { name: "absent", summary: "" },
    ]);
    expect(built.summary.trim()).toBe("something");
    expect(built.full.split("\n\n")).toHaveLength(2); // header + one section
  });
});

describe("the file name", () => {
  // 2026-09-16 18:19 local. Constructed from local parts so the test does not
  // depend on the machine's timezone — the name is deliberately local time.
  const at = new Date(2026, 8, 16, 18, 19, 45);

  it("is the documented shape", () => {
    expect(diagnosticsFileName(at)).toBe("vesta-diagnostics-2026-09-16-1819.txt");
  });

  it("is stable within a minute, so a retry overwrites rather than piles up", () => {
    expect(diagnosticsFileName(new Date(2026, 8, 16, 18, 19, 3))).toBe(
      diagnosticsFileName(new Date(2026, 8, 16, 18, 19, 59)),
    );
  });

  it("changes on the next minute", () => {
    expect(diagnosticsFileName(new Date(2026, 8, 16, 18, 20, 0))).not.toBe(
      diagnosticsFileName(at),
    );
  });

  it("pads every field, so names sort chronologically as text", () => {
    const early = diagnosticsFileName(new Date(2026, 0, 2, 3, 4));
    expect(early).toBe("vesta-diagnostics-2026-01-02-0304.txt");
    expect([diagnosticsFileName(at), early].sort()).toEqual([early, diagnosticsFileName(at)]);
  });

  // Nothing in the name is attacker-controlled — it is built from a clock —
  // but a share target and a filesystem both read it, so it is worth pinning
  // that it contains no separator and nothing to escape.
  it("is safe: digits, hyphens and the fixed prefix only", () => {
    const name = diagnosticsFileName(at);
    expect(name.startsWith(REPORT_FILE_PREFIX)).toBe(true);
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
  });

  it("recognises its own names and nothing else", () => {
    expect(isDiagnosticsFileName(diagnosticsFileName(at))).toBe(true);
    expect(isDiagnosticsFileName("vesta-diagnostics-.txt")).toBe(false);
    expect(isDiagnosticsFileName("vesta-diagnostics-2026-09-16-1819.txt.bak")).toBe(false);
    expect(isDiagnosticsFileName("model.gguf")).toBe(false);
    expect(isDiagnosticsFileName("../secrets.txt")).toBe(false);
  });
});
