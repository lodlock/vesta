// The LOCALFS import request, and the Q4_0 guard in front of it.
//
// Two things are checkable here without a Qualcomm device, and both of them
// are hard-stop conditions for the spike:
//
//   1. the path handed to the model manager must be a DIRECTORY. LOCALFS
//      refuses a bare file that is not a .zip ("local path … is a file but not
//      a .zip") — model-manager/crates/core/src/source/localfs.rs, v0.4.0.
//   2. the artifact must be Q4_0. It is the only llama.cpp quantization the
//      Hexagon backend has kernels for, so any other one would import cleanly,
//      run off the DSP, and produce a measurement that looks like a result and
//      proves nothing. It is refused rather than substituted.
//
// What is asserted about (2) is deliberately narrow: the guard reads the tag
// out of the FILE NAME and believes it, which is a spike heuristic and not
// quantization verification. `spike-guard-is-name-only` below pins that
// limitation in place so it is discovered by reading the tests rather than by
// trusting a label. The real check is `general.file_type` in the GGUF
// metadata, which lib/models/gguf-header.ts does not parse yet.

import {
  genieXLocalModelName,
  genieXImportRequest,
  genieXImportedRow,
  pickSpikeGguf,
  GENIEX_SPIKE_PRECISION,
} from "../geniex-gguf-import";
import type { NpuBundleInfo } from "../../native/npu";

describe("the cache key", () => {
  it("is org/repo shaped, which is what the runtime validates", () => {
    // "invalid model name: '…' must be 'org/repo'" is the runtime's own
    // refusal; a bare name would not survive it.
    expect(genieXLocalModelName("gemma-4-E2B-it-q4_0")).toBe(
      "local/gemma-4-e2b-it-q4_0",
    );
  });

  it("survives a name that is nothing but punctuation", () => {
    expect(genieXLocalModelName("   ***   ")).toBe("local/model");
  });
});

describe("the import request", () => {
  it("sends a precision, always", () => {
    // Omitted, the inferred manifest keeps ONE ENTRY PER QUANT and the import
    // copies every one of them — tens of gigabytes from a multi-quant repo.
    const request = genieXImportRequest("/ext/geniex-spike", "gemma-q4_0");
    expect(request.precision).toBe(GENIEX_SPIKE_PRECISION);
    expect(request.precision).toBe("Q4_0");
  });

  it("passes the directory through unchanged", () => {
    const request = genieXImportRequest("/ext/geniex-spike", "gemma-q4_0");
    expect(request.localPath).toBe("/ext/geniex-spike");
    expect(request.localPath.endsWith(".gguf")).toBe(false);
  });

  it("does not carry a hub — the native side pins LOCALFS", () => {
    expect("hub" in genieXImportRequest("/ext/geniex-spike", "x-q4_0")).toBe(false);
  });
});

describe("the Q4_0 spike guard (filename only)", () => {
  it("spike-guard-is-name-only: believes a name that could be lying", () => {
    // Pinned deliberately. A file NAMED q4_0 that holds K-quant weights is
    // accepted here, would be accepted by the model manager's extract_quant()
    // for the same reason, and would run off the DSP under a "Q4_0" label.
    // That is the known limit of a developer-pushed spike, not a bug to fix
    // here — the fix is reading general.file_type out of the GGUF metadata,
    // and this test is what should fail when someone does that work.
    expect(pickSpikeGguf(["definitely-not-really-q4_0.gguf"]).ok).toBe(true);
  });

  it("accepts a Q4_0 GGUF, in either case", () => {
    expect(pickSpikeGguf(["gemma-4-E2B-it-q4_0.gguf"])).toEqual({
      ok: true,
      file: "gemma-4-E2B-it-q4_0.gguf",
      displayName: "gemma-4-E2B-it-q4_0",
    });
    expect(pickSpikeGguf(["Gemma-Q4_0.gguf"]).ok).toBe(true);
  });

  it("refuses Q4_K_M rather than substituting it", () => {
    const pick = pickSpikeGguf(["qwen3-4b-Q4_K_M.gguf"]);
    expect(pick.ok).toBe(false);
    expect(pick.ok === false && pick.reason).toMatch(/not named as a Q4_0 build/);
    // And the refusal says what it actually checked, so nobody reads it as a
    // statement about the weights.
    expect(pick.ok === false && pick.reason).toMatch(/checks the NAME/);
  });

  it("refuses a GGUF with no quant tag at all", () => {
    // `extract_quant()` would not bucket it either, and the manager's own
    // refusal ("no recognizable model files found") names nothing useful.
    const pick = pickSpikeGguf(["model.gguf"]);
    expect(pick.ok).toBe(false);
  });

  it("refuses an ambiguous directory rather than picking one", () => {
    const pick = pickSpikeGguf(["a-q4_0.gguf", "b-q4_0.gguf"]);
    expect(pick.ok).toBe(false);
    expect(pick.ok === false && pick.reason).toMatch(/leave exactly one/);
  });

  it("ignores an mmproj companion beside the weights", () => {
    const pick = pickSpikeGguf([
      "gemma-4-E2B-it-q4_0.gguf",
      "mmproj-gemma-4-E2B-f16.gguf",
      "README.md",
    ]);
    expect(pick).toMatchObject({ ok: true, file: "gemma-4-E2B-it-q4_0.gguf" });
  });

  it("says so when there is nothing there", () => {
    expect(pickSpikeGguf([]).ok).toBe(false);
    expect(pickSpikeGguf(["README.md"]).ok).toBe(false);
  });
});

describe("the registry row", () => {
  const bundle: NpuBundleInfo = {
    modelName: "local/gemma-4-e2b-it-q4_0",
    modelPath: "/files/geniex/models/local/gemma/gemma-4-E2B-it-q4_0.gguf",
    modelDir: "/files/geniex/models/local/gemma",
    tokenizerPath: null,
    runtimeId: "llama_cpp",
    files: [
      { path: "gemma-4-E2B-it-q4_0.gguf", sizeBytes: 1_700_000_000 },
      { path: "geniex.json", sizeBytes: 812, sha256: "abc" },
    ],
    totalBytes: 1_700_000_812,
  };

  it("carries the three fields that route it", () => {
    const row = genieXImportedRow(bundle, {
      displayName: "gemma-4-E2B-it-q4_0",
      modelName: "local/gemma-4-e2b-it-q4_0",
    });
    expect(row.backend).toBe("geniex_llama_cpp");
    // It IS a GGUF. Saying otherwise would make every artifact rule lie.
    expect(row.artifact).toBe("gguf");
    // And this is what separates it from a GGUF Vesta downloaded itself.
    expect(row.runtimeModelName).toBe("local/gemma-4-e2b-it-q4_0");
  });

  it("records the MODEL FILE's size, not the directory total", () => {
    // Activation re-stats `filePath` and compares. A directory total would
    // include geniex.json and fail that check on every single load.
    const row = genieXImportedRow(bundle, {
      displayName: "g",
      modelName: "local/g",
    });
    expect(row.sizeBytes).toBe(1_700_000_000);
    expect(row.sizeBytes).not.toBe(bundle.totalBytes);
  });

  it("falls back to 0 rather than a wrong size", () => {
    const row = genieXImportedRow(
      { ...bundle, files: [] },
      { displayName: "g", modelName: "local/g" },
    );
    // Activation skips the size check at 0; a guess there would refuse the load.
    expect(row.sizeBytes).toBe(0);
  });

  it("records no bundle manifest, so Verify is never offered", () => {
    // Verify on this row would run the QAIRT bundle check, which demands
    // metadata.json and .bin shards and would reject a healthy GGUF.
    const row = genieXImportedRow(bundle, {
      displayName: "g",
      modelName: "local/g",
    });
    expect(row.bundleFiles).toEqual([]);
  });

  it("is ready, and honest about its trust", () => {
    const row = genieXImportedRow(bundle, {
      displayName: "g",
      modelName: "local/g",
    });
    expect(row.state).toBe("ready");
    expect(row.trust).toBe("unverified");
    expect(row.quant).toBe("Q4_0");
  });
});
