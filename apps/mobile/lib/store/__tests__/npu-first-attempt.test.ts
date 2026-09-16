// The first pull must be the OLD pull.
//
// Every Qualcomm Hub model began failing immediately with `rc=-100000` after
// 6317a3e added automatic retry, and the natural suspicion is the wrapper —
// even though no native code changed in that commit. So this pins the thing
// that suspicion is about: before any retry can occur, `pullWithRetry` must
// issue exactly what `await npuPull({...})` used to issue, once, with nothing
// of its own in front of it.
//
// What "exactly" means here is the serialised request, not the object the store
// wrote: `npuPullRequest` derives `display_name` and drops null keys, and an
// absent key, an empty string and the four-character word "null" are three
// different things to the native side — that distinction has already cost this
// path two separate bugs.
//
// These cases cannot tell us what -100000 means. They can rule the wrapper out,
// which is worth doing first and cheaply.

import { useModelStore } from "../model-store";
import { npuPull, npuPullRequest, npuCancelPull } from "../../native/npu";
import { getConfig } from "../../storage/database";
import { getPullTrace, resetPullTrace } from "../../models/npu-pull-trace";
import type { CompatibleHubModel } from "../../models/npu-hub";
import type { NpuCatalogModel } from "../../models/npu-catalog";

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
  npuResolveAlias: jest.fn(async () => null),
  npuHubModels: jest.fn(async () => ({ models: [] })),
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
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const HUB_ROW: CompatibleHubModel = {
  entry: {
    name: "qualcomm/Falcon3-7B-Instruct",
    modelType: "LLM",
    chipsets: ["qualcomm-snapdragon-8-elite-gen5"],
  },
  hubChipsetKey: "qualcomm-snapdragon-8-elite-gen5",
  canonicalSoc: "SM8850",
};

/**
 * The call the OLD code made, written out by hand from the pre-6317a3e source:
 *
 *   const bundle = await npuPull({
 *     modelName: spec.modelName,
 *     chipset: spec.chipset,
 *     precision: spec.precision,
 *     hub: spec.hub,
 *     displayName: spec.displayName,
 *   });
 *
 * For this hub row that is these five values, and `installHubModel` is where
 * each one comes from.
 */
const OLD_DIRECT_REQUEST = {
  modelName: "qualcomm/Falcon3-7B-Instruct",
  chipset: "SM8850",
  precision: null,
  hub: "AIHUB" as const,
  displayName: "Falcon3 7B Instruct",
};

const install = () => useModelStore.getState().installHubModel(HUB_ROW);

beforeEach(() => {
  jest.clearAllMocks();
  resetPullTrace();
  mockConfig.mockResolvedValue(null); // auto-retry on, cap 3 — the defaults
  useModelStore.setState({
    error: null,
    busy: false,
    installed: [],
    npuInstallErrors: {},
    progress: {},
    npu: { inBuild: true, available: true, soc: "SM8850" } as never,
  });
});

describe("the first attempt is the old direct call", () => {
  it("issues exactly one pull for a success", async () => {
    mockPull.mockResolvedValue({
      modelName: "qualcomm/Falcon3-7B-Instruct",
      modelPath: "/data/geniex/models/falcon3",
      modelDir: "/data/geniex/models/falcon3",
      tokenizerPath: "/data/geniex/models/falcon3/tokenizer.json",
      runtimeId: "qairt",
      files: [
        { path: "metadata.json", sizeBytes: 4096 },
        { path: "tokenizer.json", sizeBytes: 2_500_000 },
        { path: "tokenizer_config.json", sizeBytes: 8192 },
        { path: "weights_1.bin", sizeBytes: 1_200_000_000 },
      ],
      totalBytes: 1_202_512_288,
    } as never);

    await install();

    expect(mockPull).toHaveBeenCalledTimes(1);
  });

  // The object the store hands to npuPull, field for field.
  it("passes the same five fields the old code passed", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    expect(mockPull.mock.calls[0][0]).toEqual(OLD_DIRECT_REQUEST);
  });

  // And the bytes that actually cross the bridge, which is what the runtime
  // parses. `npuPullRequest` derives display_name and drops null keys, so this
  // is the comparison that matters.
  it("serialises to exactly what the old path serialised", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    expect(JSON.stringify(npuPullRequest(mockPull.mock.calls[0][0]))).toBe(
      JSON.stringify(npuPullRequest(OLD_DIRECT_REQUEST)),
    );
  });

  // The three fields the native side reads as "absent means something": a
  // dropped precision means "let GenieX pick", and neither an empty string nor
  // the word "null" means that.
  it("sends no precision key rather than a null or the word null", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    const wire = JSON.parse(JSON.stringify(npuPullRequest(mockPull.mock.calls[0][0])));
    expect("precision" in wire).toBe(false);
    expect(wire).not.toHaveProperty("localPath");
    expect(JSON.stringify(wire)).not.toContain("null");
    expect(wire.chipset).toBe("SM8850");
    expect(wire.modelName).toBe("qualcomm/Falcon3-7B-Instruct");
    // Derived from the identifier, not the card title — the hub's own spelling.
    expect(wire.displayName).toBe("Falcon3-7B-Instruct");
  });

  // Nothing of the wrapper's runs before the first call.
  it("reads no setting before the first attempt", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    // The settings read happens in the catch, so by the time it fires the pull
    // has already been issued. Order, not count, is the claim.
    const pullOrder = mockPull.mock.invocationCallOrder[0];
    const configOrder = mockConfig.mock.invocationCallOrder.filter(
      (_, i) => mockConfig.mock.calls[i][0] === "download_retry",
    )[0];
    if (configOrder !== undefined) expect(pullOrder).toBeLessThan(configOrder);
  });

  it("issues the first attempt with a clear abort signal", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    const [first] = getPullTrace();
    expect(first.attempt).toBe(1);
    expect(first.aborted).toBe(false);
  });

  // A previous install's cancellation must not reach this one. Each install
  // gets its own controller, and the registry is keyed by row id.
  it("does not inherit cancellation from an earlier install", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));
    await install();
    await useModelStore.getState().cancelNpuInstall("row1");

    mockPull.mockClear();
    resetPullTrace();
    await install();

    expect(mockPull).toHaveBeenCalledTimes(1);
    expect(getPullTrace()[0].aborted).toBe(false);
  });

  // -100000 is not in the transient list and must not be retried, whatever the
  // setting says. One attempt, one error, unchanged.
  it("does not retry rc=-100000", async () => {
    mockPull.mockRejectedValue(
      new Error("rc=-100000: geniex_model_pull failed (rc=-100000)"),
    );

    await install();

    expect(mockPull).toHaveBeenCalledTimes(1);
    expect(mockCancelPull).not.toHaveBeenCalled();
    expect(
      useModelStore.getState().npuInstallErrors["qualcomm/Falcon3-7B-Instruct"],
    ).toContain("-100000");
  });
});

// The fact that splits the problem in half. Neither side was recording it.
describe("whether any byte moved before the failure", () => {
  it("records zero progress events as a setup failure", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));

    await install();

    const [first] = getPullTrace();
    expect(first.outcome?.ok).toBe(false);
    expect(first.outcome?.progressEvents).toBe(0);
    expect(first.outcome?.error).toContain("-100000");
  });

  it("keeps the runtime's own text verbatim", async () => {
    mockPull.mockRejectedValue(
      new Error("rc=-100000: something the runtime said"),
    );

    await install();

    expect(getPullTrace()[0].outcome?.error).toBe(
      "rc=-100000: something the runtime said",
    );
  });
});

// The curated card and a hub row build their request differently — different
// chipset derivation, different precision, different displayName source — and
// only hub rows are failing. Pinned so the difference is visible rather than
// inferred.
describe("curated card versus hub row", () => {
  const CURATED = {
    id: "qwen3-4b-npu",
    modelName: "qualcomm/Qwen3-4B-Instruct-2507",
    displayName: "Qwen3 4B Instruct 2507",
    hub: "AIHUB",
    precision: "w4a16",
    targetSoc: "SM8850",
    socName: "Snapdragon 8 Elite Gen 5",
    minRamMb: 8192,
    runtimeVersion: null,
    role: "primary",
    artifact: "qairt_context",
    sizeBytesApprox: 2_400_000_000,
    license: "Apache-2.0",
    description: "",
  } as unknown as NpuCatalogModel;

  it("sends the catalog's own precision, and the same chipset spelling", async () => {
    mockPull.mockRejectedValue(new Error("rc=-100000: geniex_model_pull failed"));
    // A live hub answer that lists it, so the "listed" branch runs — the same
    // branch a hub row takes, through the same canonicalChipset() call.
    useModelStore.setState({
      npuHub: {
        snapshot: {
          models: [
            {
              name: "qualcomm/Qwen3-4B-Instruct-2507",
              modelType: "LLM",
              chipsets: ["qualcomm-snapdragon-8-elite-gen5"],
            },
          ],
          checkedAt: Date.now(),
          cached: false,
        },
        error: null,
        checking: false,
      },
      npu: {
        inBuild: true,
        available: true,
        soc: "SM8850",
        canonicalSoc: "SM8850",
        chipsets: [
          {
            name: "Snapdragon 8 Elite Gen 5 QRD",
            aliases: ["SM8850", "qualcomm-snapdragon-8-elite-gen5"],
          },
        ],
      } as never,
    });

    await useModelStore.getState().installNpuModel(CURATED);

    const wire = JSON.parse(JSON.stringify(npuPullRequest(mockPull.mock.calls[0][0])));
    // Both paths resolve the chipset through the runtime's own table, and both
    // land on the SoC id rather than AI Hub's asset key. Only the precision
    // differs: the catalog carries one, a HubModel does not.
    expect(wire.chipset).toBe("SM8850");
    expect(wire.precision).toBe("w4a16");
  });
});
