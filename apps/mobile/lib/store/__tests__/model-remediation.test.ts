// Re-verifying a model that is already on disk.
//
// The scenario: models downloaded before verification existed, backfilled to
// `unverified` by migration v4, some of them left in an errored state with no
// way back except deleting several GB and downloading them again. Verify is
// that way back — it re-establishes the facts from the bytes already present.
//
// What must hold: a matching digest makes the model usable again AND records
// what it matched; a mismatch never activates; and being unable to reach the
// repo is reported as not knowing, never as a pass.

import { useModelStore } from "../model-store";
import * as FileSystem from "expo-file-system/legacy";
import { getModelById, setModelIntegrity, setModelState } from "../../models/model-registry";
import { fetchExpectedSha256 } from "../../models/hf-client";
import { sha256File } from "../../native/file-hash";

const GOOD = "a".repeat(64);
const OTHER = "b".repeat(64);

// The store now reads one user setting straight from the config table (whether
// to retry an interrupted download). Mocked like every other edge this suite
// stubs — expo-sqlite has no native side here.
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 2_500_000_000 })),
  copyAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500e9),
  deleteAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  createDownloadResumable: jest.fn(),
}));
jest.mock("../../models/model-registry", () => ({
  listInstalled: jest.fn(async () => []),
  getModelById: jest.fn(),
  getActiveModel: jest.fn(async () => null),
  insertModel: jest.fn(async (m) => ({ ...m, id: "m1" })),
  setModelState: jest.fn(async () => {}),
  setResumeToken: jest.fn(async () => {}),
  finalizeModel: jest.fn(async () => {}),
  setModelIntegrity: jest.fn(async () => {}),
  setActiveModel: jest.fn(async () => {}),
  removeModel: jest.fn(async () => {}),
}));
jest.mock("../../models/hf-client", () => ({
  listGgufFiles: jest.fn(),
  resolveUrl: jest.fn(),
  fetchExpectedSha256: jest.fn(),
}));
jest.mock("../../native/file-hash", () => ({
  ...jest.requireActual("../../native/file-hash"),
  sha256File: jest.fn(),
}));
jest.mock("../../models/download-manager", () => ({
  downloadModel: jest.fn(),
  cancelDownload: jest.fn(async () => {}),
  deleteModelFile: jest.fn(async () => {}),
  ensureModelsDir: jest.fn(async () => {}),
  modelPathFor: (f: string) => `file:///docs/models/${f}`,
}));
jest.mock("../../models/gguf-header", () => ({
  checkGgufFile: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../llm/llm-engine", () => ({
  loadModel: jest.fn(async () => {}),
  unloadModel: jest.fn(async () => {}),
  validateGguf: jest.fn(async () => ({ ok: true })),
  getModelInfo: jest.fn(() => ({ loaded: false })),
}));
jest.mock("../../models/device-caps", () => ({
  getDeviceCaps: jest.fn(async () => ({ freeBytes: 500e9, totalRamMb: 16384 })),
}));
jest.mock("../../orchestrator/session-warmer", () => ({ warmSessionCache: jest.fn() }));
jest.mock("../../llm/perf-config", () => ({
  getPerfSettings: jest.fn(async () => ({})),
  perfToLlmOptions: jest.fn(() => ({})),
}));
jest.mock("../chat-store", () => ({
  useChatStore: { getState: () => ({ updateModelStatus: jest.fn() }) },
}));

const mockGet = getModelById as jest.MockedFunction<typeof getModelById>;
const mockIntegrity = setModelIntegrity as jest.MockedFunction<typeof setModelIntegrity>;
const mockState = setModelState as jest.MockedFunction<typeof setModelState>;
const mockUpstream = fetchExpectedSha256 as jest.MockedFunction<typeof fetchExpectedSha256>;
const mockSha = sha256File as jest.MockedFunction<typeof sha256File>;
const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;

// A 4B downloaded before verification existed: no digest, backfilled to
// unverified, and left errored by a failed load.
function legacyModel(overrides = {}) {
  return {
    id: "m1",
    displayName: "Qwen3 4B Instruct (2507)",
    hfRepo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    hfFile: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    filePath: "file:///docs/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeBytes: 2_500_000_000,
    minRamMb: 4096,
    chatTemplate: null,
    contextSize: 4096,
    role: "primary",
    state: "error",
    resumeToken: null,
    sha256: null,
    trust: "unverified",
    isActive: false,
    createdAt: 0,
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({ error: null, busy: false, installed: [] });
  mockFS.getInfoAsync.mockResolvedValue({ exists: true, size: 2_500_000_000 } as never);
  mockSha.mockResolvedValue(GOOD);
});

const verify = (id = "m1") => useModelStore.getState().verifyIntegrity(id);

describe("legacy download, digest matches upstream", () => {
  it("upgrades trust and makes it usable again — without re-downloading", async () => {
    mockGet.mockResolvedValue(legacyModel());
    mockUpstream.mockResolvedValue(GOOD);

    await verify();

    expect(mockUpstream).toHaveBeenCalledWith(
      "unsloth/Qwen3-4B-Instruct-2507-GGUF",
      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    );
    expect(mockIntegrity).toHaveBeenCalledWith("m1", {
      sha256: GOOD,
      trust: "verified_upstream",
      state: "ready",
      sizeBytes: 2_500_000_000,
    });
    // Nothing was deleted to achieve it.
    expect(mockFS.deleteAsync).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/verified against/i);
  });

  it("refreshes a stale recorded size, which is what stranded it", async () => {
    mockGet.mockResolvedValue(legacyModel({ sizeBytes: 2_499_000_000 }));
    mockUpstream.mockResolvedValue(GOOD);
    mockFS.getInfoAsync.mockResolvedValue({ exists: true, size: 2_500_000_000 } as never);

    await verify();

    expect(mockIntegrity).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ sizeBytes: 2_500_000_000, state: "ready" }),
    );
  });
});

describe("digest does not match upstream", () => {
  it("errors the model, never activates it, and says so plainly", async () => {
    mockGet.mockResolvedValue(legacyModel({ state: "ready" }));
    mockUpstream.mockResolvedValue(OTHER);

    await verify();

    expect(mockState).toHaveBeenCalledWith("m1", "error");
    expect(mockIntegrity).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/does NOT match/i);
    // The multi-GB file is left alone for the user to decide about.
    expect(mockFS.deleteAsync).not.toHaveBeenCalled();
  });
});

describe("no upstream digest obtainable", () => {
  it("stays unverified when the repo publishes none, and says which it was", async () => {
    mockGet.mockResolvedValue(legacyModel());
    mockUpstream.mockResolvedValue(null); // repo has no LFS oid for this file

    await verify();

    expect(mockIntegrity).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ trust: "unverified", state: "ready" }),
    );
    expect(useModelStore.getState().error).toMatch(/publishes no SHA-256/i);
  });

  it("stays unverified when the repo can't be reached — not knowing is not passing", async () => {
    mockGet.mockResolvedValue(legacyModel());
    mockUpstream.mockRejectedValue(new Error("offline"));

    await verify();

    const call = mockIntegrity.mock.calls[0][1];
    expect(call.trust).toBe("unverified");
    expect(call.trust).not.toBe("verified_upstream");
    expect(useModelStore.getState().error).toMatch(/couldn't reach/i);
  });
});

describe("a local import with a recorded digest", () => {
  it("re-checks against what was recorded, with no repo involved", async () => {
    mockGet.mockResolvedValue(
      legacyModel({
        hfRepo: null,
        hfFile: null,
        sha256: GOOD,
        trust: "user_supplied_baseline",
      }),
    );

    await verify();

    expect(mockUpstream).not.toHaveBeenCalled();
    expect(mockIntegrity).toHaveBeenCalledWith("m1", {
      state: "ready",
      sizeBytes: 2_500_000_000,
    });
    expect(useModelStore.getState().error).toMatch(/still matches/i);
  });

  it("errors when the file changed since import", async () => {
    mockGet.mockResolvedValue(
      legacyModel({ hfRepo: null, hfFile: null, sha256: OTHER, state: "ready" }),
    );

    await verify();

    expect(mockState).toHaveBeenCalledWith("m1", "error");
    expect(useModelStore.getState().error).toMatch(/has CHANGED/i);
  });
});

describe("edges", () => {
  it("reports a missing file rather than hashing nothing", async () => {
    mockGet.mockResolvedValue(legacyModel());
    mockFS.getInfoAsync.mockResolvedValue({ exists: false } as never);

    await verify();

    expect(mockState).toHaveBeenCalledWith("m1", "error");
    expect(mockSha).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/file is gone/i);
  });

  it("changes nothing when hashing is unavailable on the build", async () => {
    mockGet.mockResolvedValue(legacyModel());
    mockSha.mockResolvedValue(null);

    await verify();

    expect(mockIntegrity).not.toHaveBeenCalled();
    expect(mockState).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/hashing is unavailable/i);
  });
});

describe("activate() and the UI agree", () => {
  it("does not refuse an unverified model", async () => {
    mockGet.mockResolvedValue(legacyModel({ state: "ready", trust: "unverified" }));

    await useModelStore.getState().activate("m1");

    // It got past the policy check and tried to load — trust is not a gate.
    expect(useModelStore.getState().error).toBeNull();
  });

  it("refuses an embedding model, with the reason the UI shows", async () => {
    mockGet.mockResolvedValue(
      legacyModel({ role: "embedding", state: "ready", displayName: "Nomic Embed" }),
    );

    await useModelStore.getState().activate("m1");

    expect(useModelStore.getState().error).toMatch(/document search/i);
  });
});
