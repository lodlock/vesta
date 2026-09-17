// Which runtime a model actually reaches — the one place where mislabelling
// becomes possible.
//
// Everything about this feature rests on a single property: a context bundle
// goes to QAIRT and a GGUF goes to llama.cpp, with no path that quietly
// substitutes one for the other. There is no fallback on purpose. If the NPU
// cannot take a bundle the caller hears why, because loading it on the CPU
// instead would make every subsequent "Hexagon HTP / NPU" in the diagnostics a
// lie — and the whole point of recording the backend at the point of execution
// is that such a lie cannot be told.

const mockInitLlama = jest.fn(async () => mockLlamaContext);
const mockLlamaContext = {
  completion: jest.fn(async () => ({
    text: "Providence.",
    content: "Providence.",
    tokens_predicted: 3,
    tokens_evaluated: 42,
    timings: { prompt_ms: 100, predicted_ms: 400, predicted_per_second: 7.5, cache_n: 0 },
    stopped_limit: 0,
  })),
  release: jest.fn(async () => {}),
  stopCompletion: jest.fn(async () => {}),
};

jest.mock("llama.rn", () => ({
  initLlama: (...args: unknown[]) => mockInitLlama(...(args as [])),
  loadLlamaModelInfo: jest.fn(),
}));

const mockNpuLoad = jest.fn(async () => ({
  version: "0.4.0",
  computeUnit: "npu",
  runtimeId: "qairt",
  soc: "SM8850",
  manifestRuntimeId: "qairt",
}));
const mockNpuGenerate = jest.fn(async () => ({
  text: "Providence.",
  generatedTokens: 3,
  promptTokens: 42,
  decodeSpeed: 31.4,
  prefillSpeed: 520,
  ttftMs: 180,
  stopReason: "eos",
}));
const mockNpuUnload = jest.fn(async () => {});
// Echoes the requested unit back, as VestaNpuModule does — it resolves and
// validates the alias, then reports the one it built the session with.
const mockNpuLoadLlamaCpp = jest.fn(async (config?: { computeUnit?: string }) => ({
  version: "0.4.0",
  computeUnit: config?.computeUnit ?? "hybrid",
  runtimeId: "llama_cpp",
  soc: "SM8850",
  manifestRuntimeId: "llama_cpp",
  contextSize: 4096,
  deviceSelection: { sawHtpDevice: true, scopedToThisLoad: true },
}));

jest.mock("../../native/npu", () => ({
  isNpuBuild: jest.fn(() => true),
  isNpuRuntimeAvailable: jest.fn(() => true),
  npuUnavailableReason: jest.fn(() => null),
  npuRuntimeInfo: jest.fn(() => ({ version: "0.4.0", computeUnit: "npu", soc: "SM8850" })),
  npuLoad: (...args: unknown[]) => mockNpuLoad(...(args as [])),
  npuLoadLlamaCpp: (...args: unknown[]) =>
    mockNpuLoadLlamaCpp(...(args as [{ computeUnit?: string }])),
  npuGenerate: (...args: unknown[]) => mockNpuGenerate(...(args as [])),
  npuUnload: () => mockNpuUnload(),
  npuCancel: jest.fn(),
  onNpuToken: jest.fn(() => () => {}),
  DEFAULT_GENIEX_COMPUTE_UNIT: "hybrid",
}));

import {
  loadModel,
  generate,
  unloadModel,
  isNpuSession,
  supportsKvSessionCache,
  sessionMatches,
} from "../llm-engine";
import { backendModelRef, setDeviceSoc, genieXLlamaCpp } from "../backends/registry";
import { getLastRun, clearLastRun } from "../run-record";

const bundle = () =>
  backendModelRef({
    filePath: "/files/geniex/models/qwen3/model",
    artifact: "qairt_context",
    contextSize: 4096,
    displayName: "Qwen3 4B Instruct (2507) (NPU)",
    targetSoc: "SM8850",
    quant: "w4a16",
    runtimeModelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
    tokenizerPath: "/files/geniex/models/qwen3/tokenizer.json",
  });

const gguf = () =>
  backendModelRef({
    filePath: "/files/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    artifact: "gguf",
    contextSize: 4096,
    displayName: "Qwen3 4B Instruct (2507)",
    quant: "Q4_K_M",
  });

beforeEach(async () => {
  jest.clearAllMocks();
  clearLastRun();
  setDeviceSoc("SM8850");
  await unloadModel();
  // The backend is a process singleton and its compute unit is mutable, so a
  // test that changed it would otherwise leak into the next one.
  genieXLlamaCpp().setComputeUnit("hybrid");
  jest.clearAllMocks();
});

describe("a context bundle goes to QAIRT", () => {
  it("never touches llama.cpp", async () => {
    await loadModel("/files/geniex/models/qwen3/model", {
      backendModel: bundle(),
      contextSize: 4096,
    });
    expect(mockNpuLoad).toHaveBeenCalledTimes(1);
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(isNpuSession()).toBe(true);
  });

  it("addresses the bundle by the name the runtime knows it by", async () => {
    // Not by path. The model manager owns the layout and resolves the paths
    // itself, together with the manifest that says which runtime it is for —
    // handing it a path would bypass exactly that check.
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    expect(mockNpuLoad).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "ai-hub-models/Qwen3-4B-Instruct-2507" }),
    );
  });

  it("generates through the NPU and reports the runtime's own numbers", async () => {
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    const result = await generate([{ role: "user", content: "What is the capital of Rhode Island?" }]);

    expect(mockNpuGenerate).toHaveBeenCalledTimes(1);
    expect(mockLlamaContext.completion).not.toHaveBeenCalled();
    expect(result.text).toBe("Providence.");

    const run = getLastRun();
    expect(run?.backend).toBe("qualcomm_npu");
    expect(run?.backendLabel).toBe("Qualcomm GenieX / QAIRT");
    expect(run?.computeLabel).toBe("Hexagon HTP / NPU");
    expect(run?.soc).toBe("SM8850");
    expect(run?.artifactLabel).toBe("w4a16 context bundle");
    // Measured by the runtime, passed through unchanged.
    expect(run?.ttftMs).toBe(180);
    expect(run?.decodeTokensPerSecond).toBe(31.4);
    expect(run?.prefillTokensPerSecond).toBe(520);
    expect(run?.promptTokens).toBe(42);
    expect(run?.stopReason).toBe("eos");
  });

  it("has no KV session cache to offer", async () => {
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    expect(supportsKvSessionCache()).toBe(false);
  });

  it("refuses rather than falling back when the runtime cannot take it", async () => {
    mockNpuLoad.mockRejectedValueOnce(new Error("QAIRT plugin unavailable"));
    await expect(
      loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() }),
    ).rejects.toThrow("QAIRT plugin unavailable");
    // The failure is the whole answer. Nothing may have been loaded on the CPU.
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(isNpuSession()).toBe(false);
  });

  it("refuses a bundle the manifest says is for another runtime", async () => {
    mockNpuLoad.mockResolvedValueOnce({
      version: "0.4.0",
      computeUnit: "npu",
      runtimeId: "qairt",
      soc: "SM8850",
      manifestRuntimeId: "llama_cpp",
    });
    await expect(
      loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() }),
    ).rejects.toThrow(/not a Qualcomm NPU bundle/);
    expect(mockNpuUnload).toHaveBeenCalled();
  });

  it("refuses a bundle built for a different chipset", async () => {
    setDeviceSoc("SM8750");
    await expect(
      loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() }),
    ).rejects.toThrow(/SM8850.*SM8750/);
    expect(mockNpuLoad).not.toHaveBeenCalled();
  });
});

describe("a GGUF goes to llama.cpp", () => {
  it("even on a device with a working NPU", async () => {
    await loadModel(gguf().filePath, { backendModel: gguf(), contextSize: 4096 });
    expect(mockInitLlama).toHaveBeenCalledTimes(1);
    expect(mockNpuLoad).not.toHaveBeenCalled();
    expect(isNpuSession()).toBe(false);
  });

  it("and so does a caller that hands over a bare path", async () => {
    // Validation, the dev benchmark and the legacy migration all do this. The
    // old behaviour is the right one for them.
    await loadModel(gguf().filePath, { contextSize: 4096 });
    expect(mockInitLlama).toHaveBeenCalledTimes(1);
    expect(mockNpuLoad).not.toHaveBeenCalled();
  });
});

describe("switching between the two", () => {
  it("releases the NPU session before loading a GGUF", async () => {
    // Both are multi-gigabyte allocations; a phone holding two of them holds
    // neither for long.
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    await loadModel(gguf().filePath, { backendModel: gguf() });
    expect(mockNpuUnload).toHaveBeenCalled();
    expect(isNpuSession()).toBe(false);
  });

  it("releases the llama.cpp context before loading a bundle", async () => {
    await loadModel(gguf().filePath, { backendModel: gguf() });
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    expect(mockLlamaContext.release).toHaveBeenCalled();
    expect(isNpuSession()).toBe(true);
  });
});

// ── The third lane (SPIKE) ────────────────────────────────────────────────
//
// A GGUF the GENIEX model manager owns. Same file format as the one above and
// a completely different runtime, so the engine has to tell them apart from
// the row alone — and it has to keep telling QAIRT apart from both.

const genieXGguf = () =>
  backendModelRef({
    filePath: "/files/geniex/models/local/gemma/gemma-4-E2B-it-q4_0.gguf",
    artifact: "gguf",
    contextSize: 4096,
    displayName: "gemma-4-E2B-it-q4_0",
    quant: "Q4_0",
    runtimeModelName: "local/gemma-4-e2b-it-q4_0",
  });

describe("a GenieX-owned GGUF goes to the GenieX llama.cpp lane", () => {
  it("never touches llama.rn, and never touches QAIRT", async () => {
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(1);
    expect(mockInitLlama).not.toHaveBeenCalled();
    expect(mockNpuLoad).not.toHaveBeenCalled();
  });

  it("does not make isNpuSession() true", async () => {
    // The label this lane may not wear. `hybrid` is HTP AND CPU by design, and
    // isNpuSession() is read by everything that says "Hexagon HTP / NPU".
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(isNpuSession()).toBe(false);
  });

  it("offers no KV session cache either", async () => {
    // GenieX exposes no state save/load from Kotlin at 0.4.0, on either lane.
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(supportsKvSessionCache()).toBe(false);
  });

  it("generates through GenieX and records its own labels", async () => {
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    const result = await generate([{ role: "user", content: "hi" }]);

    expect(mockNpuGenerate).toHaveBeenCalledTimes(1);
    expect(mockLlamaContext.completion).not.toHaveBeenCalled();
    expect(result.text).toBe("Providence.");

    const run = getLastRun();
    expect(run?.backend).toBe("geniex_llama_cpp");
    expect(run?.computeLabel).toBe("Hexagon HTP + CPU (hybrid)");
    expect(run?.artifactLabel).toBe("GGUF Q4_0");
  });

  it("refuses rather than falling back to the CPU", async () => {
    mockNpuLoadLlamaCpp.mockRejectedValueOnce(new Error("HTP0 not found"));
    await expect(
      loadModel(genieXGguf().filePath, { backendModel: genieXGguf() }),
    ).rejects.toThrow("HTP0 not found");
    // The one thing that must never happen: the same file quietly on llama.rn.
    expect(mockInitLlama).not.toHaveBeenCalled();
  });

  it("leaves an ordinary GGUF to llama.rn", async () => {
    // The whole distinction is the runtimeModelName; without it this row is
    // the portable file it looks like.
    await loadModel(gguf().filePath, { backendModel: gguf() });
    expect(mockNpuLoadLlamaCpp).not.toHaveBeenCalled();
    expect(mockInitLlama).toHaveBeenCalledTimes(1);
  });
});

describe("handing the runtime over between the two GenieX lanes", () => {
  // One native LlmWrapper serves both, and the two plugins collide on the same
  // CDSP domain — GenieX only hands HTP sessions over when no llama.cpp
  // session still holds one. So the previous session must always be released
  // before the next is created, in BOTH directions.
  it("releases QAIRT before creating a llama.cpp session", async () => {
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(mockNpuUnload).toHaveBeenCalled();
    expect(isNpuSession()).toBe(false);
  });

  it("releases llama.cpp before creating a QAIRT session", async () => {
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    expect(mockNpuUnload).toHaveBeenCalled();
    expect(isNpuSession()).toBe(true);
  });

  it("survives a round trip back to llama.cpp", async () => {
    // The device protocol's step I, in miniature: QAIRT → llama.cpp → QAIRT →
    // llama.cpp must leave exactly one session standing.
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(2);
    expect(isNpuSession()).toBe(false);
    expect(mockInitLlama).not.toHaveBeenCalled();
  });
});

describe("changing a load-affecting setting on the model already loaded", () => {
  // From the device: loaded as `npu`, selector moved to `hybrid`, same model
  // still active — and nothing rebuilt the session. The load path returned
  // early because `genieXLlamaModel.filePath === modelPath`, which is a
  // question about model IDENTITY and was being used to answer a question about
  // the SESSION. Forcing a QAIRT → llama.cpp handoff was the only way to get a
  // genuine hybrid session, because that path releases everything and so cannot
  // short-circuit at all.

  const backend = () => genieXLlamaCpp();

  it("does NOT reload when the model and the compute unit are both unchanged", async () => {
    // The property that must survive the fix. A rebuild costs seconds of
    // reloading weights that are already resident and identically configured.
    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });

    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(1);
    expect(mockNpuUnload).not.toHaveBeenCalled();
  });

  it("DOES reload when the compute unit changed from npu to hybrid", async () => {
    backend().setComputeUnit("npu");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });

    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });

    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(2);
    // The old session is released first: one native LlmWrapper per process,
    // and the two compute units are two different arrangements of hardware.
    expect(mockNpuUnload).toHaveBeenCalled();
    expect(mockNpuLoadLlamaCpp).toHaveBeenLastCalledWith(
      expect.objectContaining({ computeUnit: "hybrid" }),
    );
  });

  it("DOES reload when the compute unit changed from hybrid to npu", async () => {
    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });

    backend().setComputeUnit("npu");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });

    expect(mockNpuLoadLlamaCpp).toHaveBeenCalledTimes(2);
    expect(mockNpuLoadLlamaCpp).toHaveBeenLastCalledWith(
      expect.objectContaining({ computeUnit: "npu" }),
    );
  });

  it("answers sessionMatches honestly across the change", async () => {
    // The single definition both the load path and the Models screen consult,
    // so a card that looks like a no-op is one.
    backend().setComputeUnit("npu");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(sessionMatches(genieXGguf())).toBe(true);

    backend().setComputeUnit("hybrid");
    expect(sessionMatches(genieXGguf())).toBe(false);

    // Putting it back makes the live session current again — nothing to do.
    backend().setComputeUnit("npu");
    expect(sessionMatches(genieXGguf())).toBe(true);
  });

  it("matches nothing once the session is gone", async () => {
    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await unloadModel();

    // A released session leaves no fingerprint behind for the next load to
    // match against.
    expect(sessionMatches(genieXGguf())).toBe(false);
  });

  it("never matches a DIFFERENT model, whatever the compute unit", async () => {
    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    expect(sessionMatches(bundle())).toBe(false);
    expect(sessionMatches(gguf())).toBe(false);
  });

  it("labels the turn after a reload with the NEW session's unit", async () => {
    // The end-to-end shape of the reported bug: what Last Run says after the
    // session has actually been rebuilt.
    backend().setComputeUnit("npu");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await generate([{ role: "user", content: "hi" }]);
    expect(getLastRun()?.computeLabel).toBe("Hexagon HTP (pinned HTP0)");

    backend().setComputeUnit("hybrid");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await generate([{ role: "user", content: "hi" }]);
    expect(getLastRun()?.computeLabel).toBe("Hexagon HTP + CPU (hybrid)");
  });

  it("does not relabel a turn produced BEFORE the selector moved", async () => {
    // No stale pending selector may reach back and rename a session that has
    // already run. The record is written at the point of execution and is a
    // statement about that moment.
    backend().setComputeUnit("npu");
    await loadModel(genieXGguf().filePath, { backendModel: genieXGguf() });
    await generate([{ role: "user", content: "hi" }]);

    backend().setComputeUnit("hybrid");

    expect(getLastRun()?.computeLabel).toBe("Hexagon HTP (pinned HTP0)");
  });
});

describe("QAIRT keeps its same-model no-op", () => {
  // Its compute unit is pinned in Kotlin and it declares no load fingerprint,
  // so there is nothing about a bundle load that can vary. Rebuilding an
  // identical QAIRT session costs ~14 s on the device to arrive where it
  // already was.
  it("does not reload the same bundle twice", async () => {
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });

    expect(mockNpuLoad).toHaveBeenCalledTimes(1);
    expect(mockNpuUnload).not.toHaveBeenCalled();
  });

  it("stays a no-op even while the llama.cpp selector is being moved", async () => {
    // The two lanes must not leak into each other: a setting that belongs to
    // one backend cannot invalidate the other's session.
    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    genieXLlamaCpp().setComputeUnit("npu");
    expect(sessionMatches(bundle())).toBe(true);
    genieXLlamaCpp().setComputeUnit("hybrid");
    expect(sessionMatches(bundle())).toBe(true);

    await loadModel("/files/geniex/models/qwen3/model", { backendModel: bundle() });
    expect(mockNpuLoad).toHaveBeenCalledTimes(1);
  });
});

describe("llama.rn keeps its same-model no-op", () => {
  it("does not rebuild a context for the same GGUF", async () => {
    await loadModel(gguf().filePath, { backendModel: gguf() });
    await loadModel(gguf().filePath, { backendModel: gguf() });

    expect(mockInitLlama).toHaveBeenCalledTimes(1);
    expect(sessionMatches(gguf())).toBe(true);
  });
});
