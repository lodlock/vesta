// A GGUF the GenieX model manager owns, from import to delete.
//
// The delete half is the reason this file exists. `remove()` decided how to
// free a model's bytes with `isNpuModel(model) && model.runtimeModelName` —
// ask the runtime — and fell through to `deleteModelFile(model.filePath)`
// otherwise. That was correct only because the two conditions described the
// same set: every GenieX-owned row was a QAIRT context bundle, whose artifact
// is `qairt_context`.
//
// A GenieX llama.cpp model breaks that coincidence. Its artifact is `gguf`, so
// `isNpuModel()` is false, and `file_path` points at a .gguf INSIDE the
// manager's own model directory. The old branch would have unlinked that one
// file and left everything else — geniex.json, the tokenizer, the .lock — in
// place, with the manager still listing the model and `getPaths()` still
// resolving to a path that no longer exists. The next load would fail inside
// the runtime rather than at a check Vesta could explain.
//
// So the test is OWNERSHIP, `runtime_model_name`, and both directions of it
// are pinned here: a managed model is deleted by asking the manager, and an
// ordinary GGUF is still unlinked.

import { useModelStore } from "../model-store";
import { getModelById, insertModel, removeModel } from "../../models/model-registry";
import { npuImportBundle, npuRemoveBundle } from "../../native/npu";
import { deleteModelFile } from "../../models/download-manager";
import type { InstalledModel } from "../../models/types";

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
  getActiveModel: jest.fn(async () => null),
  insertModel: jest.fn(async (m) => ({ ...m, id: "row1" })),
  setModelState: jest.fn(async () => {}),
  setResumeToken: jest.fn(async () => {}),
  finalizeModel: jest.fn(async () => {}),
  finalizeBundle: jest.fn(async () => {}),
  setModelIntegrity: jest.fn(async () => {}),
  setActiveModel: jest.fn(async () => {}),
  removeModel: jest.fn(async () => {}),
}));
jest.mock("../../native/npu", () => ({
  ...jest.requireActual("../../native/npu"),
  npuImportBundle: jest.fn(),
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

const mockImport = npuImportBundle as jest.MockedFunction<typeof npuImportBundle>;
const mockRemoveBundle = npuRemoveBundle as jest.MockedFunction<typeof npuRemoveBundle>;
const mockGetById = getModelById as jest.MockedFunction<typeof getModelById>;
const mockInsert = insertModel as jest.MockedFunction<typeof insertModel>;
const mockRemoveRow = removeModel as jest.MockedFunction<typeof removeModel>;
const mockDeleteFile = deleteModelFile as jest.MockedFunction<typeof deleteModelFile>;

const PUSH_DIR = "/storage/emulated/0/Android/data/com.cosmico.vesta/files/geniex-spike";

/** What the manager answers with after a LOCALFS import of a GGUF directory. */
const imported = (runtimeId: string | null = "llama_cpp") => ({
  modelName: "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
  modelPath: "/data/user/0/com.cosmico.vesta/files/geniex/models/local/q/model-Q4_0.gguf",
  modelDir: "/data/user/0/com.cosmico.vesta/files/geniex/models/local/q",
  tokenizerPath: null,
  runtimeId,
  files: [
    { path: "model-Q4_0.gguf", sizeBytes: 2_380_000_000 },
    { path: "geniex.json", sizeBytes: 812 },
  ],
  totalBytes: 2_380_000_812,
});

/** A row as the import leaves it. */
const managedRow = (over: Partial<InstalledModel> = {}): InstalledModel =>
  ({
    id: "row1",
    displayName: "Qwen3-4B-Instruct-2507-fraQtl-HiFi-Q4_0",
    filePath: imported().modelPath,
    artifact: "gguf",
    backend: "geniex_llama_cpp",
    runtimeModelName: imported().modelName,
    state: "ready",
    role: "primary",
    isActive: false,
    bundleFiles: [],
    ...over,
  }) as InstalledModel;

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({ installed: [], error: null, busy: false });
});

describe("importing a side-loaded GGUF", () => {
  it("hands the manager the DIRECTORY, a name and an explicit precision", async () => {
    mockImport.mockResolvedValueOnce(imported());
    await useModelStore.getState().importGenieXGguf(PUSH_DIR, "Qwen3-Q4_0");

    expect(mockImport).toHaveBeenCalledWith({
      modelName: "local/qwen3-q4_0",
      localPath: PUSH_DIR,
      displayName: "Qwen3-Q4_0",
      // Omitted, the inferred manifest keeps one entry per quant and copies
      // every one of them.
      precision: "Q4_0",
    });
    // `hub` is pinned to LOCALFS on the native side; sending one here would be
    // a second definition of the same decision.
    expect(mockImport.mock.calls[0][0]).not.toHaveProperty("hub");
  });

  it("records the three fields that route the row", async () => {
    mockImport.mockResolvedValueOnce(imported());
    await useModelStore.getState().importGenieXGguf(PUSH_DIR, "Qwen3-Q4_0");

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "geniex_llama_cpp",
        artifact: "gguf",
        runtimeModelName: "local/qwen3-q4_0",
        state: "ready",
      }),
    );
    expect(useModelStore.getState().error).toBeNull();
  });

  it("undoes the import when the manifest names another runtime", async () => {
    // A QAIRT directory pushed here by mistake. The manager's own word decides,
    // and nothing is left behind for a lane that cannot load it.
    mockImport.mockResolvedValueOnce(imported("qairt"));
    await useModelStore.getState().importGenieXGguf(PUSH_DIR, "Wrong");

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockRemoveBundle).toHaveBeenCalledWith("local/wrong");
    expect(useModelStore.getState().error).toMatch(/not a GenieX llama\.cpp/);
  });

  it("leaves nothing half-imported when the import itself fails", async () => {
    mockImport.mockRejectedValueOnce(new Error("no recognizable model files found"));
    await useModelStore.getState().importGenieXGguf(PUSH_DIR, "Broken");

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockRemoveBundle).toHaveBeenCalledWith("local/broken");
    expect(useModelStore.getState().error).toMatch(/no recognizable model files/);
  });

  it("refuses a second import of the same name", async () => {
    useModelStore.setState({
      installed: [managedRow({ runtimeModelName: "local/qwen3-q4_0" })],
    });
    await useModelStore.getState().importGenieXGguf(PUSH_DIR, "Qwen3-Q4_0");
    expect(mockImport).not.toHaveBeenCalled();
    expect(useModelStore.getState().error).toMatch(/already imported/);
  });
});

describe("deleting what the manager owns", () => {
  it("asks the runtime, and never unlinks inside its directory", async () => {
    // The regression this branch exists for: file_path points INTO the
    // manager's model directory, and unlinking it would strand the rest while
    // the manager went on listing the model.
    mockGetById.mockResolvedValueOnce(managedRow());
    await useModelStore.getState().remove("row1");

    expect(mockRemoveBundle).toHaveBeenCalledWith(
      "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
    );
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockRemoveRow).toHaveBeenCalledWith("row1");
  });

  it("still asks the runtime for a QAIRT bundle", async () => {
    // The case the old artifact-based test covered. It must not regress just
    // because the condition widened.
    mockGetById.mockResolvedValueOnce(
      managedRow({
        artifact: "qairt_context",
        backend: "qualcomm_npu",
        runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
      }),
    );
    await useModelStore.getState().remove("row1");

    expect(mockRemoveBundle).toHaveBeenCalledWith("ai-hub-models/Qwen3-4B-Instruct-2507");
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("still unlinks an ordinary GGUF Vesta downloaded itself", async () => {
    // The other direction. A row with no runtime_model_name is Vesta's own
    // file in Vesta's own directory, and the runtime knows nothing about it.
    mockGetById.mockResolvedValueOnce(
      managedRow({
        backend: "llama_cpp",
        runtimeModelName: null,
        filePath: "file:///docs/models/qwen3-4b-Q4_K_M.gguf",
      }),
    );
    await useModelStore.getState().remove("row1");

    expect(mockDeleteFile).toHaveBeenCalledWith("file:///docs/models/qwen3-4b-Q4_K_M.gguf");
    expect(mockRemoveBundle).not.toHaveBeenCalled();
  });
});
