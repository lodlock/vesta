// The rule this file exists to enforce: the full report never goes near the
// clipboard.
//
// `Clipboard.setString` is `ClipboardManager.setPrimaryClip`, a Binder call
// against a ~1 MB buffer shared by the whole process. The report has been 3.38
// MB, and the kernel's refusal is fatal. The summary stays under a conservative
// cap; the full report travels as a file through a content:// URI, where its
// size is not a transport concern at all.
//
// Clipboard is mocked at the module boundary rather than trusted to be absent,
// because `deliver.ts` imports it — the point is that the SHARE path never
// reaches it even though it is in scope.

import { CLIPBOARD_MAX_BYTES, utf8ByteLength } from "../clipboard-safe";
import {
  copySummary,
  shareFullReport,
  DIAGNOSTICS_DIR,
  MAX_KEPT_REPORTS,
  type ShareDeps,
} from "../deliver";
import type { ShareFileResult } from "../../native/system-actions";

const mockSetString = jest.fn();
jest.mock("react-native", () => ({
  Clipboard: { setString: (t: string) => mockSetString(t) },
  Platform: { OS: "android" },
  NativeModules: {},
}));

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///data/user/0/com.cosmico.vesta/cache/",
  makeDirectoryAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

const CACHE = "file:///data/user/0/com.cosmico.vesta/cache/";
const DIR = `${CACHE}${DIAGNOSTICS_DIR}`;
const AT = new Date(2026, 8, 16, 18, 19);
const NAME = "vesta-diagnostics-2026-09-16-1819.txt";

/** A recording stand-in for the whole filesystem + native share boundary. */
function deps(overrides: Partial<ShareDeps> = {}) {
  const written: { path: string; contents: string }[] = [];
  const deleted: string[] = [];
  const shared: { path: string; mimeType: string; title: string }[] = [];
  let listing: string[] = [];

  const base: ShareDeps = {
    cacheDirectory: CACHE,
    makeDirectoryAsync: (async () => undefined) as ShareDeps["makeDirectoryAsync"],
    writeAsStringAsync: (async (path: string, contents: string) => {
      written.push({ path, contents });
      listing.push(path.slice(path.lastIndexOf("/") + 1));
    }) as ShareDeps["writeAsStringAsync"],
    readDirectoryAsync: (async () => [...listing]) as ShareDeps["readDirectoryAsync"],
    deleteAsync: (async (path: string) => {
      deleted.push(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      listing = listing.filter((n) => n !== name);
    }) as ShareDeps["deleteAsync"],
    share: (async (path: string, mimeType: string, title: string) => {
      shared.push({ path, mimeType, title });
      return {
        status: "shared",
        uri: `content://com.cosmico.vesta.fileprovider/diagnostics/${title}`,
        mimeType,
        fileName: title,
        readPermissionGranted: true,
      } satisfies ShareFileResult;
    }) as ShareDeps["share"],
  };

  return {
    deps: { ...base, ...overrides },
    written,
    deleted,
    shared,
    seed: (names: string[]) => {
      listing = [...names];
    },
  };
}

beforeEach(() => {
  mockSetString.mockClear();
  mockSetString.mockImplementation(() => undefined);
});

describe("Copy summary", () => {
  it("puts the summary on the clipboard", () => {
    const outcome = copySummary("a compact report");
    expect(outcome.copied).toBe(true);
    expect(mockSetString).toHaveBeenCalledWith("a compact report");
  });

  it("never hands Binder more than the cap, whatever it is given", () => {
    const outcome = copySummary("x".repeat(CLIPBOARD_MAX_BYTES * 3));
    const sent = mockSetString.mock.calls[0][0] as string;
    expect(utf8ByteLength(sent)).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(outcome.bytes).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(outcome.truncated).toBe(true);
  });

  it("reports a clipboard failure rather than claiming a copy", () => {
    mockSetString.mockImplementationOnce(() => {
      throw new Error("TransactionTooLargeException");
    });
    const outcome = copySummary("anything");
    expect(outcome.copied).toBe(false);
    expect(outcome.error).toContain("TransactionTooLarge");
  });
});

describe("Share full report", () => {
  const FULL = "FULL REPORT\n" + "inventory line\n".repeat(200_000);

  it("never touches the clipboard", async () => {
    const t = deps();
    await shareFullReport(FULL, AT, t.deps);
    expect(mockSetString).not.toHaveBeenCalled();
  });

  it("writes the report whole, with nothing cut", async () => {
    const t = deps();
    const outcome = await shareFullReport(FULL, AT, t.deps);
    expect(outcome.shared).toBe(true);
    expect(t.written).toHaveLength(1);
    expect(t.written[0].contents).toBe(FULL);
    expect(t.written[0].contents).not.toContain("REPORT CUT HERE");
    expect(outcome.bytes).toBe(utf8ByteLength(FULL));
    expect(outcome.bytes).toBeGreaterThan(CLIPBOARD_MAX_BYTES);
  });

  it("writes into the cache subdirectory the FileProvider serves", async () => {
    const t = deps();
    await shareFullReport(FULL, AT, t.deps);
    expect(t.written[0].path).toBe(`${DIR}/${NAME}`);
  });

  it("shares that file as text/plain, under a name the recipient can read", async () => {
    const t = deps();
    const outcome = await shareFullReport(FULL, AT, t.deps);
    expect(t.shared).toEqual([
      { path: `${DIR}/${NAME}`, mimeType: "text/plain", title: NAME },
    ]);
    expect(outcome.fileName).toBe(NAME);
  });

  // The outcome is what the screen prints, so it must never contain
  // /data/user/0/… — a private path is noise to a user and an invitation to
  // paste it into a bug report.
  it("reports the file name, never the filesystem path", async () => {
    const t = deps();
    const outcome = await shareFullReport(FULL, AT, t.deps);
    expect(JSON.stringify(outcome)).not.toContain("/data/");
    expect(JSON.stringify(outcome)).not.toContain("file://");
  });
});

describe("the temp directory", () => {
  const older = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `vesta-diagnostics-2026-09-1${i % 9}-08${String(i).padStart(2, "0")}.txt`,
    );

  it("keeps a bounded number of reports", async () => {
    const t = deps();
    t.seed(older(12));
    const outcome = await shareFullReport("full", AT, t.deps);
    // MAX_KEPT_REPORTS survive in total, the new one included.
    expect(t.deleted).toHaveLength(13 - MAX_KEPT_REPORTS);
    expect(outcome.cleaned).toBe(13 - MAX_KEPT_REPORTS);
  });

  it("deletes the oldest and keeps the newest", async () => {
    const t = deps();
    t.seed([
      "vesta-diagnostics-2024-01-01-0000.txt",
      "vesta-diagnostics-2026-09-16-1818.txt",
      "vesta-diagnostics-2026-09-15-2359.txt",
      "vesta-diagnostics-2025-06-01-1200.txt",
    ]);
    await shareFullReport("full", AT, t.deps);
    expect(t.deleted).toEqual([
      `${DIR}/vesta-diagnostics-2025-06-01-1200.txt`,
      `${DIR}/vesta-diagnostics-2024-01-01-0000.txt`,
    ]);
  });

  it("deletes nothing it did not write", async () => {
    const t = deps();
    t.seed([
      "qwen3-4b.gguf",
      "session.bin",
      "notes.txt",
      "vesta-diagnostics-2024-01-01-0000.txt",
      "vesta-diagnostics-2024-01-02-0000.txt",
      "vesta-diagnostics-2024-01-03-0000.txt",
      "vesta-diagnostics-2024-01-04-0000.txt",
    ]);
    await shareFullReport("full", AT, t.deps);
    expect(t.deleted.length).toBeGreaterThan(0);
    for (const gone of t.deleted) {
      expect(gone).toContain("vesta-diagnostics-");
    }
    expect(t.deleted.join()).not.toContain("gguf");
    expect(t.deleted.join()).not.toContain("session.bin");
    expect(t.deleted.join()).not.toContain("notes.txt");
  });

  it("shares the report even when cleanup fails", async () => {
    const t = deps({
      readDirectoryAsync: (async () => {
        throw new Error("cache cleared under us");
      }) as ShareDeps["readDirectoryAsync"],
    });
    const outcome = await shareFullReport("full", AT, t.deps);
    expect(outcome.shared).toBe(true);
    expect(outcome.cleaned).toBe(0);
  });
});

describe("when it cannot be done", () => {
  it("surfaces a write failure without throwing", async () => {
    const t = deps({
      writeAsStringAsync: (async () => {
        throw new Error("ENOSPC: no space left on device");
      }) as ShareDeps["writeAsStringAsync"],
    });
    const outcome = await shareFullReport("full", AT, t.deps);
    expect(outcome.shared).toBe(false);
    expect(outcome.error).toContain("ENOSPC");
    expect(outcome.fileName).toBe(NAME);
    expect(mockSetString).not.toHaveBeenCalled();
  });

  it("surfaces a share failure without throwing", async () => {
    const t = deps({
      share: (async () => {
        throw new Error("SHARE_FILE_ERROR: provider not registered");
      }) as ShareDeps["share"],
    });
    const outcome = await shareFullReport("full", AT, t.deps);
    expect(outcome.shared).toBe(false);
    expect(outcome.error).toContain("provider not registered");
  });

  it("says so when no app can receive a text file", async () => {
    const t = deps({
      share: (async (_p: string, mimeType: string, title: string) =>
        ({
          status: "no-handler",
          uri: "",
          mimeType,
          fileName: title,
          readPermissionGranted: true,
        }) satisfies ShareFileResult) as ShareDeps["share"],
    });
    const outcome = await shareFullReport("full", AT, t.deps);
    expect(outcome.shared).toBe(false);
    expect(outcome.error).toContain("No app on this device");
  });

  it("says so when there is no cache directory to write into", async () => {
    const t = deps({ cacheDirectory: null });
    const outcome = await shareFullReport("full", AT, t.deps);
    expect(outcome.shared).toBe(false);
    expect(outcome.error).toContain("cache directory");
  });

  // Not a hypothetical: the clipboard path is the one that crashed. A failure
  // on the file path must not quietly fall back to it.
  it("never falls back to the clipboard on failure", async () => {
    const t = deps({
      share: (async () => {
        throw new Error("anything at all");
      }) as ShareDeps["share"],
    });
    await shareFullReport("x".repeat(4_000_000), AT, t.deps);
    expect(mockSetString).not.toHaveBeenCalled();
  });
});
