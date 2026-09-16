// Cancel, and the thirty seconds the screen used to spend saying nothing.
//
// On device: tap Cancel during "Starting download…", nothing changes, tap it
// four more times, and about thirty seconds later "Download canceled" appears.
//
// Two faults, and only one of them was GenieX's. GenieX's: `pullJob.cancel()`
// cancels a Kotlin coroutine, coroutine cancellation is cooperative, and the
// pull is a blocking native call collecting a Flow — so the runtime unwinds at
// its own pace and nothing here can hurry it. Ours: `cancelNpuInstall` awaited
// `npuRemoveBundle()`, which is `ModelManagerWrapper.remove()` and cannot take
// a bundle the pull still holds, BEFORE it touched a single piece of state. The
// entire unwind therefore elapsed before the screen changed, and every extra
// tap fired another native cancel and another remove() at a bundle mid-unwind.
//
// What must hold now: the first tap is visible immediately, the runtime is
// asked once, "canceled" is not claimed until the pull has actually exited, and
// nothing starts a new pull in the meantime.

import { useModelStore, resetNpuInstallStateForTests } from "../model-store";
import { npuPull, npuRemoveBundle, npuCancelPull } from "../../native/npu";
import { removeModel, getModelById } from "../../models/model-registry";
import { getConfig } from "../../storage/database";
import { TRANSIENT_PULL_RC } from "../../models/npu-errors";
import type { CompatibleHubModel } from "../../models/npu-hub";

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
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
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
jest.mock("../../native/npu", () => ({
  ...jest.requireActual("../../native/npu"),
  npuPull: jest.fn(),
  npuCancelPull: jest.fn(),
  npuRemoveBundle: jest.fn(async () => {}),
  npuBundleInfo: jest.fn(async () => null),
  npuHubPullability: jest.fn(async () => null),
  npuLogDiagnostic: jest.fn(),
  onNpuPullProgress: jest.fn(() => () => {}),
}));
jest.mock("../../models/npu-ready", () => ({
  prepareNpuBackend: jest.fn(async () => ({
    inBuild: true,
    available: true,
    soc: "SM8850",
    canonicalSoc: "SM8850",
    chipsets: [{ name: "Snapdragon 8 Elite Gen 5 QRD", aliases: ["SM8850"] }],
    reason: null,
  })),
  resetNpuReadinessForTests: jest.fn(),
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
jest.mock("../../llm/backends/registry", () => ({
  ...jest.requireActual("../../llm/backends/registry"),
  npuRefusalFor: jest.fn(() => null),
}));

const mockPull = npuPull as jest.MockedFunction<typeof npuPull>;
const mockCancelPull = npuCancelPull as jest.MockedFunction<typeof npuCancelPull>;
const mockRemoveBundle = npuRemoveBundle as jest.MockedFunction<typeof npuRemoveBundle>;
const mockRemoveModel = removeModel as jest.MockedFunction<typeof removeModel>;
const mockGetModelById = getModelById as jest.MockedFunction<typeof getModelById>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const MODEL = "qualcomm/Qwen3-4B-Instruct-2507";

const HUB_ROW: CompatibleHubModel = {
  entry: { name: MODEL, modelType: "LLM", chipsets: ["qualcomm-snapdragon-8-elite-gen5"] },
  hubChipsetKey: "qualcomm-snapdragon-8-elite-gen5",
  canonicalSoc: "SM8850",
};

const rc = (code: number, text = "geniex_model_pull failed") =>
  new Error(`rc=${code}: ${text}`);

const retrySettings = (autoRetry: boolean, maxRetries: number | "unlimited") =>
  mockConfig.mockImplementation(async (key: string) =>
    key === "download_retry" ? JSON.stringify({ autoRetry, maxRetries }) : null,
  );

const install = () => useModelStore.getState().installHubModel(HUB_ROW);

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 50 && !done; i++) {
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  }
  return promise;
}

/** A pull that never settles on its own, like a real multi-gigabyte one. */
function hangingPull() {
  let reject!: (e: unknown) => void;
  mockPull.mockImplementation(
    () =>
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
  );
  return {
    /** What GenieX does ~30 seconds later: the flow finally unwinds. */
    unwind: () => reject(rc(-100006, "Download canceled")),
  };
}

/**
 * Starts an install and lets it reach the pull.
 *
 * Wrapped in an object on purpose: `await` unwraps a returned promise, so
 * handing the install promise back directly would make every caller wait for a
 * download that never finishes.
 */
async function started(): Promise<{ running: Promise<void> }> {
  const running = install();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return { running };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNpuInstallStateForTests();
  jest.useFakeTimers();
  mockConfig.mockResolvedValue(null);
  mockGetModelById.mockResolvedValue(null as never);
  useModelStore.setState({
    error: null,
    busy: false,
    installed: [],
    npuInstallErrors: {},
    npuCanceling: {},
    npuPullability: null,
    progress: {},
    npu: { inBuild: true, available: true, soc: "SM8850" } as never,
  });
});

afterEach(() => jest.useRealTimers());

describe("the first tap", () => {
  it("enters the canceling state before anything is awaited", async () => {
    const pull = hangingPull();
    const { running } = await started();

    // Deliberately not awaited: the claim is that the state is set
    // synchronously, so the very next frame can say "Canceling…".
    useModelStore.getState().cancelNpuInstall("row1");

    expect(useModelStore.getState().npuCanceling["row1"]).toBe(true);
    // And nothing has been torn down, because the pull is still running.
    expect(mockRemoveBundle).not.toHaveBeenCalled();

    pull.unwind();
    await settle(running);
  });

  it("asks the runtime to stop", async () => {
    const pull = hangingPull();
    const { running } = await started();

    await useModelStore.getState().cancelNpuInstall("row1");
    expect(mockCancelPull).toHaveBeenCalledTimes(1);

    pull.unwind();
    await settle(running);
  });
});

describe("repeated taps", () => {
  it("ask the runtime once, however many times they land", async () => {
    const pull = hangingPull();
    const { running } = await started();

    const state = useModelStore.getState();
    await state.cancelNpuInstall("row1");
    await state.cancelNpuInstall("row1");
    await state.cancelNpuInstall("row1");
    await state.cancelNpuInstall("row1");

    expect(mockCancelPull).toHaveBeenCalledTimes(1);
    // And no repeated remove() at a bundle that is mid-unwind.
    expect(mockRemoveBundle).not.toHaveBeenCalled();

    pull.unwind();
    await settle(running);
  });
});

describe("what \"canceled\" means", () => {
  it("stays canceling for as long as the runtime takes", async () => {
    const pull = hangingPull();
    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");

    // Thirty seconds of GenieX unwinding. Still canceling; still nothing torn
    // down. The screen says the same thing the whole time, and it is true.
    jest.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(useModelStore.getState().npuCanceling["row1"]).toBe(true);
    expect(mockRemoveModel).not.toHaveBeenCalled();

    pull.unwind();
    await settle(running);

    expect(useModelStore.getState().npuCanceling["row1"]).toBeUndefined();
    expect(mockRemoveModel).toHaveBeenCalledWith("row1");
  });

  // The user asked for the bytes to go — but remove() cannot take a bundle the
  // pull still holds, which is exactly why this moved out of the tap handler.
  it("removes the bundle only after the pull has exited", async () => {
    const pull = hangingPull();
    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");

    expect(mockRemoveBundle).not.toHaveBeenCalled();

    pull.unwind();
    await settle(running);

    expect(mockRemoveBundle).toHaveBeenCalledWith(MODEL);
  });
});

describe("while a cancel is pending", () => {
  it("no new install for that model may start", async () => {
    const pull = hangingPull();
    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");

    mockPull.mockClear();
    await settle(install());

    // Asking now would reach the native side as NPU_PULL_BUSY and read as a
    // fresh fault rather than as the old one still finishing.
    expect(mockPull).not.toHaveBeenCalled();
    expect(useModelStore.getState().npuInstallErrors[MODEL]).toContain(
      "still being canceled",
    );

    pull.unwind();
    await settle(running);
  });

  it("the model is installable again once it has finished", async () => {
    const pull = hangingPull();
    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");
    pull.unwind();
    await settle(running);

    mockPull.mockReset();
    mockPull.mockRejectedValue(rc(-100010));
    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });
});

describe("cancellation and retry", () => {
  it("never retries a cancelled pull, even with unlimited retries on", async () => {
    retrySettings(true, "unlimited");
    const pull = hangingPull();
    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");

    pull.unwind();
    await settle(running);

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  it("aborts a retry backoff immediately rather than sitting it out", async () => {
    retrySettings(true, "unlimited");
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC));

    const { running } = await started();
    await useModelStore.getState().cancelNpuInstall("row1");
    await settle(running);

    expect(mockPull).toHaveBeenCalledTimes(1);
  });
});

// A row left in "downloading" by a process killed mid-pull. There is no install
// to unwind, so it must not wait for an unwind that will never come.
describe("a stale row with no live install", () => {
  it("is torn down there and then", async () => {
    mockGetModelById.mockResolvedValue({
      id: "stale",
      runtimeModelName: MODEL,
    } as never);

    await useModelStore.getState().cancelNpuInstall("stale");

    expect(mockRemoveBundle).toHaveBeenCalledWith(MODEL);
    expect(mockRemoveModel).toHaveBeenCalledWith("stale");
    expect(useModelStore.getState().npuCanceling["stale"]).toBeUndefined();
  });
});

// A model the hub lists but does not distribute. `AiHubSource::plan()` refuses
// it on its first line — an empty `manifest_urls.release_assets` — so there is
// nothing to attempt, nothing to retry, and no licence to accept.
describe("a model with no published bundle", () => {
  const pullability = (hasReleaseAssets: boolean) =>
    useModelStore.setState({
      npuPullability: {
        manifestExists: true,
        models: [
          {
            id: "qwen3_4b_instruct_2507",
            displayName: "Qwen3-4B-Instruct-2507",
            hasReleaseAssets,
          },
        ],
      },
    });

  it("is never pulled at all", async () => {
    pullability(false);

    await settle(install());

    expect(mockPull).not.toHaveBeenCalled();
    const message = useModelStore.getState().npuInstallErrors[MODEL];
    expect(message).toContain("qai-hub-models");
    expect(message).toContain("Import bundle");
  });

  it("still pulls one the hub does distribute", async () => {
    pullability(true);
    mockPull.mockRejectedValue(rc(-100010));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  it("pulls when nothing is known, rather than refusing on no evidence", async () => {
    useModelStore.setState({ npuPullability: null });
    mockPull.mockRejectedValue(rc(-100010));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });
});
