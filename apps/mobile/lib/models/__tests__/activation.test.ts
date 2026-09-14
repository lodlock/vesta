// Who may become the active chat model.
//
// The regression this exists for: two models downloaded before the trust
// migration showed "No checksum on record" and lost their Use button. The
// checksum was NOT the cause — nothing gates on trust — but with no other
// difference on screen it looked like it was. These tests pin both halves: the
// things that DO block activation, and the thing that must never start to.

import { canActivate, canVerify } from "../activation";
import type { InstalledModel, ModelRole, DownloadStatus, ModelTrust } from "../types";

function model(overrides: Partial<InstalledModel> = {}): InstalledModel {
  return {
    id: "m1",
    displayName: "Qwen3 4B Instruct (2507)",
    hfRepo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    hfFile: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    filePath: "file:///docs/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeBytes: 2_500_000_000,
    minRamMb: 4096,
    chatTemplate: null,
    contextSize: 4096,
    role: "primary" as ModelRole,
    state: "ready" as DownloadStatus,
    resumeToken: null,
    sha256: null,
    trust: "unverified" as ModelTrust,
    isActive: false,
    createdAt: 0,
    ...overrides,
  };
}

describe("trust never blocks activation", () => {
  it("allows a legacy download that migration v4 backfilled to unverified", () => {
    // Exactly the 4B/8B rows: downloaded before verification existed, so no
    // digest on record — and still perfectly usable.
    expect(canActivate(model({ trust: "unverified", sha256: null }))).toEqual({ ok: true });
  });

  it("allows every trust level", () => {
    for (const trust of [
      "verified_upstream",
      "verified_user_checksum",
      "user_supplied_baseline",
      "unverified",
    ] as ModelTrust[]) {
      expect(canActivate(model({ trust })).ok).toBe(true);
    }
  });
});

describe("what does block activation", () => {
  it("refuses a model that isn't ready, and names the way out", () => {
    const check = canActivate(model({ state: "error" }));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("not-ready");
      expect(check.message).toMatch(/verif/i);
    }
  });

  it("refuses one still downloading or paused", () => {
    expect(canActivate(model({ state: "downloading" }))).toMatchObject({
      ok: false,
      reason: "downloading",
    });
    expect(canActivate(model({ state: "paused" }))).toMatchObject({
      ok: false,
      reason: "downloading",
    });
  });

  it("refuses an EMBEDDING model as the chat model", () => {
    // Nomic Embed offered a "Use this model" button. Activating it would load
    // an embedding model into the chat context — a loaded model that cannot
    // answer anything.
    const check = canActivate(model({ role: "embedding", displayName: "Nomic Embed" }));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("wrong-role");
      expect(check.message).toMatch(/document search/i);
    }
  });

  it("refuses a router model too", () => {
    expect(canActivate(model({ role: "router" }))).toMatchObject({
      ok: false,
      reason: "wrong-role",
    });
  });
});

describe("canVerify", () => {
  it("offers verification for a repo-backed model with no digest yet", () => {
    // The remediation path for the legacy rows: there is a repo to ask.
    expect(canVerify(model({ sha256: null }))).toBe(true);
  });

  it("offers it for a local import with a recorded digest", () => {
    expect(canVerify(model({ hfRepo: null, hfFile: null, sha256: "a".repeat(64) }))).toBe(
      true,
    );
  });

  it("offers nothing when there is neither a digest nor a source", () => {
    expect(canVerify(model({ hfRepo: null, hfFile: null, sha256: null }))).toBe(false);
  });

  it("offers nothing mid-download", () => {
    expect(canVerify(model({ state: "downloading" }))).toBe(false);
  });
});
