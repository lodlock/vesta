// Backend selection and fallback.
//
// The behaviour that matters is the fallback: every GGUF must land on
// llama.cpp, and a model an accelerated backend cannot actually run must NOT be
// claimed by it. Getting that wrong turns "runs a bit slower" into "does not
// run".

import { selectBackend, backendModelRef, backendDiagnostics, allBackends } from "../registry";
import { LlamaCppBackend } from "../llamacpp-backend";
import { QualcommNpuBackend } from "../qnn-backend";
import { formatOf } from "../types";

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
  getModelInfo: jest.fn(() => ({ loaded: false })),
  getLastCompletion: jest.fn(() => null),
}));

describe("formatOf", () => {
  it("recognizes the formats the backends care about", () => {
    expect(formatOf("/models/qwen3-4b.gguf")).toBe("gguf");
    expect(formatOf("/models/QWEN3.GGUF")).toBe("gguf");
    expect(formatOf("/models/model.pte")).toBe("executorch-pte");
    expect(formatOf("/models/qwen3_4b_sm8850.bin")).toBe("qnn-context");
    expect(formatOf("/models/notes.txt")).toBe("unknown");
  });
});

describe("selectBackend", () => {
  it("routes a GGUF to llama.cpp", () => {
    const backend = selectBackend(
      backendModelRef({ filePath: "/models/qwen3-4b.gguf", contextSize: 4096 }),
    );
    expect(backend?.id).toBe("llama.cpp");
  });

  it("routes a user-supplied GGUF the same way — no repo, no target", () => {
    const backend = selectBackend(
      backendModelRef({ filePath: "/models/my-own-merge.gguf", contextSize: 8192 }),
    );
    expect(backend?.id).toBe("llama.cpp");
  });

  it("does NOT hand a GGUF to the NPU backend even when it is first in order", () => {
    expect(allBackends()[0].id).toBe("qnn");
    expect(
      allBackends()[0].supports(
        backendModelRef({ filePath: "/models/qwen3-4b.gguf", contextSize: 4096 }),
      ),
    ).toBe(false);
  });

  it("returns null for a format nothing can run, rather than guessing", () => {
    expect(
      selectBackend(backendModelRef({ filePath: "/models/model.pte", contextSize: 4096 })),
    ).toBeNull();
  });
});

describe("QualcommNpuBackend — unimplemented, and honest about it", () => {
  it("claims nothing while the runtime is absent", () => {
    const npu = new QualcommNpuBackend("SM8850");
    expect(npu.isAvailable()).toBe(false);
    expect(
      npu.supports({
        filePath: "/models/qwen3_4b_sm8850.bin",
        format: "qnn-context",
        contextSize: 4096,
        targetSoc: "SM8850",
      }),
    ).toBe(false);
  });

  it("would refuse a binary built for a different chip", () => {
    // Even once available: a context binary is compiled per SoC, and running
    // the wrong one is a crash, not a slowdown.
    const npu = new QualcommNpuBackend("SM8850");
    jest.spyOn(npu, "isAvailable").mockReturnValue(true);

    const ref = {
      format: "qnn-context" as const,
      contextSize: 4096,
      filePath: "/models/x.bin",
    };
    expect(npu.supports({ ...ref, targetSoc: "SM8750" })).toBe(false);
    expect(npu.supports({ ...ref, targetSoc: null })).toBe(false);
    expect(npu.supports({ ...ref, targetSoc: "SM8850" })).toBe(true);
  });

  it("fails loudly if something calls it anyway", async () => {
    const npu = new QualcommNpuBackend("SM8850");
    await expect(npu.load()).rejects.toThrow(/not bundled/i);
    await expect(npu.generate([])).rejects.toThrow(/not bundled/i);
    // Unload stays a no-op so callers can tear everything down uniformly.
    await expect(npu.unload()).resolves.toBeUndefined();
  });
});

describe("diagnostics", () => {
  it("names every backend and why an unavailable one is unavailable", () => {
    const diagnostics = backendDiagnostics();
    const byId = Object.fromEntries(diagnostics.map((d) => [d.id, d]));

    expect(byId["llama.cpp"]).toMatchObject({ available: true, unavailableReason: null });
    expect(byId.qnn.available).toBe(false);
    expect(byId.qnn.unavailableReason).toMatch(/llama\.cpp/);
  });

  it("reports which backend is actually loaded", () => {
    const llama = new LlamaCppBackend();
    expect(llama.getDiagnostics()).toMatchObject({
      id: "llama.cpp",
      available: true,
      loaded: false,
    });
  });
});
