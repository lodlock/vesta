// What the startup restore has to do BEFORE it loads the active model.
//
// The other half of the restore bug. Routing now reads the row's declared
// runtime (see llm/__tests__/geniex-restore-routing.test.ts), but a GenieX
// model still only LOADS if its runtime has been probed by then — and the
// restore decided whether to await that probe with `artifact !== "gguf"`.
//
// A GenieX llama.cpp model's artifact is `gguf`, correctly and deliberately:
// it is a GGUF. So the one model on the device that needed the probe was the
// one model the test excluded, and every cold start reached the load with the
// runtime still reporting itself unavailable.
//
// The question the restore has to ask is about the row's RUNTIME, not its file
// format. These pin that, and pin the other thing the restore must carry: the
// row's `backend` has to reach the engine, or the ref it builds describes a
// portable GGUF and nothing downstream can tell the difference.

import { useChatStore } from "../chat-store";
import { loadModel, isLoaded, getModelInfo } from "../../llm/llm-engine";
import { getActiveModel } from "../../models/model-registry";
import { prepareNpuBackend } from "../../models/npu-ready";
import type { InstalledModel } from "../../models/types";

jest.mock("uuid", () => ({ v4: () => "test-uuid" }));
jest.mock("../../llm/llm-engine", () => ({
  loadModel: jest.fn(async () => {}),
  isLoaded: jest.fn(() => false),
  getModelInfo: jest.fn(() => ({ loaded: false })),
  stopGeneration: jest.fn(async () => {}),
}));
jest.mock("../../models/model-registry", () => ({
  ensureLegacyMigration: jest.fn(async () => {}),
  getActiveModel: jest.fn(async () => null),
  setModelState: jest.fn(async () => {}),
}));
jest.mock("../../models/npu-ready", () => ({
  prepareNpuBackend: jest.fn(async () => ({})),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 10 })),
}));
jest.mock("../../orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  executeToolCall: jest.fn(),
}));
jest.mock("../../orchestrator/memory-manager", () => ({ runMemoryDecay: jest.fn() }));
jest.mock("../../orchestrator/session-warmer", () => ({ warmSessionCache: jest.fn() }));
jest.mock("../../llm/session-cache", () => ({ clearPrefixSessionCache: jest.fn() }));
jest.mock("../../llm/perf-config", () => ({
  getPerfSettings: jest.fn(async () => ({})),
  perfToLlmOptions: jest.fn(() => ({})),
}));
jest.mock("../../native/vesta-service", () => ({ startVestaService: jest.fn(async () => {}) }));
jest.mock("../../storage/database", () => ({
  saveMessage: jest.fn(async () => {}),
  getMessages: jest.fn(async () => []),
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
  createConversation: jest.fn(async () => {}),
  getLatestConversation: jest.fn(async () => null),
  updateConversationTitle: jest.fn(async () => {}),
  touchConversation: jest.fn(async () => {}),
  deleteConversation: jest.fn(async () => {}),
  updateMessageToolResult: jest.fn(async () => {}),
}));

const mockLoad = loadModel as jest.MockedFunction<typeof loadModel>;
const mockIsLoaded = isLoaded as jest.MockedFunction<typeof isLoaded>;
const mockInfo = getModelInfo as jest.MockedFunction<typeof getModelInfo>;
const mockActive = getActiveModel as jest.MockedFunction<typeof getActiveModel>;
const mockPrepare = prepareNpuBackend as jest.MockedFunction<typeof prepareNpuBackend>;

// Who called what, in order. The ordering IS the contract: a probe that
// finishes after the load is worth nothing, which is how the bug got in.
let calls: string[] = [];

const row = (over: Partial<InstalledModel>): InstalledModel =>
  ({
    id: "m1",
    displayName: "model",
    filePath: "file:///docs/models/model.gguf",
    contextSize: 4096,
    chatTemplate: null,
    artifact: "gguf",
    backend: "llama_cpp",
    quant: null,
    targetSoc: null,
    runtimeVersion: null,
    runtimeModelName: null,
    tokenizerPath: null,
    ...over,
  }) as InstalledModel;

const genieXRow = () =>
  row({
    displayName: "Qwen3-4B-Instruct-2507-fraQtl-HiFi-Q4_0",
    filePath: "file:///data/geniex/models/local/qwen3-q4-0/model-q4_0.gguf",
    // A GGUF, and owned by the GenieX model manager. Both facts at once is
    // exactly the combination the artifact test could not see.
    artifact: "gguf",
    backend: "geniex_llama_cpp",
    quant: "Q4_0",
    runtimeModelName: "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
  });

const qairtRow = () =>
  row({
    displayName: "Qwen3 4B Instruct (2507) (NPU)",
    filePath: "/files/geniex/models/qwen3/model",
    artifact: "qairt_context",
    backend: "qualcomm_npu",
    targetSoc: "SM8850",
    runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
  });

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  useChatStore.setState({ modelLoaded: false, modelPath: null, notice: null });
  mockIsLoaded.mockReturnValue(false);
  mockInfo.mockReturnValue({ loaded: false });
  mockActive.mockResolvedValue(null);
  mockPrepare.mockImplementation(async () => {
    // A real probe crosses the bridge, so it is never synchronous. The await is
    // the whole question.
    await Promise.resolve();
    calls.push("prepare");
    return {} as never;
  });
  mockLoad.mockImplementation(async () => {
    calls.push("load");
  });
});

describe("a GenieX-managed GGUF", () => {
  it("has the Qualcomm runtime probed before it is loaded, not after", async () => {
    mockActive.mockResolvedValue(genieXRow());

    await useChatStore.getState().ensureModelLoaded();

    expect(calls).toEqual(["prepare", "load"]);
  });

  it("reaches the engine carrying the runtime its row declares", async () => {
    mockActive.mockResolvedValue(genieXRow());

    await useChatStore.getState().ensureModelLoaded();

    expect(mockLoad).toHaveBeenCalledWith(
      "file:///data/geniex/models/local/qwen3-q4-0/model-q4_0.gguf",
      expect.objectContaining({
        backendModel: expect.objectContaining({
          backend: "geniex_llama_cpp",
          artifact: "gguf",
          runtimeModelName: "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
        }),
      }),
    );
  });
});

describe("a QAIRT bundle is prepared as it always was", () => {
  it("probes before loading", async () => {
    mockActive.mockResolvedValue(qairtRow());

    await useChatStore.getState().ensureModelLoaded();

    expect(calls).toEqual(["prepare", "load"]);
    expect(mockLoad).toHaveBeenCalledWith(
      "/files/geniex/models/qwen3/model",
      expect.objectContaining({
        backendModel: expect.objectContaining({ backend: "qualcomm_npu" }),
      }),
    );
  });
});

describe("an ordinary GGUF pays for nothing it does not need", () => {
  it("loads without waiting on a Qualcomm probe", async () => {
    mockActive.mockResolvedValue(row({}));

    await useChatStore.getState().ensureModelLoaded();

    expect(calls).toEqual(["load"]);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("still tells the engine which runtime the row is for", async () => {
    mockActive.mockResolvedValue(row({}));

    await useChatStore.getState().ensureModelLoaded();

    expect(mockLoad).toHaveBeenCalledWith(
      "file:///docs/models/model.gguf",
      expect.objectContaining({
        backendModel: expect.objectContaining({ backend: "llama_cpp" }),
      }),
    );
  });
});

describe("a restore that fails says so", () => {
  it("does not leave the chat claiming there is no model", async () => {
    // The explicit-failure half: a GenieX row whose runtime refuses now throws
    // out of the engine rather than landing on llama.rn, so the restore has to
    // surface it. A silent CPU load produced no notice at all — which is how
    // the original report read as a performance problem.
    mockActive.mockResolvedValue(genieXRow());
    mockLoad.mockRejectedValue(new Error("libGenieX.so failed to load"));

    await useChatStore.getState().ensureModelLoaded();

    expect(useChatStore.getState().notice).toBeTruthy();
    expect(useChatStore.getState().modelLoaded).toBe(false);
  });
});
