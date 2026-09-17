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

// Echoes the compute unit back, exactly as VestaNpuModule does: the native side
// resolves and validates the alias and then reports the one it built the session
// with. A mock that answered "hybrid" to every request would hide the bug this
// lane had — a label taken from the pending selector rather than the session.
const mockLoadLlamaCpp = jest.fn(async (config?: { computeUnit?: string }) => ({
  version: "0.4.0",
  computeUnit: config?.computeUnit ?? "hybrid",
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
  npuLoadLlamaCpp: (...args: unknown[]) =>
    mockLoadLlamaCpp(...(args as [{ computeUnit?: string }])),
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
    // The runtime's own sentence, kept verbatim — it is the only part that says
    // anything specific about what went wrong.
    expect(backend.refusalFor(owned())).toContain("The runtime did not start.");
  });

  it("does not offer the CPU as a fallback for a model it owns", () => {
    // Routing binds a GenieX-managed row to this lane, so a refusal here is a
    // load failure. Words promising that the model "runs on llama.cpp (CPU)"
    // described the behaviour that was the bug — see backends/routing.ts.
    mockRuntimeAvailable = false;
    const refusal = new GenieXLlamaCppBackend().refusalFor(owned());
    expect(refusal).toContain("can only run on the GenieX llama.cpp runtime");
    expect(refusal).not.toMatch(/llama\.cpp \(CPU\)/);
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

// ── Compute-unit lifecycle ──────────────────────────────────────────────────
//
// From the device: a model was loaded as `npu`, the Diagnostics selector moved
// to `hybrid`, and the same model stayed active. Re-activating it did not
// rebuild the native session — every short-circuit on the way compared file
// paths — so pinned HTP0 went on serving turns while Last Run called them
// hybrid. Forcing a QAIRT → llama.cpp handoff was the only way to get a real
// hybrid session, because that path releases everything and cannot short-circuit.
//
// Two separate faults, and both are pinned below:
//   1. the compute unit the SESSION was built with was never recorded, so the
//      label had nothing to read but the pending selector;
//   2. "same model id" was treated as "same session", so a changed setting was
//      silently discarded.

describe("the loaded session owns its compute unit", () => {
  it("labels a turn with the unit the SESSION was built with", async () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());

    // The selector moves after the session exists — the exact device sequence.
    backend.setComputeUnit("hybrid");
    await backend.generate([{ role: "user", content: "hi" }]);

    // The turn ran on pinned HTP0 and says so. Reading the pending value here
    // is what let a stale selector relabel a live session.
    expect(getLastRun()?.computeLabel).toBe("Hexagon HTP (pinned HTP0)");
    expect(getLastRun()?.computeLabel).not.toMatch(/hybrid/);
  });

  it("keeps the session's unit and the pending one as separate facts", async () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());
    backend.setComputeUnit("hybrid");

    const details = backend.getDiagnostics().details;
    // Backend diagnostics are the source of truth for what is LOADED…
    expect(details.requestedComputeUnit).toBe("npu");
    expect(backend.getLoadedComputeUnit()).toBe("npu");
    // …and the pending value is visible beside it rather than replacing it.
    expect(details.pendingComputeUnit).toBe("hybrid");
    expect(details.computeUnitStale).toBe(true);
  });

  it("reports no stale config when nothing has been changed", async () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());

    const details = backend.getDiagnostics().details;
    expect(details.requestedComputeUnit).toBe("npu");
    expect(details.pendingComputeUnit).toBe("npu");
    expect(details.computeUnitStale).toBe(false);
  });

  it("claims no session compute unit before anything is loaded", async () => {
    // An unloaded backend showing the pending value looked exactly like a
    // loaded one running in that mode.
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    expect(backend.getDiagnostics().details.requestedComputeUnit).toBe("n/a");
    expect(backend.getLoadedComputeUnit()).toBeNull();
    expect(backend.getDiagnostics().details.computeUnitStale).toBe(false);
  });

  it("forgets the session's unit when the session goes", async () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());
    await backend.unload();

    expect(backend.getLoadedComputeUnit()).toBeNull();
    expect(backend.getDiagnostics().details.requestedComputeUnit).toBe("n/a");
  });

  it("forgets it when the load FAILS, rather than describing a session that never existed", async () => {
    mockLoadLlamaCpp.mockRejectedValueOnce(new Error("HTP0 not found"));
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await expect(backend.load(owned())).rejects.toThrow();

    expect(backend.getLoadedComputeUnit()).toBeNull();
  });

  it("describes the session by what the RUNTIME echoed, not what was asked", async () => {
    // The native side resolves and validates the alias before building
    // LlmCreateInput, so its answer is the one that describes the session. If
    // those two ever disagree, the runtime wins — a request is not an outcome.
    mockLoadLlamaCpp.mockResolvedValueOnce({
      version: "0.4.0",
      computeUnit: "hybrid",
      runtimeId: "llama_cpp",
      soc: "SM8850",
      manifestRuntimeId: "llama_cpp",
      contextSize: 4096,
      deviceSelection: {},
    } as Awaited<ReturnType<typeof mockLoadLlamaCpp>>);
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());

    expect(backend.getLoadedComputeUnit()).toBe("hybrid");
  });

  it("ignores an echoed unit it does not recognise, keeping what it asked for", async () => {
    // A future runtime answering something new must not become a label nothing
    // else in the app understands.
    mockLoadLlamaCpp.mockResolvedValueOnce({
      version: "0.4.0",
      computeUnit: "quantum",
      runtimeId: "llama_cpp",
      soc: "SM8850",
      manifestRuntimeId: "llama_cpp",
      contextSize: 4096,
      deviceSelection: {},
    } as Awaited<ReturnType<typeof mockLoadLlamaCpp>>);
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    await backend.load(owned());

    expect(backend.getLoadedComputeUnit()).toBe("npu");
  });

  it("is not changed mid-load by a tap that lands during the load", async () => {
    // A load takes seconds and the selector is a button. Re-reading the field
    // after the await would let a tap decide how a session it did not
    // configure gets described.
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    mockLoadLlamaCpp.mockImplementationOnce(async () => {
      await pending;
      return {
        version: "0.4.0",
        computeUnit: "npu",
        runtimeId: "llama_cpp",
        soc: "SM8850",
        manifestRuntimeId: "llama_cpp",
        contextSize: 4096,
        deviceSelection: {},
      } as Awaited<ReturnType<typeof mockLoadLlamaCpp>>;
    });

    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    const loading = backend.load(owned());
    backend.setComputeUnit("hybrid"); // lands mid-load
    release();
    await loading;

    expect(mockLoadLlamaCpp).toHaveBeenCalledWith(
      expect.objectContaining({ computeUnit: "npu" }),
    );
    expect(backend.getLoadedComputeUnit()).toBe("npu");
  });
});

describe("the load fingerprint decides whether a session can be reused", () => {
  it("is unchanged for the same model and the same compute unit", () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    expect(backend.loadFingerprint(owned())).toBe(
      backend.loadFingerprint(owned()),
    );
  });

  it("CHANGES when the compute unit changes", () => {
    // This is the whole mechanism: npu → hybrid must not compare equal, or the
    // session gets reused and the setting silently does nothing.
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("npu");
    const pinned = backend.loadFingerprint(owned());
    backend.setComputeUnit("hybrid");
    expect(backend.loadFingerprint(owned())).not.toBe(pinned);
  });

  it("changes in both directions", () => {
    const backend = new GenieXLlamaCppBackend();
    backend.setComputeUnit("hybrid");
    const hybrid = backend.loadFingerprint(owned());
    backend.setComputeUnit("npu");
    const npu = backend.loadFingerprint(owned());
    backend.setComputeUnit("hybrid");
    expect(backend.loadFingerprint(owned())).toBe(hybrid);
    expect(npu).not.toBe(hybrid);
  });

  it("changes when the context size does", () => {
    // The other thing the session is built around. Same model file, different
    // session.
    const backend = new GenieXLlamaCppBackend();
    expect(backend.loadFingerprint(owned({ contextSize: 4096 }))).not.toBe(
      backend.loadFingerprint(owned({ contextSize: 8192 })),
    );
  });
});
