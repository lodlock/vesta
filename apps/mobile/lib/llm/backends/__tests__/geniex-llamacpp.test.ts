// The GenieX llama.cpp lane: what it claims, what it refuses, and the two
// things it must never do.
//
// A GGUF is a GGUF, so this backend and the CPU one look at the same file
// format. What separates them is OWNERSHIP — a `runtimeModelName` means the
// GenieX model manager resolved the path and will be asked for it by name —
// and getting that wrong costs one of two ways round: claim too much and every
// portable GGUF stops reaching the runtime that can always run it; claim too
// little and the lane is dead code.
//
// The second property is the one the whole three-lane split exists for: a
// failed GenieX load must THROW. Quietly re-loading the same file on llama.rn
// would produce a CPU run wearing this backend's label.

const mockLoadLlamaCpp = jest.fn(async () => ({
  version: "0.4.0",
  computeUnit: "hybrid",
  runtimeId: "llama_cpp",
  soc: "SM8850",
  manifestRuntimeId: "llama_cpp",
  contextSize: 4096,
  deviceSelection: {
    lines: ["ggml-hex: HTP0 allocating new session"],
    sawHtpDevice: true,
    sawHexagonBackend: true,
    sawNoValidDevices: false,
    scopedToThisLoad: true,
  },
}));
const mockUnload = jest.fn(async () => {});
const mockGenerate = jest.fn(async () => ({
  text: "Providence.",
  generatedTokens: 3,
  promptTokens: 42,
  decodeSpeed: 21.5,
  prefillSpeed: 410,
  ttftMs: 260,
  stopReason: "eos",
}));
let mockRuntimeAvailable = true;

jest.mock("../../../native/npu", () => ({
  isNpuBuild: jest.fn(() => true),
  isNpuRuntimeAvailable: jest.fn(() => mockRuntimeAvailable),
  npuUnavailableReason: jest.fn(() => "The runtime did not start."),
  npuLoadLlamaCpp: (...args: unknown[]) => mockLoadLlamaCpp(...(args as [])),
  npuGenerate: (...args: unknown[]) => mockGenerate(...(args as [])),
  npuUnload: () => mockUnload(),
  npuCancel: jest.fn(),
  onNpuToken: jest.fn(() => () => {}),
  DEFAULT_GENIEX_COMPUTE_UNIT: "hybrid",
}));

import { GenieXLlamaCppBackend } from "../geniex-llamacpp-backend";
import { backendModelRef } from "../registry";
import { getLastRun, clearLastRun } from "../../run-record";

/** A GGUF the GenieX model manager owns — the only thing this lane claims. */
const owned = (over: Partial<Parameters<typeof backendModelRef>[0]> = {}) =>
  backendModelRef({
    filePath: "/files/geniex/models/local/gemma/gemma-4-E2B-it-q4_0.gguf",
    artifact: "gguf",
    contextSize: 4096,
    displayName: "gemma-4-E2B-it-q4_0",
    quant: "Q4_0",
    runtimeModelName: "local/gemma-4-e2b-it-q4_0",
    ...over,
  });

/** An ordinary GGUF Vesta downloaded itself. Belongs to llama.rn. */
const portable = () =>
  backendModelRef({
    filePath: "file:///docs/models/qwen3-4b.gguf",
    artifact: "gguf",
    contextSize: 4096,
    displayName: "Qwen3 4B",
    quant: "Q4_K_M",
  });

beforeEach(() => {
  mockRuntimeAvailable = true;
  jest.clearAllMocks();
  clearLastRun();
});

describe("what the lane claims", () => {
  it("claims a GGUF the GenieX model manager owns", () => {
    expect(new GenieXLlamaCppBackend().supports(owned())).toBe(true);
  });

  it("does NOT claim a GGUF Vesta downloaded itself", () => {
    const backend = new GenieXLlamaCppBackend();
    expect(backend.supports(portable())).toBe(false);
    // And says why in words a Models screen can show, rather than going quiet.
    expect(backend.refusalFor(portable())).toMatch(/llama\.cpp \(CPU\)/);
  });

  it("does NOT claim a QAIRT context bundle", () => {
    // Same owner, different artifact — that one is the NPU backend's, and a
    // lane that took it would hand a context binary to llama.cpp.
    const bundle = owned({
      artifact: "qairt_context",
      runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    });
    expect(new GenieXLlamaCppBackend().supports(bundle)).toBe(false);
  });

  it("claims nothing when the GenieX runtime did not start", () => {
    mockRuntimeAvailable = false;
    const backend = new GenieXLlamaCppBackend();
    expect(backend.supports(owned())).toBe(false);
    expect(backend.refusalFor(owned())).toBe("The runtime did not start.");
  });
});

describe("the load", () => {
  it("addresses the model by NAME and sends the compute unit explicitly", async () => {
    const backend = new GenieXLlamaCppBackend();
    await backend.load(owned());
    expect(mockLoadLlamaCpp).toHaveBeenCalledWith({
      modelName: "local/gemma-4-e2b-it-q4_0",
      computeUnit: "hybrid",
      contextSize: 4096,
    });
  });

  it("carries an internally selected compute unit through to the runtime", async () => {
    // Test-only, and the reason it exists: `npu` is the alias that makes
    // GenieX log the explicit "Found device: HTP0" sentence.
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());
    expect(mockLoadLlamaCpp).toHaveBeenCalledWith(
      expect.objectContaining({ computeUnit: "npu" }),
    );
  });

  it("refuses a model whose manifest says another runtime, and unloads it", async () => {
    mockLoadLlamaCpp.mockResolvedValueOnce({
      version: "0.4.0",
      computeUnit: "hybrid",
      runtimeId: "llama_cpp",
      soc: "SM8850",
      // What the model manager actually said. It outranks the request.
      manifestRuntimeId: "qairt",
      contextSize: 4096,
      deviceSelection: {},
    } as Awaited<ReturnType<typeof mockLoadLlamaCpp>>);
    const backend = new GenieXLlamaCppBackend();
    await expect(backend.load(owned())).rejects.toThrow(/not a GenieX llama\.cpp/);
    expect(mockUnload).toHaveBeenCalled();
    expect(backend.isLoaded()).toBe(false);
  });

  it("propagates a failed create instead of falling back", async () => {
    mockLoadLlamaCpp.mockRejectedValueOnce(new Error("HTP0 not found"));
    const backend = new GenieXLlamaCppBackend();
    await expect(backend.load(owned())).rejects.toThrow("HTP0 not found");
    expect(backend.isLoaded()).toBe(false);
  });

  it("refuses at load() even when supports() was never consulted", async () => {
    const backend = new GenieXLlamaCppBackend();
    await expect(backend.load(portable())).rejects.toThrow(/llama\.cpp \(CPU\)/);
    expect(mockLoadLlamaCpp).not.toHaveBeenCalled();
  });
});

describe("what it says about the hardware", () => {
  it("never calls a hybrid run NPU, and never attests the compute", async () => {
    const backend = new GenieXLlamaCppBackend();
    await backend.load(owned());
    await backend.generate([{ role: "user", content: "hi" }]);

    const run = getLastRun();
    expect(run?.backend).toBe("geniex_llama_cpp");
    expect(run?.backendLabel).toBe("Qualcomm GenieX / llama.cpp");
    expect(run?.computeLabel).toBe("Hexagon HTP + CPU (hybrid)");
    // The claim this lane is not allowed to make.
    expect(run?.computeLabel).not.toMatch(/\bNPU\b/);
    expect(backend.getDiagnostics().details.computeAttested).toBe(false);
  });

  it("names the pinned mode differently from the hybrid one", async () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());
    await backend.generate([{ role: "user", content: "hi" }]);
    expect(getLastRun()?.computeLabel).toBe("Hexagon HTP (pinned HTP0)");
  });

  it("qualifies the label when GenieX found no device at all", async () => {
    mockLoadLlamaCpp.mockResolvedValueOnce({
      version: "0.4.0",
      computeUnit: "npu",
      runtimeId: "llama_cpp",
      soc: "SM8850",
      manifestRuntimeId: "llama_cpp",
      contextSize: 4096,
      deviceSelection: { sawNoValidDevices: true, scopedToThisLoad: true },
    } as Awaited<ReturnType<typeof mockLoadLlamaCpp>>);
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());
    await backend.generate([{ role: "user", content: "hi" }]);
    // The request is not repeated back as if it were the outcome.
    expect(getLastRun()?.computeLabel).toMatch(/found no valid device/);
  });

  it("surfaces the device evidence and whether it belongs to this load", async () => {
    const backend = new GenieXLlamaCppBackend();
    await backend.load(owned());
    const details = backend.getDiagnostics().details;
    expect(details.sawHtpDevice).toBe(true);
    expect(details.sawHexagonBackend).toBe(true);
    expect(details.deviceEvidenceScoped).toBe(true);
    expect(details.deviceLines).toMatch(/HTP0/);
    expect(details.requestedRuntime).toBe("llama_cpp");
    expect(details.requestedComputeUnit).toBe("hybrid");
  });

  it("reports the runtime's own numbers and nothing invented", async () => {
    const backend = new GenieXLlamaCppBackend();
    await backend.load(owned());
    await backend.generate([{ role: "user", content: "hi" }]);
    const run = getLastRun();
    expect(run?.ttftMs).toBe(260);
    expect(run?.prefillTokensPerSecond).toBe(410);
    expect(run?.decodeTokensPerSecond).toBe(21.5);
    expect(run?.stopReason).toBe("eos");
    expect(run?.artifactLabel).toBe("GGUF Q4_0");
    // The load cost belongs to the first turn only.
    expect(run?.reusedSession).toBe(false);
    await backend.generate([{ role: "user", content: "again" }]);
    expect(getLastRun()?.reusedSession).toBe(true);
    expect(getLastRun()?.coldLoadMs).toBeUndefined();
  });
});
