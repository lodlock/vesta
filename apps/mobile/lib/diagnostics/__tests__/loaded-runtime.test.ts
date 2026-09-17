// The "loaded:" line has to name the runtime making the claim.
//
// "loaded: yes" is true of any live session, so on the device that produced the
// bug report it read as a working accelerated model while llama.rn held the
// file. The only contradiction anywhere in the report was a token rate in a
// different section, and reading a backend list is not how someone finds out
// that the model they activated is running somewhere else.
//
// So the line states the runtime, and states a disagreement between the live
// session and the active row as a disagreement.

import { describeLoadedRuntime } from "../sections";

describe("nothing loaded", () => {
  it("says no, whatever the row is registered for", () => {
    expect(describeLoadedRuntime(null, "geniex_llama_cpp")).toBe("no");
    expect(describeLoadedRuntime(null, null)).toBe("no");
  });
});

describe("the runtime that owns the session is named", () => {
  it("names llama.cpp", () => {
    expect(describeLoadedRuntime("llama_cpp", "llama_cpp")).toBe(
      "yes — on llama.cpp (CPU)",
    );
  });

  it("names the GenieX lane", () => {
    expect(describeLoadedRuntime("geniex_llama_cpp", "geniex_llama_cpp")).toBe(
      "yes — on Qualcomm GenieX / llama.cpp",
    );
  });

  it("names QAIRT", () => {
    expect(describeLoadedRuntime("qualcomm_npu", "qualcomm_npu")).toBe(
      "yes — on Qualcomm NPU (QAIRT)",
    );
  });

  it("makes no claim about a row that declares nothing", () => {
    expect(describeLoadedRuntime("llama_cpp", null)).toBe(
      "yes — on llama.cpp (CPU)",
    );
  });
});

describe("a session on the wrong runtime is called that", () => {
  it("is the reported state, and it is stated rather than implied", () => {
    // Exactly the device report: a GenieX-registered model, llama.rn holding
    // the session. This line is where that has to be visible.
    const line = describeLoadedRuntime("llama_cpp", "geniex_llama_cpp");

    expect(line).toContain("llama.cpp (CPU)");
    expect(line).toContain("Qualcomm GenieX / llama.cpp");
    expect(line).toContain("BACKEND MISMATCH");
  });

  it("catches the mirror case too", () => {
    expect(describeLoadedRuntime("geniex_llama_cpp", "qualcomm_npu")).toContain(
      "BACKEND MISMATCH",
    );
  });
});
