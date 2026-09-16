// A download interrupted at 97% is not a failed download.
//
// On device, a Qualcomm pull of ~2.4 GB has failed with `rc=-100005` more than
// once during the same install, and the identical request has then succeeded —
// and a retry after a failure near the end fetched roughly the remainder rather
// than starting over. GenieX keeps its partial work in `.inflight` and fetches
// ranged chunks (`GENIEX_DL_CHUNK_SIZE`, `byte range starts at `, two
// `get_range retry ` messages in libgeniex.so), so asking again IS resuming.
//
// What must hold, and what these cases pin:
//   - only that one code retries; everything else surfaces immediately
//   - the user's switch and cap decide, read live rather than at install time
//   - nothing is deleted between attempts — the bytes are the whole point
//   - Cancel works during the wait, not only during a transfer
//   - two pullFlows can never overlap

import { useModelStore, resetNpuInstallStateForTests } from "../model-store";
import { npuPull, npuRemoveBundle, npuCancelPull } from "../../native/npu";
import { removeModel } from "../../models/model-registry";
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
// refresh() re-derives this after every install, and the real one asks the
// native bridge — which does not exist here. Pinned so a second install in the
// same test still sees a device with an NPU.
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
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const HUB_ROW: CompatibleHubModel = {
  entry: {
    name: "qualcomm/Qwen3-4B-Instruct-2507",
    modelType: "LLM",
    chipsets: ["qualcomm-snapdragon-8-elite-gen5"],
  },
  hubChipsetKey: "qualcomm-snapdragon-8-elite-gen5",
  canonicalSoc: "SM8850",
};

const COMPLETE = [
  { path: "metadata.json", sizeBytes: 4096 },
  { path: "tokenizer.json", sizeBytes: 2_500_000 },
  { path: "tokenizer_config.json", sizeBytes: 8192 },
  { path: "weights_1.bin", sizeBytes: 1_200_000_000 },
];

const pulled = () => ({
  modelName: "qualcomm/Qwen3-4B-Instruct-2507",
  modelPath: "/data/geniex/models/qwen3",
  modelDir: "/data/geniex/models/qwen3",
  tokenizerPath: "/data/geniex/models/qwen3/tokenizer.json",
  runtimeId: "qairt",
  files: COMPLETE,
  totalBytes: COMPLETE.reduce((n, f) => n + f.sizeBytes, 0),
});

/** What the bridge actually throws: the code first, then the runtime's words. */
const rc = (code: number, text = "geniex_model_pull failed") =>
  new Error(`rc=${code}: ${text}`);

/** The setting, as the store will read it out of the config table. */
const retrySettings = (autoRetry: boolean, maxRetries: number | "unlimited") =>
  mockConfig.mockImplementation(async (key: string) =>
    key === "download_retry" ? JSON.stringify({ autoRetry, maxRetries }) : null,
  );

const install = () => useModelStore.getState().installHubModel(HUB_ROW);

/**
 * Runs every pending timer until the install settles.
 *
 * The backoff is real setTimeout work under fake timers, so the promise cannot
 * resolve unless someone advances the clock — and advancing it once is not
 * enough, because each retry schedules the next wait only after the previous
 * pull has rejected. This alternates between draining microtasks and firing
 * timers until there is nothing left, which is also how it proves the loop is
 * sequential: a parallel implementation would finish without needing this.
 */
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

beforeEach(() => {
  jest.clearAllMocks();
  resetNpuInstallStateForTests();
  jest.useFakeTimers();
  mockConfig.mockResolvedValue(null); // defaults: auto-retry on, cap 3
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

describe("a transient failure, with auto-retry on", () => {
  // A: the case this exists for.
  it("asks for the same download again", async () => {
    mockPull
      .mockRejectedValueOnce(rc(TRANSIENT_PULL_RC))
      .mockResolvedValueOnce(pulled() as never);

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(2);
    // E: and stops as soon as one succeeds.
    expect(useModelStore.getState().npuInstallErrors).toEqual({});
  });

  // The identity a resume depends on. A retry that changed any of these three
  // would be a different download, not a continuation of this one.
  it("repeats the request byte for byte", async () => {
    mockPull
      .mockRejectedValueOnce(rc(TRANSIENT_PULL_RC))
      .mockResolvedValueOnce(pulled() as never);

    await settle(install());

    expect(mockPull.mock.calls[1][0]).toEqual(mockPull.mock.calls[0][0]);
    expect(mockPull.mock.calls[0][0]).toMatchObject({
      modelName: "qualcomm/Qwen3-4B-Instruct-2507",
      chipset: "SM8850",
    });
  });

  // C: the cap is honoured, and the original error is what survives it.
  it("stops at the cap and surfaces the runtime's own failure", async () => {
    retrySettings(true, 3);
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC, "connection reset"));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(4); // first attempt + 3 retries
    const message =
      useModelStore.getState().npuInstallErrors["qualcomm/Qwen3-4B-Instruct-2507"];
    expect(message).toContain(String(TRANSIENT_PULL_RC));
    expect(message).toContain("connection reset");
  });

  it("honours a cap of one", async () => {
    retrySettings(true, 1);
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(2);
  });

  // K: the bytes the last attempt left behind are the whole point.
  it("deletes nothing between attempts", async () => {
    mockPull
      .mockRejectedValueOnce(rc(TRANSIENT_PULL_RC))
      .mockResolvedValueOnce(pulled() as never);

    await settle(install());

    // No remove(), no clean(), no cache touched — GenieX resumes from
    // .inflight and would have to start over if any of this ran.
    expect(mockRemoveBundle).not.toHaveBeenCalled();
    expect(mockRemoveModel).not.toHaveBeenCalled();
  });

  // I: at most one pullFlow, ever. The native side rejects a concurrent pull
  // with NPU_PULL_BUSY, so an overlapping retry would turn a transient network
  // failure into a permanent-looking one.
  it("never has two pulls in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    mockPull.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      calls += 1;
      if (calls < 3) throw rc(TRANSIENT_PULL_RC);
      return pulled() as never;
    });

    await settle(install());

    expect(maxInFlight).toBe(1);
    expect(calls).toBe(3);
  });
});

describe("the user's switch", () => {
  // B: off means the error arrives at once.
  it("surfaces a transient failure immediately when auto-retry is off", async () => {
    retrySettings(false, 3);
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
    expect(
      useModelStore.getState().npuInstallErrors["qualcomm/Qwen3-4B-Instruct-2507"],
    ).toContain(String(TRANSIENT_PULL_RC));
  });

  // Live, not latched at install time: the store reads the setting at the
  // moment it decides, so turning it off during a backoff is obeyed.
  it("is re-read on every decision", async () => {
    retrySettings(true, "unlimited");
    mockPull.mockRejectedValueOnce(rc(TRANSIENT_PULL_RC)).mockImplementationOnce(
      async () => {
        retrySettings(false, "unlimited"); // the user flips it mid-download
        throw rc(TRANSIENT_PULL_RC);
      },
    );

    await settle(install());

    // One retry happened under the old value; the next decision saw the new one.
    expect(mockPull).toHaveBeenCalledTimes(2);
  });
});

// F: every other code goes straight to the user. -100010 is a 404 — asking
// twice cannot publish an asset — and an unsourced code is not evidence of
// transience, so retrying one could spend a user's data on a request that can
// never succeed.
describe("a failure that is not transient", () => {
  it("does not retry a hub 404", async () => {
    mockPull.mockRejectedValue(rc(-100010, "AI Hub model … not found on hub"));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  it("does not retry a code with no verified meaning", async () => {
    mockPull.mockRejectedValue(rc(-100099));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failure that carried no code at all", async () => {
    mockPull.mockRejectedValue(new Error("No usable Qualcomm NPU runtime"));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  it("does not retry the user's own cancel", async () => {
    mockPull.mockRejectedValue(rc(-100006, "Download canceled"));

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(1);
  });
});

describe("cancelling", () => {
  // G: the reason the wait is interruptible rather than a plain sleep.
  it("stops the loop when cancelled during the backoff", async () => {
    retrySettings(true, "unlimited");
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC));

    const running = install();
    // Let the first attempt fail and the wait begin.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await settle(useModelStore.getState().cancelNpuInstall("row1"));

    await settle(running);

    // No second pull, despite an unlimited cap.
    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  // H: an active transfer is still stopped the way it always was.
  it("still cancels an active pull through the runtime", async () => {
    mockPull.mockImplementation(() => new Promise(() => {}));

    install();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await settle(useModelStore.getState().cancelNpuInstall("row1"));

    expect(mockCancelPull).toHaveBeenCalled();
  });
});

// J: the manual button after the automatic attempts have run out. It is an
// ordinary install call, so it gets a fresh cycle — on top of whatever the
// previous attempts left in .inflight, because nothing was deleted.
describe("manual retry after exhaustion", () => {
  it("starts a new cycle and can succeed", async () => {
    retrySettings(true, 1);
    mockPull.mockRejectedValue(rc(TRANSIENT_PULL_RC));

    await settle(install());
    expect(mockPull).toHaveBeenCalledTimes(2);
    expect(mockRemoveBundle).not.toHaveBeenCalled();

    mockPull.mockReset();
    mockPull
      .mockRejectedValueOnce(rc(TRANSIENT_PULL_RC))
      .mockResolvedValueOnce(pulled() as never);

    await settle(install());

    expect(mockPull).toHaveBeenCalledTimes(2);
    expect(useModelStore.getState().npuInstallErrors).toEqual({});
  });
});

// L: nothing in this path is tied to a screen. The install runs in the store,
// the retry loop is a plain await chain inside it, and no component lifecycle
// can reach either — which is what keeps a download alive while the user is in
// another app, as verified on device.
describe("the download does not belong to the UI", () => {
  it("keeps retrying with nothing subscribed to the store", async () => {
    mockPull
      .mockRejectedValueOnce(rc(TRANSIENT_PULL_RC))
      .mockResolvedValueOnce(pulled() as never);

    const running = install();
    // Whatever a screen would have done on unmount, the store is untouched by
    // it: there is no unsubscribe, teardown or lifecycle hook to call.
    await settle(running);

    expect(mockPull).toHaveBeenCalledTimes(2);
    expect(mockCancelPull).not.toHaveBeenCalled();
  });
});
