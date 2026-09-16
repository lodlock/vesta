// What must be true of a context bundle before anything tries to load it.
//
// These rules are the difference between "several gigabytes downloaded" and "a
// load that fails in a way nobody can read". Every required file here is
// required because the GenieX runtime says so in its own error messages — see
// the header of npu-bundle.ts, which quotes them — so these tests are pinning
// the runtime's contract, not a guess at it.

import {
  checkBundle,
  verifyAgainstBaseline,
  toBundleFiles,
  bundleIsolatedFromGguf,
  type MeasuredBundle,
  type MeasuredFile,
} from "../npu-bundle";

const file = (path: string, sizeBytes = 1024, sha256?: string): MeasuredFile => ({
  path,
  sizeBytes,
  ...(sha256 ? { sha256 } : {}),
});

const bundle = (over: Partial<MeasuredBundle> = {}): MeasuredBundle => ({
  modelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
  modelPath: "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3/model",
  modelDir: "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3",
  tokenizerPath: "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3/tokenizer.json",
  runtimeId: "qairt",
  files: [
    file("metadata.json", 4_096, "a".repeat(64)),
    file("tokenizer.json", 2_500_000, "b".repeat(64)),
    file("tokenizer_config.json", 8_192, "c".repeat(64)),
    file("weights_1.bin", 1_200_000_000),
    file("weights_2.bin", 1_200_000_000),
  ],
  totalBytes: 2_402_514_288,
  ...over,
});

describe("a complete bundle", () => {
  it("is accepted, with nothing to warn about", () => {
    const check = checkBundle(bundle());
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([]);
  });

  it("is still accepted when the manifest names no runtime", () => {
    // Absent is not "wrong runtime" — it is the manager declining to say, and
    // the load-time check on the native side covers it.
    expect(checkBundle(bundle({ runtimeId: null })).ok).toBe(true);
  });
});

describe("refusals, before a load is attempted", () => {
  const refusal = (b: MeasuredBundle) => {
    const check = checkBundle(b);
    if (check.ok) throw new Error("expected a refusal");
    return check;
  };

  it("refuses a llama.cpp model that came through the same manager", () => {
    // The dangerous case: GenieX would happily run this, on its own CPU
    // plugin, while everything downstream said NPU.
    const check = refusal(bundle({ runtimeId: "llama_cpp" }));
    expect(check.reason).toBe("not-qairt");
    expect(check.message).toContain("llama_cpp");
  });

  it("refuses a bundle with no metadata.json", () => {
    const files = bundle().files.filter((f) => f.path !== "metadata.json");
    expect(refusal(bundle({ files })).reason).toBe("missing-metadata");
  });

  it("refuses a bundle with no weight shards", () => {
    const files = bundle().files.filter((f) => !f.path.endsWith(".bin"));
    expect(refusal(bundle({ files })).reason).toBe("missing-shards");
  });

  it("refuses a bundle with no tokenizer", () => {
    const files = bundle().files.filter((f) => f.path !== "tokenizer.json");
    expect(refusal(bundle({ files })).reason).toBe("missing-tokenizer");
  });

  it("refuses a zero-length file", () => {
    // The signature of a pull that stopped between creating a file and
    // writing it. The runtime would read it as a corrupt shard.
    const files = [...bundle().files.slice(0, -1), file("weights_2.bin", 0)];
    const check = refusal(bundle({ files }));
    expect(check.reason).toBe("zero-length-file");
    expect(check.message).toContain("weights_2.bin");
  });

  it("refuses an empty directory", () => {
    expect(refusal(bundle({ files: [] })).reason).toBe("empty");
  });
});

describe("a missing tokenizer_config.json warns rather than refusing", () => {
  // It is needed to render a chat template, but whether every AI Hub bundle
  // ships one could not be verified — and rejecting a bundle that might be
  // fine costs the user the whole download. So the warning names the exact
  // symptom instead.
  const files = bundle().files.filter((f) => f.path !== "tokenizer_config.json");
  const check = checkBundle(bundle({ files }));

  it("still accepts the bundle", () => {
    expect(check.ok).toBe(true);
  });

  it("says what will go wrong if it turns out to matter", () => {
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toContain("tokenizer_config.json");
    expect(check.warnings[0]).toMatch(/chat template/i);
  });
});

describe("re-checking against the install baseline", () => {
  const recorded = toBundleFiles(bundle().files);

  it("passes when nothing has changed", () => {
    const result = verifyAgainstBaseline(recorded, bundle().files);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("counts what was actually checked, separately from what wasn't", () => {
    // The honest number. Three small files carry a digest; the two multi-GB
    // shards were never hashed, so they are checked by size only and the
    // count says so instead of implying a full verification.
    const result = verifyAgainstBaseline(recorded, bundle().files);
    expect(result.checked).toBe(3);
    expect(result.unchecked).toBe(2);
  });

  it("catches a shard that changed size", () => {
    const changed = bundle().files.map((f) =>
      f.path === "weights_1.bin" ? file("weights_1.bin", 999) : f,
    );
    const result = verifyAgainstBaseline(recorded, changed);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("weights_1.bin");
  });

  it("catches a small file whose contents changed", () => {
    const changed = bundle().files.map((f) =>
      f.path === "metadata.json" ? file("metadata.json", 4_096, "d".repeat(64)) : f,
    );
    const result = verifyAgainstBaseline(recorded, changed);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/metadata\.json.*SHA-256/);
  });

  it("catches a file that has gone", () => {
    const missing = bundle().files.filter((f) => f.path !== "tokenizer.json");
    const result = verifyAgainstBaseline(recorded, missing);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("tokenizer.json is missing");
  });

  it("catches a file that appeared afterwards", () => {
    // A bundle is meant to be one unit. Something that was not installed with
    // it is not automatically malicious, but it is not accounted for either.
    const extra = [...bundle().files, file("stray.bin", 10)];
    const result = verifyAgainstBaseline(recorded, extra);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("stray.bin");
  });
});

describe("an NPU install cannot reach a GGUF", () => {
  const geniex = "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3";
  const models = "/data/user/0/com.cosmico.vesta/files/models";

  it("keeps the two trees apart", () => {
    expect(bundleIsolatedFromGguf(geniex, models)).toBe(true);
  });

  it("rejects a bundle dir that contains the GGUF dir, or vice versa", () => {
    expect(bundleIsolatedFromGguf("/files", "/files/models")).toBe(false);
    expect(bundleIsolatedFromGguf("/files/geniex", "/files")).toBe(false);
    expect(bundleIsolatedFromGguf(models, models)).toBe(false);
  });

  it("is not fooled by a trailing slash", () => {
    expect(bundleIsolatedFromGguf(`${geniex}/`, `${models}/`)).toBe(true);
    expect(bundleIsolatedFromGguf("/files/", "/files")).toBe(false);
  });
});

// The manager's own bookkeeping, against the zero-length payload rule.
//
// On a real device GenieX pulled the full 2.38 GB bundle and reported
// `pull() returned rc=0`; `getPaths()` then resolved, which is the manager's
// own completion test. The install was rejected anyway, and the bundle
// deleted, because the bundle directory also holds GenieX's zero-byte `.lock`
// — zero bytes by design, since an advisory lock lives in the kernel and not
// in the file (`libgeniex.so` imports `flock` and carries the literals
// `.lock`, `.inflight` and `.progress`).
//
// The exemption is those three names and nothing else. Everything below is
// about keeping that line exactly where it is.
describe("GenieX's own bookkeeping, against the zero-length rule", () => {
  const refusal = (b: MeasuredBundle) => {
    const check = checkBundle(b);
    if (check.ok) throw new Error("expected a refusal");
    return check;
  };

  // A: the case that cost 2.38 GB.
  it("accepts a complete bundle whose .lock is empty", () => {
    const check = checkBundle(
      bundle({ files: [file(".lock", 0), ...bundle().files] }),
    );
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([]);
  });

  it("accepts the other two bookkeeping names on the same terms", () => {
    for (const name of [".inflight", ".progress"]) {
      expect(
        checkBundle(bundle({ files: [file(name, 0), ...bundle().files] })).ok,
      ).toBe(true);
    }
  });

  // B: the protection the rule exists for, unchanged. An empty shard is a
  // truncated download and must still fail, lock present or not.
  it("still refuses a zero-byte .bin shard", () => {
    const files = [
      file(".lock", 0),
      ...bundle().files.slice(0, -1),
      file("weights_2.bin", 0),
    ];
    const check = refusal(bundle({ files }));
    expect(check.reason).toBe("zero-length-file");
    expect(check.message).toContain("weights_2.bin");
  });

  it("still refuses a zero-byte metadata.json or tokenizer.json", () => {
    for (const required of ["metadata.json", "tokenizer.json"]) {
      const files = [
        file(".lock", 0),
        ...bundle().files.filter((f) => f.path !== required),
        file(required, 0),
      ];
      const check = refusal(bundle({ files }));
      expect(check.reason).toBe("zero-length-file");
      expect(check.message).toContain(required);
    }
  });

  // C: no dotfile heuristic. An empty file we have never seen is not evidence
  // of anything, and passing it would give back the protection above.
  it("does not exempt an arbitrary empty dotfile", () => {
    const check = refusal(
      bundle({ files: [file(".DS_Store", 0), ...bundle().files] }),
    );
    expect(check.reason).toBe("zero-length-file");
    expect(check.message).toContain(".DS_Store");
  });

  it("does not exempt an arbitrary empty non-dotfile", () => {
    expect(
      refusal(bundle({ files: [file("notes.txt", 0), ...bundle().files] }))
        .reason,
    ).toBe("zero-length-file");
  });

  // Exact names, not substrings and not case-folded: the literals came out of
  // the binary, and widening them would be inventing a rule GenieX never made.
  it("matches the names exactly", () => {
    for (const near of [".locked", "lock", ".LOCK", ".lock.bak", "my.progress.log"]) {
      expect(
        refusal(bundle({ files: [file(near, 0), ...bundle().files] })).reason,
      ).toBe("zero-length-file");
    }
  });

  // The manager writes its lock beside the weights; a path is still matched on
  // its basename so a nested bundle layout behaves the same way.
  it("recognises the lock wherever in the bundle it sits", () => {
    expect(
      checkBundle(bundle({ files: [file("sub/.lock", 0), ...bundle().files] })).ok,
    ).toBe(true);
  });
});
