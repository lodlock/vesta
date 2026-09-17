// Where a checksum for a locally imported model can come from.

import * as FileSystem from "expo-file-system/legacy";
import { parseSha256File, readAdjacentChecksum } from "../integrity";

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

const mockFS = FileSystem as jest.Mocked<typeof FileSystem>;
const SHA = "a".repeat(64);

beforeEach(() => jest.clearAllMocks());

describe("parseSha256File", () => {
  it("reads the sha256sum format", () => {
    expect(parseSha256File(`${SHA}  my-model.gguf\n`)).toBe(SHA);
  });

  it("reads bare hex, any case, with stray whitespace", () => {
    expect(parseSha256File(`  ${SHA.toUpperCase()}  `)).toBe(SHA);
  });

  it("returns null for anything that isn't a sha256", () => {
    expect(parseSha256File("")).toBeNull();
    expect(parseSha256File(null)).toBeNull();
    expect(parseSha256File("not a hash")).toBeNull();
    expect(parseSha256File("a".repeat(63))).toBeNull(); // too short
    expect(parseSha256File("a".repeat(40))).toBeNull(); // a git sha, not a sha256
  });
});

describe("readAdjacentChecksum", () => {
  it("finds <file>.sha256 next to a file:// URI", async () => {
    mockFS.getInfoAsync.mockImplementation(async (p: string) =>
      p === "file:///m/model.gguf.sha256"
        ? ({ exists: true, size: 80 } as never)
        : ({ exists: false } as never),
    );
    mockFS.readAsStringAsync.mockResolvedValue(`${SHA}  model.gguf`);

    expect(await readAdjacentChecksum("file:///m/model.gguf")).toBe(SHA);
  });

  it("also tries the <name>.sha256 spelling", async () => {
    mockFS.getInfoAsync.mockImplementation(async (p: string) =>
      p === "file:///m/model.sha256"
        ? ({ exists: true, size: 70 } as never)
        : ({ exists: false } as never),
    );
    mockFS.readAsStringAsync.mockResolvedValue(SHA);

    expect(await readAdjacentChecksum("file:///m/model.gguf")).toBe(SHA);
  });

  it("does not try for a SAF content:// URI, which has no neighbours", async () => {
    expect(await readAdjacentChecksum("content://com.android.providers/doc/42")).toBeNull();
    expect(mockFS.getInfoAsync).not.toHaveBeenCalled();
  });

  it("ignores a file too large to be a checksum", async () => {
    mockFS.getInfoAsync.mockResolvedValue({ exists: true, size: 50_000 } as never);
    expect(await readAdjacentChecksum("file:///m/model.gguf")).toBeNull();
    expect(mockFS.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("treats an unreadable neighbour as simply absent", async () => {
    mockFS.getInfoAsync.mockResolvedValue({ exists: true, size: 80 } as never);
    mockFS.readAsStringAsync.mockRejectedValue(new Error("EACCES"));
    expect(await readAdjacentChecksum("file:///m/model.gguf")).toBeNull();
  });
});

// ── What the card is allowed to say ─────────────────────────────────────────
//
// The sentence that started this: a locally imported GGUF displayed "No
// checksum on record" and was read as a refusal. It was not one — nothing in
// Vesta gates on trust (see models/activation.ts) — but it was the only visible
// difference between that model and a working one, so it looked like the cause.
//
// It was also the wrong sentence. "No checksum on record" describes a MISSING
// EXTERNAL DIGEST, and for a file the user supplied there is no external digest
// to be missing: none was ever published, and none ever will be. Describing a
// permanent property of the path as an absence made it read as a fault.
//
// So provenance is answered as three separate questions, and the third one is
// almost always "no" — which is the point. An authenticity line that reads
// "Not independently verified" on nearly every model stops looking like this
// particular model's problem, which is exactly what it is not.

import { describeProvenance } from "../integrity";
import type { InstalledModel } from "../types";

const DIGEST = "a".repeat(64);

type Shape = Pick<InstalledModel, "trust" | "sha256" | "hfRepo"> &
  Partial<Pick<InstalledModel, "bundleFiles">>;

const model = (over: Partial<Shape> = {}): Shape => ({
  trust: "unverified",
  sha256: null,
  hfRepo: null,
  ...over,
});

describe("a locally imported file with a computed baseline", () => {
  const p = describeProvenance(
    model({ trust: "user_supplied_baseline", sha256: DIGEST }),
  );

  it("names the source as local, the integrity as a baseline", () => {
    expect(p.source).toBe("Local file");
    expect(p.integrity).toBe("Verified against local import baseline");
  });

  it("says plainly that authenticity is NOT established", () => {
    // The load-bearing line. A digest computed over bytes you were handed
    // cannot identify who produced them, and the card must not imply it does.
    expect(p.authenticity).toBe("Not independently verified");
  });

  it("never reads as 'no checksum'", () => {
    // There IS a checksum on record for this model. That was the false part.
    expect(p.integrity).not.toMatch(/no checksum/i);
  });
});

describe("the stronger claims stay distinct", () => {
  it("credits a repository digest to the repository", () => {
    const p = describeProvenance(
      model({ trust: "verified_upstream", sha256: DIGEST, hfRepo: "unsloth/Qwen3-4B" }),
    );
    expect(p.source).toBe("unsloth/Qwen3-4B");
    expect(p.integrity).toMatch(/published by the source/i);
    // The one case where something independent of this device signed off.
    expect(p.authenticity).toBe("Digest supplied by unsloth/Qwen3-4B");
    expect(p.authenticity).not.toMatch(/not independently/i);
  });

  it("credits a digest the user supplied to the user, and no further", () => {
    const p = describeProvenance(
      model({ trust: "verified_user_checksum", sha256: DIGEST }),
    );
    expect(p.integrity).toMatch(/SHA-256 you supplied/);
    // Stronger than a self-computed baseline — a digest from outside the bytes
    // — but the witness is the user, not an independent party.
    expect(p.authenticity).toMatch(/vouched for by you/i);
    expect(p.authenticity).toMatch(/not independently verified/i);
  });

  it("gives three different integrity sentences to three different claims", () => {
    const said = (
      [
        "verified_upstream",
        "verified_user_checksum",
        "user_supplied_baseline",
      ] as const
    ).map((trust) => describeProvenance(model({ trust, sha256: DIGEST })).integrity);
    expect(new Set(said).size).toBe(3);
  });
});

describe("unverified covers two different situations", () => {
  it("says a baseline exists when one does", () => {
    // verifyIntegrity() records a digest for a model whose repository publishes
    // none. Calling that "no checksum on record" was simply false.
    const p = describeProvenance(model({ trust: "unverified", sha256: DIGEST }));
    expect(p.integrity).toMatch(/baseline recorded locally/i);
    expect(p.authenticity).toBe("Not independently verified");
  });

  it("says so, and says what it costs, when there is genuinely nothing", () => {
    const p = describeProvenance(model({ trust: "unverified", sha256: null }));
    expect(p.integrity).toMatch(/no checksum on record/i);
    // Named as a consequence rather than left as a bare verdict.
    expect(p.integrity).toMatch(/would not be detected/i);
  });

  it("credits a bundle manifest, which is a real recorded check", () => {
    // A QAIRT bundle carries per-file sizes and digests for the small files.
    // Weaker than an upstream digest, and not nothing — and this must not
    // weaken what verifyNpuBundle() actually checks, only describe it.
    const p = describeProvenance(
      model({
        trust: "unverified",
        sha256: null,
        bundleFiles: [{ path: "metadata.json", sha256: "abc", sizeBytes: 812 }],
      }),
    );
    expect(p.integrity).toMatch(/file manifest recorded at install/i);
    expect(p.authenticity).toBe("Not independently verified");
  });
});

describe("every model gets all three lines", () => {
  it("never leaves one blank, whatever the trust level", () => {
    for (const trust of [
      "verified_upstream",
      "verified_user_checksum",
      "user_supplied_baseline",
      "unverified",
    ] as const) {
      for (const sha256 of [DIGEST, null]) {
        const p = describeProvenance(model({ trust, sha256 }));
        expect(p.source.length).toBeGreaterThan(0);
        expect(p.integrity.length).toBeGreaterThan(0);
        expect(p.authenticity.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to 'Local file' when no repository is recorded", () => {
    expect(describeProvenance(model({ hfRepo: null })).source).toBe("Local file");
    expect(describeProvenance(model({ hfRepo: "   " })).source).toBe("Local file");
  });
});
