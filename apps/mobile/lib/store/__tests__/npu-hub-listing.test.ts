// What the production Hub refresh actually asks the SDK for.
//
// `ModelManagerWrapper.listHubModels` in geniex-android 0.4.0 is
// `(chipset: String? = null)` — not a domain, whatever the KDoc says. Read out
// of the released bytecode rather than inferred:
//
//   LocalVariableTable  slot 1  name: chipset  Ljava/lang/String;
//   RuntimeInvisibleParameterAnnotations  parameter 0: @Nullable
//   listHubModels$default(…, String, Continuation, int, Object)
//
// So null is the DECLARED DEFAULT and the SDK's own unfiltered query, and a
// non-empty string must be a key in the runtime's platform.json — anything else
// fails the entire call with `chipset "…" not found in platform.json`, and ""
// fails separately as `empty chipset`.
//
// That is why the refresh asks unfiltered and filters afterwards, in
// TypeScript: 19 models returned on device, 14 compatible here. The device
// question is answered where it can be tested without a Qualcomm phone, and the
// only string Vesta could pass would be a guess at a key it does not hold.

import { useModelStore } from "../model-store";
import { npuHubModels } from "../../native/npu";
import { breakDownHubModels, type HubModel } from "../../models/npu-hub";
import type { RuntimeChipset } from "../../models/chipset-identity";

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
  npuHubModels: jest.fn(),
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

// The device, as the three parties that name it actually name it. SM8850 is
// Android's `Build.SOC_MODEL`; the runtime answers with its own device name and
// declares the two equivalent; AI Hub keys its assets on a third spelling.
const TABLE: RuntimeChipset[] = [
  { name: "Snapdragon 8 Elite Gen 5 QRD", aliases: ["SM8850", "qualcomm-snapdragon-8-elite-gen5"] },
  { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750", "qualcomm-snapdragon-8-elite"] },
];

const HERE = "qualcomm-snapdragon-8-elite-gen5";
const ELSEWHERE = "qualcomm-snapdragon-8-elite";

const catalogue: HubModel[] = [
  { name: "qualcomm/Qwen3-4B-Instruct-2507", modelType: "LLM", chipsets: [HERE] },
  { name: "qualcomm/Llama-v3.2-3B", modelType: "LLM", chipsets: [HERE, ELSEWHERE] },
  { name: "qualcomm/Older-LLM", modelType: "LLM", chipsets: [ELSEWHERE] },
  { name: "qualcomm/Some-VLM", modelType: "VLM", chipsets: [HERE] },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockHubModels.mockResolvedValue({ models: catalogue });
  useModelStore.setState({
    npuHub: { snapshot: null, error: null, checking: false },
  });
});

describe("the production Hub refresh", () => {
  // A: the call the released SDK actually supports.
  it("asks for the catalogue with no chipset at all", async () => {
    await useModelStore.getState().loadNpuHub(true);

    expect(mockHubModels).toHaveBeenCalledTimes(1);
    const [chipset] = mockHubModels.mock.calls[0] ?? [];
    // Either spelling of "I am not filtering" is the SDK's default. What must
    // never appear is a string.
    expect(chipset ?? null).toBeNull();
  });

  // C: the two inputs the runtime rejects outright.
  it("never passes the empty string, and never the word null", async () => {
    await useModelStore.getState().loadNpuHub(true);

    for (const call of mockHubModels.mock.calls) {
      expect(call[0]).not.toBe("");
      expect(call[0]).not.toBe("null");
    }
  });

  it("keeps every row the hub returned, unfiltered, in the snapshot", async () => {
    // The snapshot is the catalogue. Narrowing it here would throw away the
    // evidence the "offered for other silicon" count is built from.
    await useModelStore.getState().loadNpuHub(true);
    expect(useModelStore.getState().npuHub.snapshot?.models).toHaveLength(4);
  });

  it("does not turn a failed listing into an empty catalogue", async () => {
    mockHubModels.mockResolvedValue({ error: "hub unreachable" });
    await useModelStore.getState().loadNpuHub(true);

    const state = useModelStore.getState().npuHub;
    expect(state.error).toContain("hub unreachable");
    expect(state.snapshot).toBeNull();
  });
});

// D and F: the device question, answered where it is testable. This is the step
// that turns the unfiltered listing into "14 compatible here", and it is the
// only place a chipset spelling is matched.
describe("filtering the catalogue against this device", () => {
  it("resolves the SoC id through the runtime's own alias table", async () => {
    const breakdown = breakDownHubModels(catalogue, "SM8850", TABLE);

    expect(breakdown.compatible.map((c) => c.entry.name)).toEqual([
      "qualcomm/Qwen3-4B-Instruct-2507",
      "qualcomm/Llama-v3.2-3B",
    ]);
    expect(breakdown.otherChipsets).toBe(1);
    expect(breakdown.unsupportedType).toBe(1);
  });

  it("keeps the hub's asset key and the SoC id apart", async () => {
    // Different vocabularies on different beans. The asset key is metadata; the
    // canonical SoC is what a pull and the load-time guard take.
    const [first] = breakDownHubModels(catalogue, "SM8850", TABLE).compatible;
    expect(first.hubChipsetKey).toBe(HERE);
    expect(first.canonicalSoc).toBe("SM8850");
  });

  it("offers nothing when the runtime table has never heard of this chip", async () => {
    // Fail closed: a runtime that cannot place the silicon cannot be trusted to
    // reject a bundle built for different silicon either.
    expect(breakDownHubModels(catalogue, "SM7999", TABLE).compatible).toEqual([]);
  });
});
