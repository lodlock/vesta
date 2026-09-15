// `modelLoaded` is a MIRROR, not a source of truth.
//
// The chat screen's "No model yet — tap to download one" banner reads it, and
// it showed while a model was loaded and answering: the flag is only refreshed
// at a few call sites, so it drifts from the engine. The fix is that the chat
// screen re-reads the authority on focus — so what these tests pin is the
// contract that re-read depends on. There is deliberately no second cache to
// test; the engine is asked.

import { useChatStore } from "../chat-store";
import { loadModel, isLoaded, getModelInfo } from "../../llm/llm-engine";
import { getActiveModel } from "../../models/model-registry";
import * as FileSystem from "expo-file-system/legacy";

// uuid ships ESM that jest-expo does not transform; the store only needs an id.
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

const mockIsLoaded = isLoaded as jest.MockedFunction<typeof isLoaded>;
const mockInfo = getModelInfo as jest.MockedFunction<typeof getModelInfo>;
const mockLoad = loadModel as jest.MockedFunction<typeof loadModel>;
const mockActive = getActiveModel as jest.MockedFunction<typeof getActiveModel>;
const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;

const activeModel = {
  id: "m1",
  displayName: "Qwen3 4B Instruct (2507)",
  filePath: "file:///docs/models/qwen3-4b.gguf",
  contextSize: 4096,
  chatTemplate: null,
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  useChatStore.setState({ modelLoaded: false, modelPath: null, notice: null });
  mockIsLoaded.mockReturnValue(false);
  mockInfo.mockReturnValue({ loaded: false });
  mockActive.mockResolvedValue(null);
  mockFS.getInfoAsync.mockResolvedValue({ exists: true, size: 10 } as never);
});

describe("updateModelStatus re-reads the engine", () => {
  it("picks up a model that was loaded behind the store's back", () => {
    // Exactly the reported state: inference works, the flag says otherwise.
    expect(useChatStore.getState().modelLoaded).toBe(false);
    mockInfo.mockReturnValue({ loaded: true, path: "/models/qwen3-4b.gguf" });

    useChatStore.getState().updateModelStatus();

    expect(useChatStore.getState().modelLoaded).toBe(true);
    expect(useChatStore.getState().modelPath).toBe("/models/qwen3-4b.gguf");
  });

  it("also clears the flag when the engine has nothing loaded", () => {
    useChatStore.setState({ modelLoaded: true });
    mockInfo.mockReturnValue({ loaded: false });

    useChatStore.getState().updateModelStatus();

    expect(useChatStore.getState().modelLoaded).toBe(false);
  });
});

describe("ensureModelLoaded", () => {
  it("loads the active model and reflects it — the assistant-only launch case", async () => {
    // init({ loadModel: false }) leaves a selected model unloaded; entering
    // chat must load it rather than claim there is no model.
    mockActive.mockResolvedValue(activeModel);
    mockLoad.mockImplementation(async () => {
      mockIsLoaded.mockReturnValue(true);
      mockInfo.mockReturnValue({ loaded: true, path: "/models/qwen3-4b.gguf" });
    });

    await useChatStore.getState().ensureModelLoaded();

    expect(mockLoad).toHaveBeenCalled();
    expect(useChatStore.getState().modelLoaded).toBe(true);
  });

  it("does not reload a model that is already loaded, but still syncs the flag", async () => {
    // Called on every focus, so it has to be cheap when there is nothing to do.
    mockActive.mockResolvedValue(activeModel);
    mockIsLoaded.mockReturnValue(true);
    mockInfo.mockReturnValue({ loaded: true, path: "/models/qwen3-4b.gguf" });

    await useChatStore.getState().ensureModelLoaded();

    expect(mockLoad).not.toHaveBeenCalled();
    expect(useChatStore.getState().modelLoaded).toBe(true);
  });

  it("is a quiet no-op when no model is installed", async () => {
    mockActive.mockResolvedValue(null);

    await expect(useChatStore.getState().ensureModelLoaded()).resolves.toBeUndefined();

    expect(mockLoad).not.toHaveBeenCalled();
    expect(useChatStore.getState().modelLoaded).toBe(false);
    // Nothing went wrong, so nothing is reported.
    expect(useChatStore.getState().notice).toBeNull();
  });
});
