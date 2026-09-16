// A download the runtime has already committed is not ours to throw away.
//
// The scenario, from a real device: GenieX pulled 2.38 GB, reported
// `pull() returned rc=0`, and `getPaths()` resolved. Vesta's own post-pull
// check then failed — on GenieX's zero-byte `.lock`, since fixed — and the
// install path deleted the bundle before the message reached the screen. The
// probe afterwards read `list(): 0 model(s)`.
//
// `npuPull()` only resolves after BOTH of the runtime's own success signals,
// so anything failing after it is Vesta disagreeing with a runtime that has
// already said yes. What must hold: that disagreement costs the user nothing
// but a message, while a pull GenieX itself failed still cleans up, and an
// explicit delete still deletes.

import { useModelStore } from "../model-store";
import {
  finalizeBundle,
  removeModel,
  setModelState,
} from "../../models/model-registry";
import { npuPull, npuRemoveBundle } from "../../native/npu";
import type { CompatibleHubModel } from "../../models/npu-hub";

// The store now reads one user setting straight from the config table (whether
// to retry an interrupted download). Mocked like every other edge this suite
// stubs — expo-sqlite has no native side here.
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1 })),
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
  getActiveModel: jest.fn(async () => ({ id: "other" })),
  insertModel: jest.fn(async (m) => ({ ...m, id: "row1" })),
  setModelState: jest.fn(async () => {}),
  setResumeToken: jest.fn(async () => {}),
  finalizeModel: jest.fn(async () => {}),
  finalizeBundle: jest.fn(async () => {}),
  setModelIntegrity: jest.fn(async () => {}),
  setActiveModel: jest.fn(async () => {}),
  removeModel: jest.fn(async () => {}),
}));
// The real module, with only the two calls under test replaced. Everything
// else already no-ops in jest — there is no native module to reach — which is
// exactly the behaviour these cases want from it.
jest.mock("../../native/npu", () => ({
  ...jest.requireActual("../../native/npu"),
  npuPull: jest.fn(),
  npuRemoveBundle: jest.fn(async () => {}),
  npuBundleInfo: jest.fn(async () => null),
  onNpuPullProgress: jest.fn(() => () => {}),
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
// The pre-download compatibility gate is a different decision, taken before a
// byte moves, and it has its own tests. Stubbed to "no objection" so these
// cases reach the post-pull branch that is under test here.
jest.mock("../../llm/backends/registry", () => ({
  ...jest.requireActual("../../llm/backends/registry"),
  npuRefusalFor: jest.fn(() => null),
}));

const mockPull = npuPull as jest.MockedFunction<typeof npuPull>;
const mockRemoveBundle = npuRemoveBundle as jest.MockedFunction<typeof npuRemoveBundle>;
const mockRemoveModel = removeModel as jest.MockedFunction<typeof removeModel>;
const mockFinalize = finalizeBundle as jest.MockedFunction<typeof finalizeBundle>;
const mockState = setModelState as jest.MockedFunction<typeof setModelState>;

const HUB_ROW: CompatibleHubModel = {
  entry: {
    name: "qualcomm/Qwen3-4B-Instruct-2507",
    modelType: "LLM",
    chipsets: ["qualcomm-snapdragon-8-elite-gen5"],
  },
  hubChipsetKey: "qualcomm-snapdragon-8-elite-gen5",
  canonicalSoc: "SM8850",
};

/** What npuPull() resolves with — the runtime has already committed by then. */
const pulled = (files: { path: string; sizeBytes: number }[]) => ({
  modelName: "qualcomm/Qwen3-4B-Instruct-2507",
  modelPath: "/data/geniex/models/qwen3",
  modelDir: "/data/geniex/models/qwen3",
  tokenizerPath: "/data/geniex/models/qwen3/tokenizer.json",
  runtimeId: "qairt",
  files,
  totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
});

const COMPLETE = [
  { path: "metadata.json", sizeBytes: 4096 },
  { path: "tokenizer.json", sizeBytes: 2_500_000 },
  { path: "tokenizer_config.json", sizeBytes: 8192 },
  { path: "weights_1.bin", sizeBytes: 2_380_000_000 },
];

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({
    error: null,
    busy: false,
    installed: [],
    npuInstallErrors: {},
    npu: { inBuild: true, available: true, soc: "SM8850" } as never,
  });
});

const install = () => useModelStore.getState().installHubModel(HUB_ROW);

describe("the bundle GenieX already committed", () => {
  // The exact 2.38 GB case: a complete bundle plus the manager's zero-byte
  // lock. It now installs, which is the first fix.
  it("installs with GenieX's zero-byte .lock beside the weights", async () => {
    mockPull.mockResolvedValue(
      pulled([{ path: ".lock", sizeBytes: 0 }, ...COMPLETE]) as never,
    );

    await install();

    expect(mockRemoveBundle).not.toHaveBeenCalled();
    expect(mockRemoveModel).not.toHaveBeenCalled();
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(useModelStore.getState().npuInstallErrors).toEqual({});
  });

  // The second fix, and the one that matters most: even when Vesta's own check
  // genuinely fails, the download stays. Gigabytes are not a client-side
  // opinion's to discard.
  it("keeps the download when Vesta's own validation disagrees", async () => {
    mockPull.mockResolvedValue(
      pulled(COMPLETE.filter((f) => f.path !== "tokenizer.json")) as never,
    );

    await install();

    expect(mockRemoveBundle).not.toHaveBeenCalled();
    expect(mockRemoveModel).not.toHaveBeenCalled();
  });

  it("keeps the row as a usable handle on it — recorded, errored, removable", async () => {
    mockPull.mockResolvedValue(
      pulled(COMPLETE.filter((f) => f.path !== "tokenizer.json")) as never,
    );

    await install();

    // Recorded, so Verify has a manifest and Delete has a path.
    expect(mockFinalize).toHaveBeenCalledWith("row1", {
      filePath: "/data/geniex/models/qwen3",
      tokenizerPath: "/data/geniex/models/qwen3/tokenizer.json",
      sizeBytes: expect.any(Number),
      bundleFiles: expect.arrayContaining([
        expect.objectContaining({ path: "metadata.json" }),
      ]),
    });
    // Errored, so canActivate() refuses it rather than loading something we
    // just said was incomplete.
    expect(mockState).toHaveBeenCalledWith("row1", "error");
  });

  it("says why, and says the bytes were kept", async () => {
    mockPull.mockResolvedValue(
      pulled(COMPLETE.filter((f) => f.path !== "tokenizer.json")) as never,
    );

    await install();

    const message =
      useModelStore.getState().npuInstallErrors["qualcomm/Qwen3-4B-Instruct-2507"];
    expect(message).toContain("tokenizer.json");
    expect(message).toContain("KEPT");
  });
});

describe("a pull GenieX itself failed", () => {
  // Unchanged semantics. npuPull() rejecting means the runtime never committed,
  // so a row pointing at nothing is what gets cleaned up.
  it("still removes the placeholder row", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100010: hub model not found"));

    await install();

    expect(mockRemoveModel).toHaveBeenCalledWith("row1");
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(
      useModelStore.getState().npuInstallErrors["qualcomm/Qwen3-4B-Instruct-2507"],
    ).toContain("-100010");
  });
});
