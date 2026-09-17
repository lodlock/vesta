// Checksum sourcing for locally imported models.
//
// A local .gguf the user picked themselves has no upstream digest, but the user
// often DOES have one — printed on the page they downloaded it from, or sitting
// next to the file as `model.gguf.sha256` from `sha256sum`. When they have one
// we verify against it and the import is as strong as a HuggingFace download;
// when they don't, the import still proceeds (choosing the file is the trust
// decision) and we hash it anyway as a baseline.

import * as FileSystem from "expo-file-system/legacy";
import { normalizeSha256 } from "../native/file-hash";
import type { InstalledModel, ModelTrust } from "./types";

// Pure: pull a sha256 out of whatever the user pasted or a `.sha256` file
// holds. `sha256sum` writes "<hex>  <filename>"; people also paste bare hex,
// or hex with spaces from a web page.
export function parseSha256File(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /\b[0-9a-fA-F]{64}\b/.exec(text.replace(/\s+/g, " "));
  return match ? normalizeSha256(match[0]) : null;
}

// Best-effort: a `.sha256` sitting next to the picked file. Only possible for a
// `file://` URI — a Storage Access Framework `content://` URI addresses one
// document, with no way to look at its neighbours, so this simply finds nothing
// there and the caller falls back to whatever the user typed.
export async function readAdjacentChecksum(uri: string): Promise<string | null> {
  if (!uri.startsWith("file://")) return null;
  const candidates = [`${uri}.sha256`, uri.replace(/\.gguf$/i, ".sha256")];
  for (const candidate of candidates) {
    try {
      const info = await FileSystem.getInfoAsync(candidate);
      // A checksum file is a line or two; anything big isn't one.
      if (!info.exists || (info.size ?? 0) > 4096) continue;
      const parsed = parseSha256File(await FileSystem.readAsStringAsync(candidate));
      if (parsed) return parsed;
    } catch {
      // Unreadable neighbour — not an error, just no checksum from here.
    }
  }
  return null;
}

// ── What a model card may claim about a file ─────────────────────────────────
//
// Three questions get collapsed into the word "verified", and collapsing them
// is how a file nobody checked ends up looking vouched for — and, in the other
// direction, how a perfectly good file the user supplied themselves ends up
// reading as broken. Both happened here: a locally imported GGUF said "No
// checksum on record", which is a sentence about a MISSING EXTERNAL DIGEST, and
// was reasonably read as "Vesta will not use this".
//
// So they are answered separately and always all three:
//
//   source        where the bytes came from.
//   integrity     what a digest comparison can currently establish about them.
//   authenticity  whether anyone independent of this device vouched for them.
//
// The last one is almost always "no", and saying so plainly is the point. A
// digest Vesta computed over a file it was handed proves the file has not
// changed since; it cannot prove who built it, because the only witness to
// that is the file itself.
//
// Nothing here gates anything. See models/activation.ts: trust labels a model,
// it never blocks it.

export interface Provenance {
  source: string;
  integrity: string;
  authenticity: string;
}

/** Nothing outside this device attested to these bytes. The usual case. */
const NOT_INDEPENDENT = "Not independently verified";

export function describeProvenance(
  model: Pick<InstalledModel, "trust" | "sha256" | "hfRepo"> &
    Partial<Pick<InstalledModel, "bundleFiles">>,
): Provenance {
  const repo = model.hfRepo?.trim() || null;
  const source = repo ?? "Local file";
  const trust: ModelTrust = model.trust;

  if (trust === "verified_upstream") {
    return {
      source,
      integrity: "Verified against the SHA-256 published by the source",
      // The one case where something independent of this device signed off:
      // the digest came from the repository, not from the bytes in hand.
      authenticity: repo
        ? `Digest supplied by ${repo}`
        : "Digest supplied by the source",
    };
  }

  if (trust === "verified_user_checksum") {
    return {
      source,
      integrity: "Verified against the SHA-256 you supplied",
      // The user is the witness. That is a real claim and a stronger one than
      // a self-computed baseline — but it is theirs, not an independent
      // party's, and the difference is worth keeping visible.
      authenticity: `Vouched for by you — ${NOT_INDEPENDENT.toLowerCase()}`,
    };
  }

  if (trust === "user_supplied_baseline") {
    return {
      source,
      integrity: "Verified against local import baseline",
      authenticity: NOT_INDEPENDENT,
    };
  }

  // unverified — which covers two genuinely different situations, and the one
  // sentence they used to share was wrong about at least one of them.
  if (model.sha256) {
    // A digest IS on record; what is missing is a source digest to check it
    // against. Saying "no checksum on record" here was simply false.
    return {
      source,
      integrity: "Baseline recorded locally — a later change is detectable",
      authenticity: NOT_INDEPENDENT,
    };
  }
  if (model.bundleFiles && model.bundleFiles.length > 0) {
    // A multi-file bundle carries its own recorded manifest — per-file sizes,
    // plus digests for the small files. Weaker than an upstream digest, and
    // not nothing.
    return {
      source,
      integrity: "Checked against the file manifest recorded at install",
      authenticity: NOT_INDEPENDENT,
    };
  }
  return {
    source,
    integrity: "No checksum on record — a later change would not be detected",
    authenticity: NOT_INDEPENDENT,
  };
}
