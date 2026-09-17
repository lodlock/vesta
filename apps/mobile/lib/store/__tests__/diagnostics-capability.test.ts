// Opening Diagnostics establishes the Qualcomm runtime's state, and costs a
// file read.
//
// Two rules, and they pull against each other, which is why both are pinned
// here rather than left to the screen:
//
//   1. A screen that REPORTS on a capability has to be able to establish that
//      capability. `npu` was populated only by the Models screen's refresh(),
//      so every Qualcomm section was invisible until the user had been there —
//      including the ones that describe the local runtime and have nothing to
//      do with Qualcomm's servers.
//
//   2. Opening a diagnostics screen must not decide, on the user's behalf, to
//      go to the network. Offline-first is the premise of the whole app, and
//      a hub query is a request to someone else's machine.
//
// So there are two calls and they are deliberately separate: readiness is
// native and local, and the cached hub snapshot is a file. Neither is
// `loadNpuHub()`, and this is the file that will fail if that ever changes.

import { useModelStore } from "../model-store";
import { npuHubModels, probeNpuRuntime } from "../../native/npu";
import * as FileSystem from "expo-file-system/legacy";
import { resetNpuReadinessForTests } from "../../models/npu-ready";
import { serializeSnapshot } from "../../models/npu-hub";

jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1 })),
  readAsStringAsync: jest.fn(async () => {
    throw new Error("no cache");
  }),
  writeAsStringAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500e9),
  deleteAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  copyAsync: jest.fn(async () => {}),
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
  // The one call that reaches Qualcomm. Every assertion about the network is
  // an assertion about this mock.
  npuHubModels: jest.fn(async () => ({ models: [] })),
  npuHubPullability: jest.fn(async () => null),
  isNpuBuild: jest.fn(() => true),
  probeNpuRuntime: jest.fn(async () => ({ version: "0.4.0" })),
  npuProbeHasRun: jest.fn(() => true),
  npuUnavailableReason: jest.fn(() => null),
  npuDeviceChipset: jest.fn(async () => ({ known: [] })),
}));
jest.mock("../../native/system-actions", () => ({
  getDeviceInfo: jest.fn(async () => ({ soc: "SM8850" })),
}));
jest.mock("../../models/geniex-compute", () => ({
  loadGenieXComputeUnit: jest.fn(async () => "hybrid"),
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

const mockHubModels = npuHubModels as jest.MockedFunction<typeof npuHubModels>;
const mockProbe = probeNpuRuntime as jest.MockedFunction<typeof probeNpuRuntime>;
const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;

// The launch state: nothing has been to the Models screen, so `npu` is the
// pessimistic default the store is constructed with.
const FRESH_LAUNCH = {
  inBuild: false,
  probed: false,
  available: false,
  reason: null,
  runtimeVersion: null,
  soc: null,
  runtimeChipset: undefined,
  canonicalSoc: null,
  chipsets: undefined,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  resetNpuReadinessForTests();
  useModelStore.setState({
    npu: { ...FRESH_LAUNCH },
    npuHub: { snapshot: null, error: null, checking: false },
    npuPullability: null,
  });
  mockFS.readAsStringAsync.mockRejectedValue(new Error("no cache"));
});

describe("readiness is established without going to Models", () => {
  it("turns the default 'no runtime' state into what the device actually reports", async () => {
    expect(useModelStore.getState().npu.inBuild).toBe(false);

    const npu = await useModelStore.getState().ensureNpuReadiness();

    expect(npu.inBuild).toBe(true);
    expect(npu.available).toBe(true);
    expect(npu.probed).toBe(true);
    expect(useModelStore.getState().npu.available).toBe(true);
  });

  it("does not ask Qualcomm for anything", async () => {
    await useModelStore.getState().ensureNpuReadiness();
    expect(mockHubModels).not.toHaveBeenCalled();
  });

  it("reports a probe that failed as failed, never as available", async () => {
    mockProbe.mockResolvedValue(null);

    const npu = await useModelStore.getState().ensureNpuReadiness();

    expect(npu.inBuild).toBe(true);
    expect(npu.available).toBe(false);
    // Still probed: the difference between "it did not start" and "nobody
    // asked" is the whole reason this field exists.
    expect(npu.probed).toBe(true);
  });

  it("is cached, so repeated opens do not re-probe", async () => {
    await useModelStore.getState().ensureNpuReadiness();
    await useModelStore.getState().ensureNpuReadiness();
    expect(mockProbe).toHaveBeenCalledTimes(1);
  });
});

describe("hub state without a hub query", () => {
  it("stays 'never checked' when there is no cache, and asks nobody", async () => {
    const hub = await useModelStore.getState().loadCachedNpuHub();

    expect(hub.snapshot).toBeNull();
    expect(hub.error).toBeNull();
    expect(mockHubModels).not.toHaveBeenCalled();
  });

  it("restores an earlier session's snapshot from disk, marked cached", async () => {
    mockFS.readAsStringAsync.mockResolvedValue(
      serializeSnapshot({
        models: [
          { name: "qualcomm/Qwen3-4B-Instruct-2507", modelType: "LLM", chipsets: ["x"] },
        ],
        checkedAt: 1_700_000_000_000,
        cached: false,
      }),
    );

    const hub = await useModelStore.getState().loadCachedNpuHub();

    expect(hub.snapshot?.models).toHaveLength(1);
    expect(hub.snapshot?.cached).toBe(true);
    expect(mockHubModels).not.toHaveBeenCalled();
  });

  it("never replaces a live answer with the file behind it", async () => {
    useModelStore.setState({
      npuHub: {
        snapshot: { models: [], checkedAt: 2_000_000_000_000, cached: false },
        error: null,
        checking: false,
      },
    });

    await useModelStore.getState().loadCachedNpuHub();

    expect(useModelStore.getState().npuHub.snapshot?.cached).toBe(false);
    expect(mockFS.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("survives a corrupt cache as 'never checked' rather than a half list", async () => {
    mockFS.readAsStringAsync.mockResolvedValue("{ not json");

    const hub = await useModelStore.getState().loadCachedNpuHub();

    expect(hub.snapshot).toBeNull();
    expect(hub.error).toBeNull();
  });
});

describe("what a Diagnostics open costs, together", () => {
  it("is one native probe and one file read, and no request to Qualcomm", async () => {
    // Exactly the pair the screen's gather() awaits.
    await Promise.all([
      useModelStore.getState().ensureNpuReadiness(),
      useModelStore.getState().loadCachedNpuHub(),
    ]);

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockFS.readAsStringAsync).toHaveBeenCalledTimes(1);
    expect(mockHubModels).not.toHaveBeenCalled();
  });

  it("leaves the hub refresh entirely to the user's own action", async () => {
    await useModelStore.getState().ensureNpuReadiness();
    expect(mockHubModels).not.toHaveBeenCalled();

    // …and the explicit check is still what populates it.
    await useModelStore.getState().loadNpuHub(true);
    expect(mockHubModels).toHaveBeenCalledTimes(1);
  });
});
