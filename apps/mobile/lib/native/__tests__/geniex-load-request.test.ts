// What actually goes on the wire for a GenieX llama.cpp load.
//
// One field decides where the model runs, and the SDK's own KDoc is wrong
// about it. `LlmCreateInput.compute_unit` is documented as "null selects the
// runtime default (HYBRID for llama_cpp)"; the code does the opposite:
//
//     // sdk/src/device.cpp, v0.4.0
//     if (alias.empty() || alias == kAliasAuto) { alias = kAliasNPU; }
//
// An omitted compute unit is therefore `npu` — one pinned HTP0 session — and
// not the per-tensor HTP+CPU scheduler. So the alias is filled in on this side
// and sent explicitly every time, and the one thing this file exists to prevent
// is a future edit that "simplifies" it back to a null.

import {
  npuLoadLlamaCppRequest,
  npuLoadRequest,
  DEFAULT_GENIEX_COMPUTE_UNIT,
} from "../npu";

describe("the llama.cpp load request", () => {
  it("fills in hybrid when the caller omits the compute unit", () => {
    expect(npuLoadLlamaCppRequest({ modelName: "local/gemma" })).toEqual({
      modelName: "local/gemma",
      computeUnit: "hybrid",
    });
  });

  it("never sends null as a stand-in for hybrid", () => {
    const request = npuLoadLlamaCppRequest({
      modelName: "local/gemma",
      computeUnit: undefined,
    });
    // Present, and not the value the SDK reads as "npu".
    expect(request.computeUnit).toBe("hybrid");
    expect(JSON.stringify(request)).toContain('"computeUnit":"hybrid"');
    expect(JSON.stringify(request)).not.toContain("null");
  });

  it("keeps an explicit compute unit, including the pinned one", () => {
    for (const unit of ["cpu", "gpu", "npu", "hybrid"] as const) {
      expect(
        npuLoadLlamaCppRequest({ modelName: "local/gemma", computeUnit: unit })
          .computeUnit,
      ).toBe(unit);
    }
  });

  it("carries the context size through, and drops it when absent", () => {
    expect(
      npuLoadLlamaCppRequest({ modelName: "local/gemma", contextSize: 8192 })
        .contextSize,
    ).toBe(8192);
    // Absent rather than null: org.json reads a JSON null back as the string
    // "null", which is how a path called "null" once reached the runtime.
    expect(
      "contextSize" in npuLoadLlamaCppRequest({ modelName: "local/gemma" }),
    ).toBe(false);
  });

  it("agrees with the constant the backend defaults to", () => {
    expect(DEFAULT_GENIEX_COMPUTE_UNIT).toBe("hybrid");
  });
});

describe("the QAIRT load request is untouched", () => {
  it("still drops nulls and still adds no compute unit of its own", () => {
    // The QAIRT path pins runtime and compute unit in Kotlin, and nothing in
    // the llama.cpp work may start injecting one here.
    const request = npuLoadRequest({
      modelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
      modelPath: "/files/geniex/models/qwen3/model",
      tokenizerPath: null,
    });
    expect(request).toEqual({
      modelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
      modelPath: "/files/geniex/models/qwen3/model",
    });
    expect("computeUnit" in request).toBe(false);
  });
});
