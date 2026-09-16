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

// The same bookkeeping, against Verify.
//
// The zero-byte exemption was only half the problem. GenieX keeps writing
// `.lock`, `.inflight` and `.progress` for as long as the bundle exists — the
// lock is taken and released around each operation, `.progress` is truncated
// and rewritten, and both vanish once the manager is idle — so comparing them
// like payload turns ordinary manager activity into "this model has changed
// since it was installed", which errors the row and takes a good multi-GB
// bundle out of activation.
//
// So they are dropped from both sides of the comparison, and from the baseline
// itself. Payload is compared exactly as strictly as before.
describe("GenieX's own bookkeeping, against Verify", () => {
  const withLock = [file(".lock", 0), ...bundle().files];

  it("is not recorded in the install baseline at all", () => {
    const recorded = toBundleFiles([
      ...withLock,
      file(".inflight", 0),
      file(".progress", 512),
    ]);
    expect(recorded.map((f) => f.path)).toEqual([
      "metadata.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "weights_1.bin",
      "weights_2.bin",
    ]);
  });

  // A: the lock was there when the baseline was taken and has since been
  // released. Nothing about the weights changed.
  it("passes when a .lock recorded at install has gone", () => {
    const result = verifyAgainstBaseline(toBundleFiles(withLock), bundle().files);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  // B: the manager re-took the lock, or rewrote it.
  it("passes when the .lock has changed size", () => {
    const changed = [file(".lock", 4_096, "e".repeat(64)), ...bundle().files];
    const result = verifyAgainstBaseline(toBundleFiles(withLock), changed);
    expect(result.ok).toBe(true);
  });

  // C: manager state that appears after install, or disappears mid-flight.
  it("passes when .inflight or .progress appear afterwards", () => {
    const appeared = [
      file(".inflight", 0),
      file(".progress", 1_024),
      ...bundle().files,
    ];
    const result = verifyAgainstBaseline(toBundleFiles(bundle().files), appeared);
    expect(result.ok).toBe(true);
  });

  it("passes when .inflight and .progress disappear afterwards", () => {
    const recorded = toBundleFiles([
      file(".inflight", 0),
      file(".progress", 1_024),
      ...bundle().files,
    ]);
    expect(verifyAgainstBaseline(recorded, bundle().files).ok).toBe(true);
  });

  it("does not count bookkeeping as something it checked", () => {
    // The number the user is shown is about the payload. Three digests, two
    // shards by size — the lock is neither.
    const result = verifyAgainstBaseline(toBundleFiles(withLock), withLock);
    expect(result.checked).toBe(3);
    expect(result.unchecked).toBe(2);
  });

  // D, E, F: the protection Verify exists for, unchanged, with the manager's
  // files present the whole time so the exemption cannot be hiding anything.
  it("still fails when a real payload file disappears", () => {
    const recorded = toBundleFiles(withLock);
    const gone = withLock.filter((f) => f.path !== "weights_2.bin");
    const result = verifyAgainstBaseline(recorded, gone);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("weights_2.bin is missing");
  });

  it("still fails when a real payload file changes", () => {
    const recorded = toBundleFiles(withLock);
    const changed = withLock.map((f) =>
      f.path === "metadata.json" ? file("metadata.json", 4_096, "f".repeat(64)) : f,
    );
    const result = verifyAgainstBaseline(recorded, changed);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/metadata\.json.*SHA-256/);
  });

  it("still fails when a real payload file is truncated to zero bytes", () => {
    const recorded = toBundleFiles(withLock);
    const truncated = withLock.map((f) =>
      f.path === "weights_1.bin" ? file("weights_1.bin", 0) : f,
    );
    const result = verifyAgainstBaseline(recorded, truncated);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("weights_1.bin is 0 bytes");
  });

  it("still fails when a real file appears that was not installed", () => {
    const recorded = toBundleFiles(withLock);
    const result = verifyAgainstBaseline(recorded, [...withLock, file("stray.bin", 10)]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("stray.bin");
  });

  // G: a baseline written by an older Vesta, which recorded the manager's
  // files as if they were payload. It is normalised on read rather than
  // rewritten, so nobody has to reinstall several gigabytes to escape it.
  describe("a baseline written before this rule", () => {
    const legacy = [
      { path: ".lock", sha256: null, sizeBytes: 0 },
      { path: ".progress", sha256: "0".repeat(64), sizeBytes: 128 },
      ...toBundleFiles(bundle().files),
    ];

    it("verifies cleanly once the manager's files are gone", () => {
      const result = verifyAgainstBaseline(legacy, bundle().files);
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("verifies cleanly when they are present but different", () => {
      const now = [file(".lock", 0), file(".progress", 4_096), ...bundle().files];
      expect(verifyAgainstBaseline(legacy, now).ok).toBe(true);
    });

    it("still enforces every payload entry it recorded", () => {
      const gone = bundle().files.filter((f) => f.path !== "tokenizer.json");
      const result = verifyAgainstBaseline(legacy, gone);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toContain("tokenizer.json is missing");
    });
  });

  // Same exact-name rule as the zero-byte exemption, because it is the same
  // predicate. A near-miss is payload and is verified like payload.
  it("does not extend the exemption to near-miss names", () => {
    const recorded = toBundleFiles([file(".lock.bak", 16), ...bundle().files]);
    const result = verifyAgainstBaseline(recorded, bundle().files);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain(".lock.bak is missing");
  });
});
