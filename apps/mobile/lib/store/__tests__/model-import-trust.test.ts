// The trust policy for locally imported GGUFs — the file the user picked
// themselves, which has no upstream digest to lean on.
//
// Three outcomes must stay distinct:
//   a user-supplied checksum that matches   → verified_user_checksum
//   no checksum at all                      → user_supplied_baseline (hashed
//                                             at import, so later change is
//                                             detectable), import still allowed
//   a user-supplied checksum that does NOT  → nothing imported, file removed
//
// Everything native is mocked; the policy itself runs for real.

import { useModelStore } from "../model-store";
import * as FileSystem from "expo-file-system/legacy";
import { insertModel } from "../../models/model-registry";
import { validateGguf } from "../../llm/llm-engine";
import { checkGgufFile } from "../../models/gguf-header";
import { sha256File } from "../../native/file-hash";
import { deleteModelFile } from "../../models/download-manager";
import { readAdjacentChecksum } from "../../models/integrity";

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  copyAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500e9),
  deleteAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  createDownloadResumable: jest.fn(),
}));
jest.mock("../../models/model-registry", () => ({
  listInstalled: jest.fn(async () => []),
  getModelById: jest.fn(async () => null),
  getActiveModel: jest.fn(async () => ({ id: "other" })), // suppress auto-activate
  insertModel: jest.fn(async (m) => ({ ...m, id: "m1", isActive: false })),
  setModelState: jest.fn(async () => {}),
  setResumeToken: jest.fn(async () => {}),
  finalizeModel: jest.fn(async () => {}),
  setModelIntegrity: jest.fn(async () => {}),
  setActiveModel: jest.fn(async () => {}),
  removeModel: jest.fn(async () => {}),
}));
jest.mock("../../models/download-manager", () => ({
  downloadModel: jest.fn(),
  cancelDownload: jest.fn(async () => {}),
  deleteModelFile: jest.fn(async () => {}),
  ensureModelsDir: jest.fn(async () => {}),
  modelPathFor: (f: string) => `file:///docs/models/${f}`,
}));
jest.mock("../../models/gguf-header", () => ({
  checkGgufFile: jest.fn(async () => ({ ok: true, version: 3 })),
}));
jest.mock("../../models/integrity", () => ({
  ...jest.requireActual("../../models/integrity"),
  readAdjacentChecksum: jest.fn(async () => null),
}));
jest.mock("../../native/file-hash", () => ({
  ...jest.requireActual("../../native/file-hash"),
  sha256File: jest.fn(async () => null),
}));
jest.mock("../../llm/llm-engine", () => ({
  loadModel: jest.fn(async () => {}),
  unloadModel: jest.fn(async () => {}),
  validateGguf: jest.fn(async () => ({ ok: true })),
  getModelInfo: jest.fn(() => ({ loaded: false })),
}));
jest.mock("../../models/device-caps", () => ({
  getDeviceCaps: jest.fn(async () => ({ freeBytes: 500e9, totalRamMb: 8192 })),
}));
jest.mock("../../orchestrator/session-warmer", () => ({ warmSessionCache: jest.fn() }));
jest.mock("../../llm/perf-config", () => ({
  getPerfSettings: jest.fn(async () => ({})),
  perfToLlmOptions: jest.fn(() => ({})),
}));
jest.mock("../chat-store", () => ({
  useChatStore: { getState: () => ({ updateModelStatus: jest.fn() }) },
}));

const mockInsert = insertModel as jest.MockedFunction<typeof insertModel>;
const mockSha = sha256File as jest.MockedFunction<typeof sha256File>;
const mockHeader = checkGgufFile as jest.MockedFunction<typeof checkGgufFile>;
const mockDelete = deleteModelFile as jest.MockedFunction<typeof deleteModelFile>;
const mockAdjacent = readAdjacentChecksum as jest.MockedFunction<typeof readAdjacentChecksum>;
const mockValidate = validateGguf as jest.MockedFunction<typeof validateGguf>;
const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;

const SHA = "b".repeat(64);
const OTHER_SHA = "c".repeat(64);
const URI = "content://downloads/my-merge.gguf";

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({ error: null, busy: false, installed: [] });
  mockSha.mockResolvedValue(SHA);
  mockHeader.mockResolvedValue({ ok: true, version: 3 });
  mockValidate.mockResolvedValue({ ok: true });
  mockAdjacent.mockResolvedValue(null);
  mockFS.getInfoAsync.mockResolvedValue({ exists: false } as never);
});

const importIt = (checksum?: string | null) =>
  useModelStore.getState().importLocalModel(URI, "my-merge.gguf", checksum);

describe("importLocalModel — user-supplied GGUF", () => {
  it("accepts a file with no checksum and records a baseline hash", async () => {
    await importIt();

    expect(useModelStore.getState().error).toBeNull();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "user_supplied_baseline", sha256: SHA }),
    );
  });

  it("accepts a matching user checksum and marks it verified against it", async () => {
    await importIt(SHA);

    expect(useModelStore.getState().error).toBeNull();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "verified_user_checksum", sha256: SHA }),
    );
  });

  it("accepts a checksum pasted in sha256sum format", async () => {
    await importIt(`${SHA}  my-merge.gguf`);

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "verified_user_checksum" }),
    );
  });

  it("picks up an adjacent .sha256 when the user pasted nothing", async () => {
    mockAdjacent.mockResolvedValue(SHA);

    await importIt();

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "verified_user_checksum" }),
    );
  });

  it("rejects and deletes the file when the checksum does not match", async () => {
    await importIt(OTHER_SHA);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/does not match/i);
  });

  it("rejects when a checksum was given but hashing is unavailable", async () => {
    mockSha.mockResolvedValue(null);

    await importIt(SHA);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/hashing is unavailable/i);
  });

  it("rejects when a checksum was given and hashing throws", async () => {
    mockSha.mockRejectedValue(new Error("EIO"));

    await importIt(SHA);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/could not verify/i);
  });

  it("still imports with no checksum when hashing is unavailable, as unverified", async () => {
    mockSha.mockResolvedValue(null);

    await importIt();

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "unverified", sha256: null }),
    );
  });

  it("requires no HuggingFace repo or catalog filename", async () => {
    await importIt();

    const row = mockInsert.mock.calls[0][0];
    expect(row.hfRepo ?? null).toBeNull();
    expect(row.displayName).toBe("my-merge");
  });

  it("copies into app-private storage and imports from THAT copy", async () => {
    await importIt();

    // The SAF URI is a copy source and nothing else: the header check, the
    // hash and the registry row all point at the app-private copy.
    expect(mockFS.copyAsync).toHaveBeenCalledWith({
      from: URI,
      to: "file:///docs/models/my-merge.gguf",
    });
    expect(mockHeader).toHaveBeenCalledWith("file:///docs/models/my-merge.gguf");
    expect(mockSha).toHaveBeenCalledWith("file:///docs/models/my-merge.gguf");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "file:///docs/models/my-merge.gguf" }),
    );
  });

  it("never imports onto an existing file — it takes a free name", async () => {
    // A model called my-merge.gguf is already installed. Adopting its bytes
    // would import the wrong file, and a checksum mismatch would then delete a
    // model the user still has.
    mockFS.getInfoAsync.mockImplementation(async (path: string) =>
      path === "file:///docs/models/my-merge.gguf"
        ? ({ exists: true, size: 123 } as never)
        : ({ exists: false } as never),
    );

    await importIt();

    expect(mockFS.copyAsync).toHaveBeenCalledWith({
      from: URI,
      to: "file:///docs/models/my-merge-2.gguf",
    });
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "file:///docs/models/my-merge-2.gguf" }),
    );
  });

  it("rejects a file that fails the GGUF header check before llama sees it", async () => {
    mockHeader.mockResolvedValue({ ok: false, error: "Not a GGUF file (bad magic bytes)." });

    await importIt();

    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/bad magic/i);
  });
});
