// Tapping "Use this model" once, however many times you tap it.
//
// The scenario, from the SM8850 device: activating the Qwen3-4B NPU bundle
// takes ~14 s while GenieX builds the QAIRT session, and nothing on the card
// changed while it did. The button looked dead, so it got pressed again —
// three times.
//
// The engine's own lock already stopped two LlmWrappers from being created, so
// that was never the danger. The danger is everything activate() does AROUND
// the load — the registry read, the bundle probe, warmSessionCache,
// setActiveModel, refresh — none of which is under that lock, which is how two
// activations can race to write `is_active` and leave the registry naming a
// model the engine is not running.
//
// What must hold: one tap starts one load, later taps join it rather than
// start another, a second model is refused while one is loading, a failure
// leaves the row usable and says what the runtime actually said, an already
// resident model is never torn down and rebuilt, and none of this state lives
// in the Models screen.

import { useModelStore, activationInFlight } from "../model-store";
import { getModelById, setActiveModel } from "../../models/model-registry";
import { loadModel, unloadModel, getModelInfo } from "../../llm/llm-engine";
import { npuBundleInfo } from "../../native/npu";
import type { InstalledModel } from "../../models/types";

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1 })),
  copyAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  getFreeDiskStorageAsync: jest.fn(async () => 500e9),
  deleteAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  readAsStringAsync: jest.fn(async () => {
    throw new Error("no cache");
  }),
  writeAsStringAsync: jest.fn(async () => {}),
  createDownloadResumable: jest.fn(),
}));
jest.mock("../../models/model-registry", () => ({
  listInstalled: jest.fn(async () => []),
  getModelById: jest.fn(),
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
  npuBundleInfo: jest.fn(async () => ({ modelName: "qualcomm/Qwen3-4B" })),
  npuRemoveBundle: jest.fn(async () => {}),
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
jest.mock("../../orchestrator/session-warmer", () => ({
  warmSessionCache: jest.fn(async () => {}),
}));
jest.mock("../../llm/perf-config", () => ({
  getPerfSettings: jest.fn(async () => ({})),
  perfToLlmOptions: jest.fn(() => ({})),
}));
jest.mock("../chat-store", () => ({
  useChatStore: { getState: () => ({ updateModelStatus: jest.fn() }) },
}));

const mockGetModel = getModelById as jest.MockedFunction<typeof getModelById>;
const mockSetActive = setActiveModel as jest.MockedFunction<typeof setActiveModel>;
const mockLoad = loadModel as jest.MockedFunction<typeof loadModel>;
const mockUnload = unloadModel as jest.MockedFunction<typeof unloadModel>;
const mockInfo = getModelInfo as jest.MockedFunction<typeof getModelInfo>;
const mockBundleInfo = npuBundleInfo as jest.MockedFunction<typeof npuBundleInfo>;

// The real row: an AI Hub bundle, ready, not yet active. Its file_path points
// INTO the GenieX cache, which is why activate() probes the model manager
// rather than stat-ing a file.
function bundle(overrides: Partial<InstalledModel> = {}): InstalledModel {
  return {
    id: "npu1",
    displayName: "Qwen3 4B Instruct (2507) (NPU)",
    hfRepo: null,
    hfFile: null,
    filePath: "/data/geniex/models/qwen3/model.serialized.bin",
    quant: null,
    sizeBytes: 2_380_000_000,
    minRamMb: 8192,
    chatTemplate: null,
    contextSize: 4096,
    role: "primary",
    state: "ready",
    resumeToken: null,
    sha256: null,
    trust: "unverified",
    backend: "qnn",
    artifact: "geniex_bundle",
    targetSoc: "SM8850",
    runtimeVersion: null,
    runtimeModelName: "qualcomm/Qwen3-4B-Instruct-2507",
    tokenizerPath: "/data/geniex/models/qwen3/tokenizer.json",
    bundleFiles: [],
    isActive: false,
    createdAt: 0,
    ...overrides,
  } as InstalledModel;
}

/** A load that does not finish until the test says so — the 14 s window. */
function pendingLoad() {
  let settle!: (err?: Error) => void;
  mockLoad.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = (err?: Error) => (err ? reject(err) : resolve());
      }),
  );
  return {
    succeed: () => settle(),
    fail: (message: string) => settle(new Error(message)),
  };
}

/** Lets every already-queued microtask run, without settling the load. */
const settleMicrotasks = () => new Promise((r) => setImmediate(r));

const activate = (id = "npu1") => useModelStore.getState().activate(id);

beforeEach(() => {
  jest.clearAllMocks();
  useModelStore.setState({
    error: null,
    busy: false,
    installed: [bundle()],
    npuInstallErrors: {},
    activating: null,
    activationErrors: {},
  });
  mockGetModel.mockResolvedValue(bundle());
  mockBundleInfo.mockResolvedValue({ modelName: "qualcomm/Qwen3-4B" } as never);
  mockInfo.mockReturnValue({ loaded: false });
  mockLoad.mockResolvedValue(undefined);
});

describe("one tap, one load", () => {
  it("starts exactly one load and says so before the first await", async () => {
    const load = pendingLoad();

    const first = activate();

    // The point of the whole change: the card can already say "Loading model…"
    // — no await has resolved yet, this is the same tick as the tap.
    expect(useModelStore.getState().activating).toBe("npu1");

    await settleMicrotasks();
    expect(mockLoad).toHaveBeenCalledTimes(1);

    load.succeed();
    await first;
  });

  it("does not start a second load when the button is tapped again", async () => {
    const load = pendingLoad();

    const first = activate();
    await settleMicrotasks();
    expect(mockLoad).toHaveBeenCalledTimes(1);

    // The three impatient taps.
    const repeats = [activate(), activate(), activate()];
    await settleMicrotasks();

    expect(mockLoad).toHaveBeenCalledTimes(1);
    // And no half-truth on the way out: every repeat tap resolves when the ONE
    // load does, so a caller that awaits activate() is never told a model is
    // active while GenieX is still building it.
    load.succeed();
    await Promise.all([first, ...repeats]);
    expect(mockSetActive).toHaveBeenCalledTimes(1);
  });

  it("refuses a different model while one is loading, and says which", async () => {
    const load = pendingLoad();
    useModelStore.setState({
      installed: [bundle(), bundle({ id: "npu2", displayName: "Other model" })],
    });

    const first = activate("npu1");
    await settleMicrotasks();

    await activate("npu2");

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(useModelStore.getState().activationErrors.npu2).toContain(
      "Qwen3 4B Instruct (2507) (NPU)",
    );
    // The refusal belongs to the row that was refused. The one still loading
    // is untouched.
    expect(useModelStore.getState().activating).toBe("npu1");
    expect(useModelStore.getState().activationErrors.npu1).toBeUndefined();

    load.succeed();
    await first;
  });
});

describe("what the card shows when it is over", () => {
  it("marks the model active and clears the loading state", async () => {
    await activate();

    expect(mockSetActive).toHaveBeenCalledWith("npu1");
    expect(useModelStore.getState().activating).toBeNull();
    expect(activationInFlight()).toBeNull();
    expect(useModelStore.getState().activationErrors).toEqual({});
  });

  it("clears the loading state on failure and keeps the runtime's own words", async () => {
    mockLoad.mockRejectedValue(
      new Error("qwen3::makePipeline failed: failed to open file: null"),
    );

    await activate();

    expect(useModelStore.getState().activating).toBeNull();
    expect(activationInFlight()).toBeNull();
    // Verbatim, on the row and in the banner. A generic "could not load the
    // model" would delete the only description of the failure that exists.
    expect(useModelStore.getState().activationErrors.npu1).toBe(
      "qwen3::makePipeline failed: failed to open file: null",
    );
    expect(useModelStore.getState().error).toBe(
      "qwen3::makePipeline failed: failed to open file: null",
    );
    // The bundle is still installed. A session that could not be created says
    // nothing about the bytes on disk.
    expect(mockSetActive).not.toHaveBeenCalled();
  });

  it("lets the user try again after a failure", async () => {
    mockLoad.mockRejectedValueOnce(new Error("NPU_LOAD_FAILED"));
    await activate();

    mockLoad.mockResolvedValue(undefined);
    await activate();

    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(useModelStore.getState().activationErrors.npu1).toBeUndefined();
    expect(mockSetActive).toHaveBeenCalledWith("npu1");
  });
});

describe("the model that is already resident", () => {
  // Cold load ~14 s, warm reuse ~6 ms. Rebuilding an identical QAIRT session
  // because a card was tapped would spend the first to arrive at the second.
  it("does nothing when the active model is loaded and tapped again", async () => {
    useModelStore.setState({ installed: [bundle({ isActive: true })] });
    mockInfo.mockReturnValue({
      loaded: true,
      path: "/data/geniex/models/qwen3/model.serialized.bin",
    });

    await activate();

    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockUnload).not.toHaveBeenCalled();
    expect(mockSetActive).not.toHaveBeenCalled();
    // And no flash of "Loading model…" on the way to doing nothing.
    expect(useModelStore.getState().activating).toBeNull();
  });

  it("still loads a row marked active that the engine is NOT holding", async () => {
    // What a cold start looks like: the registry remembers the choice, the
    // process has no session yet.
    useModelStore.setState({ installed: [bundle({ isActive: true })] });
    mockGetModel.mockResolvedValue(bundle({ isActive: true }));
    mockInfo.mockReturnValue({ loaded: false });

    await activate();

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});

describe("state the Models screen does not own", () => {
  // The screen can unmount mid-load — the user goes back to the chat while
  // GenieX works — and the load must neither stop nor be forgotten. Nothing
  // here touches React: that IS the assertion. The pending state is a store
  // field, so a remounted card re-reads it and renders the same thing.
  it("keeps the pending activation readable across screen lifetimes", async () => {
    const load = pendingLoad();

    // "The Models screen is mounted": a card subscribed to `activating`.
    const seen: (string | null)[] = [];
    const unmount = useModelStore.subscribe((s) => seen.push(s.activating));

    const first = activate();
    await settleMicrotasks();
    expect(seen).toContain("npu1");

    // "The user navigates away." Nothing is cancelled, because nothing about
    // the load was ever attached to that subscription.
    unmount();

    expect(activationInFlight()).toBe("npu1");
    load.succeed();
    await first;

    expect(mockSetActive).toHaveBeenCalledWith("npu1");
    // "And comes back": a fresh read reconstructs the finished state from the
    // store, with no re-render or re-fetch needed to discover it.
    expect(useModelStore.getState().activating).toBeNull();
    expect(useModelStore.getState().activationErrors).toEqual({});
  });

  it("does not delete a model whose activation is still running", async () => {
    const load = pendingLoad();

    const first = activate();
    await settleMicrotasks();

    await useModelStore.getState().remove("npu1");

    expect(mockUnload).not.toHaveBeenCalled();
    expect(useModelStore.getState().activationErrors.npu1).toContain(
      "still loading",
    );

    load.succeed();
    await first;
  });
});
