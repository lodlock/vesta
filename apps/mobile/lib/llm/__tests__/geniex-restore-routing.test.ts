// Restoring the active model after an app restart, and which runtime gets it.
//
// The bug this pins, as reported from a real device: a Q4_0 GGUF imported into
// the GenieX model manager, previously activated and run on the Hexagon lane,
// came back after a restart answering from the CPU at ~10 tok/s. Diagnostics
// said the GenieX lane was "available" and the llama.cpp one "loaded", both
// naming the same imported model path — which is the fingerprint of the fault:
// nothing failed, the wrong runtime simply took the file.
//
// The cause was that routing asked a CAPABILITY question. `supports()` on the
// GenieX lane is false until the runtime probe has completed, `loadModel()`
// read that false as "not my model", and llama.rn — which can load any GGUF,
// including one sitting in GenieX's own directory — took it. On a cold start
// the probe has not run yet, so this was not a race that sometimes lost.
//
// So what is pinned here is that the ROW decides. `backend` is written at
// import and does not change between boots, and a row that names a runtime
// either loads on it or fails saying why. The failure case matters as much as
// the success case: a GenieX model that cannot reach its runtime must not
// become a quiet CPU session wearing an accelerated model's name.

const mockInitLlama = jest.fn(async () => mockLlamaContext);
const mockLlamaContext = {
  completion: jest.fn(async () => ({
    text: "Tallahassee.",
    content: "Tallahassee.",
    tokens_predicted: 3,
    tokens_evaluated: 40,
    timings: { prompt_ms: 90, predicted_ms: 300, predicted_per_second: 10.1, cache_n: 0 },
    stopped_limit: 0,
  })),
  release: jest.fn(async () => {}),
  stopCompletion: jest.fn(async () => {}),
};

jest.mock("llama.rn", () => ({
  initLlama: (...args: unknown[]) => mockInitLlama(...(args as [])),
  loadLlamaModelInfo: jest.fn(),
}));

// The probe's answer, flipped per test. `available: false` is the cold-start
// state: the bridge is compiled in, nothing has probed it yet. Named with the
// `mock` prefix because a jest.mock factory may reference nothing else.
const mockRuntime = { available: true, reason: null as string | null };

const mockNpuLoad = jest.fn(async () => ({
  version: "0.4.0",
  computeUnit: "npu",
  runtimeId: "qairt",
  soc: "SM8850",
  manifestRuntimeId: "qairt",
}));
const mockNpuLoadLlamaCpp = jest.fn(async (config?: { computeUnit?: string }) => ({
  version: "0.4.0",
  computeUnit: config?.computeUnit ?? "hybrid",
  runtimeId: "llama_cpp",
  soc: "SM8850",
  manifestRuntimeId: "llama_cpp",
  contextSize: 4096,
  deviceSelection: { sawHtpDevice: true, scopedToThisLoad: true },
}));
const mockNpuUnload = jest.fn(async () => {});

jest.mock("../../native/npu", () => ({
  isNpuBuild: jest.fn(() => true),
  isNpuRuntimeAvailable: jest.fn(() => mockRuntime.available),
  npuUnavailableReason: jest.fn(() => mockRuntime.reason),
  npuRuntimeInfo: jest.fn(() => ({ version: "0.4.0", computeUnit: "npu", soc: "SM8850" })),
  npuLoad: (...args: unknown[]) => mockNpuLoad(...(args as [])),
  npuLoadLlamaCpp: (...args: unknown[]) =>
    mockNpuLoadLlamaCpp(...(args as [{ computeUnit?: string }])),
  npuGenerate: jest.fn(async () => ({
    text: "Tallahassee.",
    generatedTokens: 3,
    promptTokens: 40,
    decodeSpeed: 31.4,
    prefillSpeed: 520,
    ttftMs: 180,
    stopReason: "eos",
  })),
  npuUnload: () => mockNpuUnload(),
  npuCancel: jest.fn(),
  onNpuToken: jest.fn(() => () => {}),
  DEFAULT_GENIEX_COMPUTE_UNIT: "hybrid",
}));

import {
  loadModel,
  unloadModel,
  loadedBackendId,
  sessionMatches,
} from "../llm-engine";
import {
  backendDiagnostics,
  backendModelRef,
  setDeviceSoc,
  genieXLlamaCpp,
} from "../backends/registry";
import { routeModel } from "../backends/routing";

// The rows as the registry stores them, restored verbatim by the startup path.
// Nothing here is inferred from a file name — that is the point.
const GENIEX_PATH = "file:///data/geniex/models/local/qwen3-q4-0/model-q4_0.gguf";

const genieXRow = () =>
  backendModelRef({
    filePath: GENIEX_PATH,
    artifact: "gguf",
    backend: "geniex_llama_cpp",
    contextSize: 4096,
    displayName: "Qwen3-4B-Instruct-2507-fraQtl-HiFi-Q4_0",
    quant: "Q4_0",
    runtimeModelName: "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
  });

const ordinaryGgufRow = () =>
  backendModelRef({
    filePath: "file:///docs/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    artifact: "gguf",
    backend: "llama_cpp",
    contextSize: 4096,
    displayName: "Qwen3 4B Instruct (2507)",
    quant: "Q4_K_M",
  });

const qairtRow = () =>
  backendModelRef({
    filePath: "/files/geniex/models/qwen3/model",
    artifact: "qairt_context",
    backend: "qualcomm_npu",
    contextSize: 4096,
    displayName: "Qwen3 4B Instruct (2507) (NPU)",
    targetSoc: "SM8850",
    quant: "w4a16",
    runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    tokenizerPath: "/files/geniex/models/qwen3/tokenizer.json",
  });

beforeEach(async () => {
  mockRuntime.available = true;
  mockRuntime.reason = null;
  await unloadModel();
  setDeviceSoc("SM8850");
  genieXLlamaCpp().setComputeUnit("hybrid");
  jest.clearAllMocks();
});

describe("a GenieX-imported GGUF is restored through geniex_llama_cpp", () => {
  it("loads on the GenieX lane, not on llama.rn", async () => {
    await loadModel(GENIEX_PATH, { backendModel: genieXRow(), contextSize: 4096 });

    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(1);
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(loadedBackendId()).toBe("geniex_llama_cpp");
  });

  it("asks the runtime for it by name, as the manager owns the file", async () => {
    await loadModel(GENIEX_PATH, { backendModel: genieXRow() });
    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "local/qwen3-4b-instruct-2507-fraqtl-hifi-q4_0",
      }),
    );
  });

  it("uses the compute unit the backend is configured with, not the default", async () => {
    // The restored selection. It reaches the backend from the config row before
    // the load — see npu-ready.restoreComputeUnit — and this is the half that
    // proves a restored session is built with it rather than with `hybrid`.
    genieXLlamaCpp().setComputeUnit("npu");
    await loadModel(GENIEX_PATH, { backendModel: genieXRow() });

    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledWith(
      expect.objectContaining({ computeUnit: "npu" }),
    );
    expect(genieXLlamaCpp().getLoadedComputeUnit()).toBe("npu");
  });

  it("is routed by the row even while the lane still reports itself unavailable", async () => {
    // The cold-start state exactly: the bridge is in the build, the probe has
    // not answered, so supports() is false. Before the fix this fell through to
    // llama.rn and produced a CPU session. It must now be a routing decision
    // that stands, and therefore an explicit failure rather than a substitution.
    mockRuntime.available = false;

    expect(genieXLlamaCpp().supports(genieXRow())).toBe(false);
    expect(routeModel(genieXRow())).toEqual({
      lane: "geniex_llama_cpp",
      declared: true,
    });
  });
});

describe("an ordinary GGUF is restored through llama.cpp", () => {
  it("goes to llama.rn even on a device whose GenieX runtime is up", async () => {
    await loadModel(ordinaryGgufRow().filePath, { backendModel: ordinaryGgufRow() });

    expect(mockInitLlama).toHaveBeenCalledTimes(1);
    expect(mockNpuLoadLlamaCpp).not.toHaveBeenCalled();
    expect(loadedBackendId()).toBe("llama_cpp");
  });

  it("is unaffected by a row written before the backend column existed", async () => {
    // `backend: undefined` — a pre-v5 row. It keeps the old artifact-and-
    // capability order, which for a portable GGUF is llama.cpp.
    const legacy = backendModelRef({
      filePath: "file:///docs/models/legacy.gguf",
      artifact: "gguf",
      contextSize: 4096,
      displayName: "Legacy",
    });
    expect(routeModel(legacy)).toEqual({ lane: "llama_cpp", declared: false });
  });
});

describe("a QAIRT bundle is restored as before", () => {
  it("goes to the Qualcomm NPU backend", async () => {
    await loadModel(qairtRow().filePath, { backendModel: qairtRow() });

    expect(mockNpuLoad).toHaveBeenCalledTimes(1);
    expect(mockNpuLoadLlamaCpp).not.toHaveBeenCalled();
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(loadedBackendId()).toBe("qualcomm_npu");
  });

  it("still routes on the artifact when the row declares no backend", async () => {
    const undeclared = backendModelRef({
      filePath: "/files/geniex/models/qwen3/model",
      artifact: "qairt_context",
      contextSize: 4096,
      displayName: "Qwen3 (NPU)",
      targetSoc: "SM8850",
      runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    });
    expect(routeModel(undeclared)).toEqual({
      lane: "qualcomm_npu",
      declared: false,
    });
  });
});

describe("a GenieX model that cannot reach its runtime fails, loudly", () => {
  it("does not load the same GGUF on the CPU instead", async () => {
    mockRuntime.available = false;
    mockRuntime.reason = "libGenieX.so failed to load";

    await expect(
      loadModel(GENIEX_PATH, { backendModel: genieXRow() }),
    ).rejects.toThrow(/libGenieX\.so failed to load/);

    // The whole point. A refusal here used to be answered by llama.rn.
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(loadedBackendId()).toBeNull();
  });

  it("names the model and the runtime it belongs to", async () => {
    mockRuntime.available = false;
    await expect(
      loadModel(GENIEX_PATH, { backendModel: genieXRow() }),
    ).rejects.toThrow(/Qwen3-4B-Instruct-2507-fraQtl-HiFi-Q4_0[\s\S]*GenieX/);
  });

  it("propagates a failure from the runtime itself without falling back", async () => {
    mockNpuLoadLlamaCpp.mockRejectedValueOnce(new Error("no valid devices found"));
    await expect(
      loadModel(GENIEX_PATH, { backendModel: genieXRow() }),
    ).rejects.toThrow("no valid devices found");
    expect(mockInitLlama).not.toHaveBeenCalled();
  });
});

describe("the live session's runtime identity is reported, not assumed", () => {
  it("reports nothing loaded before a load", () => {
    expect(loadedBackendId()).toBeNull();
  });

  it("names the runtime that actually holds the session", async () => {
    await loadModel(ordinaryGgufRow().filePath, { backendModel: ordinaryGgufRow() });
    expect(loadedBackendId()).toBe("llama_cpp");

    await loadModel(GENIEX_PATH, { backendModel: genieXRow() });
    expect(loadedBackendId()).toBe("geniex_llama_cpp");
  });

  it("does not report llama.cpp as loaded while the GenieX lane owns the session", async () => {
    // Shared low-level state, not a second session: llm-engine keeps one
    // LlamaContext and one current path, and `LlamaCppBackend.getDiagnostics()`
    // read the engine-wide `isLoaded()` and path. So a report of a working
    // Hexagon session showed BOTH backends loaded, with one model between them
    // — which is indistinguishable from the mis-restore it was hiding.
    await loadModel(GENIEX_PATH, { backendModel: genieXRow() });

    const byId = Object.fromEntries(
      backendDiagnostics().map((b) => [b.id, b]),
    );
    expect(byId.geniex_llama_cpp.loaded).toBe(true);
    expect(byId["llama.cpp"].loaded).toBe(false);
    // And it does not name a file it does not have open.
    expect(byId["llama.cpp"].details.modelPath).toBe("");
  });

  it("does report llama.cpp as loaded when llama.cpp is what is loaded", async () => {
    await loadModel(ordinaryGgufRow().filePath, { backendModel: ordinaryGgufRow() });

    const byId = Object.fromEntries(
      backendDiagnostics().map((b) => [b.id, b]),
    );
    expect(byId["llama.cpp"].loaded).toBe(true);
    expect(byId.geniex_llama_cpp.loaded).toBe(false);
  });

  it("does not call a CPU session a match for a GenieX model on the same path", async () => {
    // Re-activating from the Models screen is what corrects a bad restore, and
    // it short-circuits on sessionMatches(). Comparing paths alone made that
    // short-circuit fire — the two lanes address the same bytes — so the one
    // action that could fix the state did nothing.
    await loadModel(GENIEX_PATH, {
      backendModel: backendModelRef({
        filePath: GENIEX_PATH,
        artifact: "gguf",
        backend: "llama_cpp",
        contextSize: 4096,
        displayName: "same file, ordinary row",
      }),
    });
    expect(loadedBackendId()).toBe("llama_cpp");
    expect(sessionMatches(genieXRow())).toBe(false);
  });
});
