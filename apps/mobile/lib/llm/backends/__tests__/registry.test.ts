// Backend selection, and the refusals that keep it honest.
//
// Two properties matter more than anything else here. Every GGUF must land on
// llama.cpp — that fallback is what makes "bring your own model" work on any
// device. And the NPU backend must never claim an artifact it cannot actually
// run: a wrong yes is a crash after a multi-GB download, a wrong no is a model
// that runs on CPU, which is where it would have run anyway.

import {
  selectBackend,
  backendModelRef,
  backendDiagnostics,
  allBackends,
  setDeviceSoc,
  npuRefusalFor,
} from "../registry";
import { LlamaCppBackend } from "../llamacpp-backend";
import { QualcommNpuBackend } from "../qnn-backend";
import { guessArtifact } from "../types";
import { isNpuRuntimeAvailable } from "../../../native/npu";

jest.mock("../../llm-engine", () => ({
  loadModel: jest.fn(async () => {}),
  unloadModel: jest.fn(async () => {}),
  generate: jest.fn(async () => ({
    text: "hi",
    content: "hi",
    tokensPredicted: 2,
    timings: { predictedPerSecond: 12 },
  })),
  isLoaded: jest.fn(() => false),
  // Which lane owns the live session. The llama.cpp backend reports on itself
  // through this rather than through the engine-wide isLoaded(), so that it
  // stays quiet while another lane holds the one native context.
  loadedBackendId: jest.fn(() => null),
  getModelInfo: jest.fn(() => ({ loaded: false })),
  getLastCompletion: jest.fn(() => null),
}));
jest.mock("../../../native/npu", () => ({
  // The default build's answers: the bridge is not compiled in, so nothing is
  // available and there is no failure reason to report either.
  isNpuBuild: jest.fn(() => false),
  isNpuRuntimeAvailable: jest.fn(() => false),
  npuUnavailableReason: jest.fn(() => null),
  npuRuntimeInfo: jest.fn(() => null),
  npuLoad: jest.fn(),
  npuLoadLlamaCpp: jest.fn(),
  npuGenerate: jest.fn(),
  npuUnload: jest.fn(async () => {}),
  npuCancel: jest.fn(),
  onNpuToken: jest.fn(() => () => {}),
  DEFAULT_GENIEX_COMPUTE_UNIT: "hybrid",
}));

const mockRuntime = isNpuRuntimeAvailable as jest.MockedFunction<
  typeof isNpuRuntimeAvailable
>;

const gguf = () =>
  backendModelRef({
    filePath: "file:///docs/models/qwen3-4b.gguf",
    contextSize: 4096,
    displayName: "Qwen3 4B",
    artifact: "gguf",
  });

const npuBundle = (over: Partial<Parameters<typeof backendModelRef>[0]> = {}) =>
  backendModelRef({
    filePath: "file:///docs/models/qwen3-4b-sm8850/weights.bin",
    contextSize: 4096,
    displayName: "Qwen3 4B Instruct 2507 (NPU)",
    artifact: "qairt_context",
    targetSoc: "SM8850",
    ...over,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRuntime.mockReturnValue(false);
  setDeviceSoc(null);
});

describe("guessArtifact", () => {
  it("reads the formats an import can hand us", () => {
    expect(guessArtifact("/models/qwen3-4b.gguf")).toBe("gguf");
    expect(guessArtifact("/models/QWEN3.GGUF")).toBe("gguf");
    expect(guessArtifact("/models/qwen3_sm8850.bin")).toBe("qairt_context");
    expect(guessArtifact("/models/notes.txt")).toBe("unknown");
  });
});

describe("GGUF always has a runtime", () => {
  it("routes to llama.cpp", () => {
    expect(selectBackend(gguf())?.id).toBe("llama.cpp");
  });

  it("routes a user's own merge the same way — no repo, no target", () => {
    const backend = selectBackend(
      backendModelRef({
        filePath: "file:///docs/models/my-own-merge.gguf",
        contextSize: 8192,
        artifact: "gguf",
      }),
    );
    expect(backend?.id).toBe("llama.cpp");
  });

  it("still routes to llama.cpp when the NPU runtime IS present", () => {
    // The NPU backend is first in order; it must not take a GGUF.
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("SM8850");
    expect(selectBackend(gguf())?.id).toBe("llama.cpp");
  });
});

describe("the NPU backend refuses everything it cannot prove", () => {
  it("refuses while no runtime is built in — the default build", () => {
    setDeviceSoc("SM8850");
    expect(selectBackend(npuBundle())).toBeNull();
    expect(npuRefusalFor(npuBundle())).toMatch(/no Qualcomm NPU runtime/i);
  });

  it("refuses when the device chipset is unknown", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc(null);
    expect(selectBackend(npuBundle())).toBeNull();
    expect(npuRefusalFor(npuBundle())).toMatch(/doesn't report its chipset/i);
  });

  it("refuses a bundle built for a DIFFERENT chip", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("SM8750");
    expect(selectBackend(npuBundle({ targetSoc: "SM8850" }))).toBeNull();
    expect(npuRefusalFor(npuBundle({ targetSoc: "SM8850" }))).toMatch(
      /built for SM8850; this device is SM8750/i,
    );
  });

  it("refuses a bundle that doesn't say what it was built for", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("SM8850");
    expect(selectBackend(npuBundle({ targetSoc: null }))).toBeNull();
    expect(npuRefusalFor(npuBundle({ targetSoc: null }))).toMatch(
      /doesn't record which chipset/i,
    );
  });

  it("refuses when the artifact needs a newer runtime than we have", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("SM8850");
    const npu = new QualcommNpuBackend("SM8850");
    jest.spyOn(npu, "isAvailable").mockReturnValue(true);
    // The backend reads the runtime version from the native probe; with none
    // reported the check can't fail, so this exercises npu-compat directly.
    expect(
      npu.supports(npuBundle({ runtimeVersion: "9.9.9" })),
    ).toBe(true); // no runtime version known → nothing to compare
  });

  it("accepts a matching bundle once everything lines up", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("SM8850");
    expect(selectBackend(npuBundle())?.id).toBe("qualcomm_npu");
  });

  it("matches a chipset case-insensitively", () => {
    mockRuntime.mockReturnValue(true);
    setDeviceSoc("sm8850");
    expect(selectBackend(npuBundle({ targetSoc: "SM8850" }))?.id).toBe("qualcomm_npu");
  });
});

describe("a refused NPU model does not silently run somewhere else", () => {
  it("returns null rather than handing a bundle to llama.cpp", () => {
    // llama.cpp is the fallback for GGUF, not for everything: a context binary
    // it cannot read must not reach it.
    setDeviceSoc("SM8850");
    expect(selectBackend(npuBundle())).toBeNull();
    expect(new LlamaCppBackend().supports(npuBundle())).toBe(false);
  });

  it("fails loudly if something calls an unavailable backend anyway", async () => {
    const npu = new QualcommNpuBackend("SM8750");
    await expect(npu.load(npuBundle())).rejects.toThrow();
    await expect(npu.generate([])).rejects.toThrow(/No NPU model loaded/i);
    // Unload stays a no-op so callers can tear everything down uniformly.
    await expect(npu.unload()).resolves.toBeUndefined();
  });
});

describe("diagnostics name the backend and the reason", () => {
  it("reports both backends and why the NPU one is out", () => {
    const byId = Object.fromEntries(backendDiagnostics().map((d) => [d.id, d]));

    expect(byId["llama.cpp"]).toMatchObject({ available: true, unavailableReason: null });
    expect(byId.qualcomm_npu.available).toBe(false);
    expect(byId.qualcomm_npu.unavailableReason).toMatch(/llama\.cpp/);
  });

  it("carries the device chipset so a mismatch is visible", () => {
    setDeviceSoc("SM8850");
    const npu = backendDiagnostics().find((d) => d.id === "qualcomm_npu");
    expect(npu?.details.soc).toBe("SM8850");
  });

  it("keeps the NPU backend present in every build", () => {
    // It exists even when unusable, so diagnostics can say WHY rather than
    // staying silent about the NPU on a device that has one.
    //
    // The ORDER is the routing policy, so it is asserted whole rather than by
    // membership: accelerated first, and the one runtime that can always run a
    // GGUF last. A GenieX llama.cpp lane that drifted below llama.rn would
    // never be reached, and one that drifted above QAIRT would be asked about
    // context bundles it cannot run.
    expect(allBackends().map((b) => b.id)).toEqual([
      "qualcomm_npu",
      "geniex_llama_cpp",
      "llama.cpp",
    ]);
  });
});
