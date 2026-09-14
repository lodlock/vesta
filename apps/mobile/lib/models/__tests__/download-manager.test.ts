// Regression tests for the resumable downloader (Fase 5 bug class E:
// resume/corruption). The commit path guards against truncated files, honors
// pause/resume tokens, must never commit a partial that a cancel raced, and
// must never promote a file whose SHA-256 doesn't match HuggingFace's LFS oid.
// expo-file-system and the native hasher are mocked; ./format runs for real
// (pure, already tested).

import * as FileSystem from "expo-file-system/legacy";
import {
  downloadModel,
  cancelDownload,
  modelPathFor,
  tempPathFor,
  quarantinePathFor,
} from "../download-manager";
import { sha256File } from "../../native/file-hash";

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500 * 1e9),
  createDownloadResumable: jest.fn(),
  moveAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
}));

// normalizeSha256 is pure — let it run for real so the tests exercise the same
// normalization the production path uses.
jest.mock("../../native/file-hash", () => ({
  ...jest.requireActual("../../native/file-hash"),
  sha256File: jest.fn(async () => null),
}));

const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;
const mockSha = sha256File as jest.MockedFunction<typeof sha256File>;

// A valid-shaped sha256 and a different one to fail against.
const GOOD_SHA = "a".repeat(64);
const BAD_SHA = "b".repeat(64);

const FILE = "model.gguf";
const FINAL = modelPathFor(FILE);
const TEMP = tempPathFor(FINAL);
const MODELS_DIR = "file:///docs/models/";

const flush = () => new Promise((r) => setImmediate(r));

// A fake DownloadResumable; each test overrides the bits it exercises.
function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    downloadAsync: jest.fn(async () => ({ uri: TEMP })),
    resumeAsync: jest.fn(async () => ({ uri: TEMP })),
    pauseAsync: jest.fn(async () => ({ resumeData: "tok" })),
    cancelAsync: jest.fn(async () => {}),
    savable: jest.fn(() => ({ resumeData: "tok" })),
    ...overrides,
  };
}

// Default filesystem: models dir exists, temp file present at `tempSize`, no
// pre-existing final file. Tests tweak tempSize.
function setupFS(tempSize: number) {
  mockFS.getInfoAsync.mockImplementation(async (path: string) => {
    if (path === MODELS_DIR) return { exists: true } as never;
    if (path === TEMP) return { exists: true, size: tempSize } as never;
    return { exists: false } as never; // FINAL, etc.
  });
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "m1",
    url: "https://hf/model.gguf",
    fileName: FILE,
    expectedBytes: 1_000_000,
    ...overrides,
  } as Parameters<typeof downloadModel>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFS.getFreeDiskStorageAsync.mockResolvedValue(500 * 1e9);
  mockSha.mockResolvedValue(null);
});

describe("downloadModel — corruption / size verification", () => {
  it("rejects a truncated file against an authoritative size and deletes the partial", async () => {
    setupFS(500_000); // half of expectedBytes
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);

    const outcome = await downloadModel(params({ verifySize: true }));

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/incomplete/i);
    expect(mockFS.deleteAsync).toHaveBeenCalledWith(TEMP, { idempotent: true });
    expect(mockFS.moveAsync).not.toHaveBeenCalled();
  });

  it("commits a complete file by renaming temp → final", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);

    const outcome = await downloadModel(params({ verifySize: true }));

    expect(outcome.ok).toBe(true);
    expect(outcome.filePath).toBe(FINAL);
    expect(outcome.sizeBytes).toBe(1_000_000);
    expect(mockFS.moveAsync).toHaveBeenCalledWith({ from: TEMP, to: FINAL });
  });

  it("does NOT reject an under-size file when the size is not authoritative (verifySize=false)", async () => {
    setupFS(10); // catalog approx size can be off; must not fail a complete file
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);

    const outcome = await downloadModel(params({ verifySize: false }));

    expect(outcome.ok).toBe(true);
    expect(mockFS.moveAsync).toHaveBeenCalledWith({ from: TEMP, to: FINAL });
  });
});

describe("downloadModel — resume / pause", () => {
  it("resumes via resumeAsync (not downloadAsync) when given a resume token", async () => {
    setupFS(1_000_000);
    const task = makeTask();
    mockFS.createDownloadResumable.mockReturnValue(task as never);

    const outcome = await downloadModel(params({ resumeToken: "tok" }));

    expect(task.resumeAsync).toHaveBeenCalledTimes(1);
    expect(task.downloadAsync).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  it("on pause keeps the partial and returns the resume token", async () => {
    setupFS(400_000);
    const task = makeTask({ downloadAsync: jest.fn(async () => undefined) });
    mockFS.createDownloadResumable.mockReturnValue(task as never);
    const onResumeToken = jest.fn();

    const outcome = await downloadModel(params({ onResumeToken }));

    expect(outcome).toMatchObject({ ok: false, paused: true, resumeToken: "tok" });
    expect(onResumeToken).toHaveBeenCalledWith("tok");
    // The partial must survive a pause (no delete).
    expect(mockFS.deleteAsync).not.toHaveBeenCalled();
  });
});

describe("downloadModel — cancel races", () => {
  it("a cancel while downloading drops the partial and never commits", async () => {
    setupFS(1_000_000);
    let resolveDownload!: (v: undefined) => void;
    const task = makeTask({
      downloadAsync: jest.fn(() => new Promise((res) => { resolveDownload = res as never; })),
    });
    mockFS.createDownloadResumable.mockReturnValue(task as never);

    // expectedBytes:0 skips the free-space preflight so the task registers fast.
    const promise = downloadModel(params({ expectedBytes: 0 }));
    await flush(); // let downloadModel reach `await task.downloadAsync()`

    await cancelDownload("m1"); // marks the entry canceled
    resolveDownload(undefined); // the resumable resolves undefined on cancel

    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, canceled: true });
    expect(task.cancelAsync).toHaveBeenCalled();
    expect(mockFS.deleteAsync).toHaveBeenCalledWith(TEMP, { idempotent: true });
    expect(mockFS.moveAsync).not.toHaveBeenCalled();
  });
});

describe("downloadModel — free-space preflight", () => {
  it("refuses to start when there isn't enough free space", async () => {
    setupFS(0);
    mockFS.getFreeDiskStorageAsync.mockResolvedValue(100); // ~nothing free

    const outcome = await downloadModel(params({ expectedBytes: 5_000_000_000 }));

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/free space/i);
    expect(mockFS.createDownloadResumable).not.toHaveBeenCalled();
  });
});

describe("downloadModel — SHA-256 integrity verification", () => {
  it("commits and reports verified when the digest matches the expected oid", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockResolvedValue(GOOD_SHA);

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(mockSha).toHaveBeenCalledWith(TEMP); // hashed BEFORE the rename
    expect(outcome).toMatchObject({ ok: true, verified: true, sha256: GOOD_SHA });
    expect(mockFS.moveAsync).toHaveBeenCalledWith({ from: TEMP, to: FINAL });
  });

  it("refuses to promote a file whose digest does not match, and quarantines it", async () => {
    setupFS(1_000_000); // correct SIZE — only the content is wrong
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockResolvedValue(BAD_SHA);

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/integrity check/i);
    // Never renamed to the usable model path...
    expect(mockFS.moveAsync).not.toHaveBeenCalledWith({ from: TEMP, to: FINAL });
    // ...and moved off the temp path so a later resume can't append to it.
    expect(mockFS.moveAsync).toHaveBeenCalledWith({
      from: TEMP,
      to: quarantinePathFor(FINAL),
    });
  });

  it("deletes the partial when quarantining itself fails", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockResolvedValue(BAD_SHA);
    mockFS.moveAsync.mockRejectedValueOnce(new Error("read-only fs"));

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(outcome.ok).toBe(false);
    expect(mockFS.deleteAsync).toHaveBeenCalledWith(TEMP, { idempotent: true });
  });

  it("accepts an oid in sha256:HEX form and mixed case", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockResolvedValue(GOOD_SHA);

    const outcome = await downloadModel(
      params({ expectedSha256: `SHA256:${GOOD_SHA.toUpperCase()}` }),
    );

    expect(outcome).toMatchObject({ ok: true, verified: true });
  });

  it("fails the download when hashing throws", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockRejectedValue(new Error("No such file"));

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/could not verify/i);
    expect(mockFS.moveAsync).not.toHaveBeenCalledWith({ from: TEMP, to: FINAL });
  });

  it("commits but reports hashing-unavailable when the native hasher is absent", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    mockSha.mockResolvedValue(null); // no native module (iOS / Expo Go)

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(outcome).toMatchObject({
      ok: true,
      verified: false,
      unverifiedReason: "hashing-unavailable",
    });
    expect(mockFS.moveAsync).toHaveBeenCalledWith({ from: TEMP, to: FINAL });
  });

  it("reports no-expected-hash (and does not hash) when the repo published no oid", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);

    const outcome = await downloadModel(params({ expectedSha256: null }));

    expect(mockSha).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: true,
      verified: false,
      unverifiedReason: "no-expected-hash",
    });
  });

  it("ignores a malformed oid rather than comparing garbage", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);

    const outcome = await downloadModel(params({ expectedSha256: "not-a-hash" }));

    expect(mockSha).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, unverifiedReason: "no-expected-hash" });
  });

  it("a cancel landing during hashing still wins over the commit", async () => {
    setupFS(1_000_000);
    mockFS.createDownloadResumable.mockReturnValue(makeTask() as never);
    // Hashing is the long await; cancel arrives while it runs.
    mockSha.mockImplementation(async () => {
      await cancelDownload("m1");
      return GOOD_SHA;
    });

    const outcome = await downloadModel(params({ expectedSha256: GOOD_SHA }));

    expect(outcome).toMatchObject({ ok: false, canceled: true });
    expect(mockFS.moveAsync).not.toHaveBeenCalledWith({ from: TEMP, to: FINAL });
    expect(mockFS.deleteAsync).toHaveBeenCalledWith(TEMP, { idempotent: true });
  });
});
