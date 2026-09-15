// Whether what landed on disk is a Qualcomm context bundle we can actually run.
//
// Pure functions over the file listing the native side measured, so every rule
// here is testable without a Qualcomm device — which matters, because these are
// the rules that stand between "several gigabytes downloaded" and "a load that
// fails in a way nobody can read".
//
// ## What a QAIRT LLM bundle contains
//
// Not guessed. The GenieX runtime states its own accepted layouts in the error
// it raises when none matches:
//
//   "did not match any known layout: expected a directory with *.gguf (HF
//    GGUF), a directory with metadata.json + *.bin (AI Hub extracted), or a
//    .zip file (AI Hub archive)"
//
// and the QAIRT plugin adds the rest of the requirements in its own messages:
//
//   "dispatch: cannot read metadata.json: {}"      → metadata.json is required
//   "dispatch: no LLM factory matches model_id"    → …and names the model family
//   "No .bin LLM shards found in: {}"              → at least one weight shard
//   "tokenizer.json not found in: {}"              → the tokenizer, beside them
//
// So: `metadata.json` + one or more `*.bin` + `tokenizer.json`. Those three are
// hard requirements and a bundle missing any of them is rejected before a load
// is attempted.
//
// `tokenizer_config.json` is a fourth file, and is treated differently on
// purpose. The text-processing library asks for it by name — "no chat template
// loaded (pass tokenizer_config_path to from_file())" — so without it
// applyChatTemplate cannot render a prompt. But whether every AI Hub bundle
// ships one could not be verified from outside, and rejecting a bundle that
// might be fine would cost the user the whole download. It is therefore
// recorded as a WARNING with its exact symptom, not a refusal.
//
// ## What "verified" means here, and what it does not
//
// GenieX publishes no per-file digest for these bundles, so nothing can be
// verified against an upstream source the way a HuggingFace GGUF is. What is
// available is a baseline: real sizes for every file, and a SHA-256 for the
// small ones (the multi-GB shards are not hashed — it would take minutes on the
// phone and there is nothing to compare the result against anyway). That is
// integrity FROM INSTALL ONWARDS and is labelled as exactly that — the
// `user_supplied_baseline` trust level the local-GGUF import already uses.

import type { BundleFile } from "./types";

/** One file of a bundle, as the native side measured it. */
export interface MeasuredFile {
  path: string;
  sizeBytes: number;
  sha256?: string | null;
}

export interface MeasuredBundle {
  modelName: string;
  modelPath: string;
  modelDir: string;
  tokenizerPath?: string | null;
  /** The manifest's runtime id. "qairt" for a real NPU bundle. */
  runtimeId: string | null;
  files: MeasuredFile[];
  totalBytes: number;
}

export type BundleRejection =
  | "empty" // nothing on disk
  | "not-qairt" // the manifest says this is for another runtime
  | "missing-metadata" // no metadata.json
  | "missing-shards" // no *.bin weight shards
  | "missing-tokenizer" // no tokenizer.json
  | "zero-length-file" // a file is there but empty — a truncated pull
  | "digest-mismatch"; // a recorded digest no longer matches

export type BundleCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: BundleRejection; message: string; warnings: string[] };

const METADATA = "metadata.json";
const TOKENIZER = "tokenizer.json";
const TOKENIZER_CONFIG = "tokenizer_config.json";

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function has(files: MeasuredFile[], name: string): boolean {
  return files.some((f) => baseName(f.path).toLowerCase() === name);
}

/**
 * Is this a complete, runnable QAIRT bundle?
 *
 * Fails closed on every missing piece. The alternative — attempt the load and
 * let the runtime say — spends 20+ seconds and an out-of-memory risk to learn
 * something a directory listing already knew.
 */
export function checkBundle(bundle: MeasuredBundle): BundleCheck {
  const warnings: string[] = [];

  if (!bundle.files || bundle.files.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "The download produced no files.",
      warnings,
    };
  }

  // The manifest's own word. A llama.cpp GGUF pulled through the same model
  // manager would arrive here looking superficially similar, and GenieX would
  // run it — on the CPU, while everything downstream said "NPU".
  if (bundle.runtimeId && bundle.runtimeId !== "qairt") {
    return {
      ok: false,
      reason: "not-qairt",
      message: `${bundle.modelName} is a ${bundle.runtimeId} model, not a Qualcomm AI Engine Direct bundle.`,
      warnings,
    };
  }

  if (!has(bundle.files, METADATA)) {
    return {
      ok: false,
      reason: "missing-metadata",
      message:
        "This bundle has no metadata.json, so the runtime cannot tell which model it is. " +
        "The download is incomplete.",
      warnings,
    };
  }

  const shards = bundle.files.filter((f) => f.path.toLowerCase().endsWith(".bin"));
  if (shards.length === 0) {
    return {
      ok: false,
      reason: "missing-shards",
      message: "This bundle has no .bin weight shards. The download is incomplete.",
      warnings,
    };
  }

  if (!has(bundle.files, TOKENIZER)) {
    return {
      ok: false,
      reason: "missing-tokenizer",
      message: "This bundle has no tokenizer.json, so it cannot turn text into tokens.",
      warnings,
    };
  }

  // A zero-length file is the signature of a pull that stopped between creating
  // a file and writing it. The runtime would read it as a corrupt shard.
  const empty = bundle.files.find((f) => f.sizeBytes <= 0);
  if (empty) {
    return {
      ok: false,
      reason: "zero-length-file",
      message: `${empty.path} is empty — the download did not finish.`,
      warnings,
    };
  }

  if (!has(bundle.files, TOKENIZER_CONFIG)) {
    // Named with its symptom, so a failure later is recognisable rather than
    // mysterious. See the header for why this is a warning and not a refusal.
    warnings.push(
      "No tokenizer_config.json in this bundle. If replies come back empty or " +
        "the chat template fails, that is why.",
    );
  }

  return { ok: true, warnings };
}

/**
 * Re-checks an installed bundle against what was recorded at install.
 *
 * This is the NPU equivalent of Models → Verify. It cannot appeal to an
 * upstream digest — there is none — so it compares against the baseline: every
 * recorded size must still match, and every recorded digest must still match.
 * A file that has grown, shrunk or changed is reported; a file for which
 * nothing was recorded is reported as unchecked rather than as a pass.
 */
export function verifyAgainstBaseline(
  recorded: BundleFile[],
  measured: MeasuredFile[],
): {
  ok: boolean;
  checked: number;
  unchecked: number;
  problems: string[];
} {
  const problems: string[] = [];
  let checked = 0;
  let unchecked = 0;

  const byPath = new Map(measured.map((f) => [f.path, f]));

  for (const want of recorded) {
    const got = byPath.get(want.path);
    if (!got) {
      problems.push(`${want.path} is missing.`);
      continue;
    }
    if (want.sizeBytes !== undefined && want.sizeBytes !== got.sizeBytes) {
      problems.push(
        `${want.path} is ${got.sizeBytes} bytes; ${want.sizeBytes} was recorded.`,
      );
      continue;
    }
    if (want.sha256) {
      checked++;
      if (got.sha256 && got.sha256.toLowerCase() !== want.sha256.toLowerCase()) {
        problems.push(`${want.path} no longer matches its recorded SHA-256.`);
      } else if (!got.sha256) {
        // Recorded with a digest, measured without one. Say so rather than
        // letting a size-only match read as a full check.
        unchecked++;
      }
    } else {
      unchecked++;
    }
  }

  // A file that appeared after install is not automatically wrong, but it is
  // not something we recorded either, and the bundle is meant to be one unit.
  for (const got of measured) {
    if (!recorded.some((r) => r.path === got.path)) {
      problems.push(`${got.path} was not part of the installed bundle.`);
    }
  }

  return { ok: problems.length === 0, checked, unchecked, problems };
}

/** The manifest to store on the registry row: real sizes, digests where taken. */
export function toBundleFiles(measured: MeasuredFile[]): BundleFile[] {
  return measured.map((f) => ({
    path: f.path,
    sha256: f.sha256 ?? null,
    sizeBytes: f.sizeBytes,
  }));
}

/**
 * Whether an NPU install could possibly disturb a GGUF.
 *
 * It cannot, and this states why in one checkable place rather than as a
 * comment: GenieX keeps its bundles under its own data directory
 * (`filesDir/geniex/...`), Vesta keeps `.gguf` files under the models
 * directory, and neither path is ever derived from the other. An NPU install
 * never writes outside its own directory, so a failed one cannot truncate,
 * overwrite or delete a working GGUF — the failure path removes the bundle
 * directory and nothing else.
 */
export function bundleIsolatedFromGguf(
  bundleDir: string,
  ggufDir: string,
): boolean {
  const a = bundleDir.replace(/\/+$/, "");
  const b = ggufDir.replace(/\/+$/, "");
  if (!a || !b) return false;
  return !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`) && a !== b;
}
