// Registering a side-loaded GGUF with the GenieX model manager. SPIKE.
//
// The whole point of this module is that there is no second import system. The
// GenieX model manager already accepts a local directory — `HubSource.LOCALFS`
// with `local_path` — and Vesta already drives that through `importBundle()`
// for QAIRT bundles, progress, cancel and all. This adds the GGUF-shaped
// arguments and the registry row, and nothing else.
//
// ## What LOCALFS accepts, and why the path is a DIRECTORY
//
// `detect_local_kind()` (model-manager/crates/core/src/source/localfs.rs,
// v0.4.0) is explicit:
//
//   - a FILE is accepted only when it is a `.zip`; anything else is refused
//     with "local path … is a file but not a .zip"
//   - a DIRECTORY is scanned, and one containing `*.gguf` is `LocalKind::HfGguf`
//
// So a bare `/somewhere/model.gguf` cannot be imported. The GGUF has to sit in
// a directory of its own, and that directory is what gets passed.
//
// ## Why the FILENAME has to carry the quant tag
//
// The manifest is inferred from file names. `infer_manifest_from_names()` only
// buckets a `.gguf` when `extract_quant()` finds a tag in its name, and a
// directory whose GGUFs all lack one produces "no recognizable model files
// found". So `model.gguf` fails and `gemma-4-E2B-it-q4_0.gguf` works. The
// match is case-insensitive.
//
// ## Why `precision` is always sent
//
// It becomes `ManifestHint.quant`. Sent, it keeps every other quant out of the
// manifest AND turns a wrong artifact into a clean, readable refusal —
// "requested quant "Q4_0" not found; available: [...]". Omitted, the inferred
// manifest keeps ONE ENTRY PER QUANT, each marked downloaded, and the import
// copies all of them. For this spike, where landing on the Hexagon DSP depends
// on the quantization being Q4_0 and nothing else, an explicit precision is
// what makes a silent substitution impossible.

import type { NewModel } from "./model-registry";
import type { NpuBundleInfo } from "../native/npu";

/**
 * The only quantization this spike accepts.
 *
 * Q4_0 is the one llama.cpp quant the Hexagon backend has kernels for. The
 * shipped `libggml-htp-v81.so` carries repacked matmul/vecdot kernels for
 * q4_0, q4_1, q8_0, iq4_nl and mxfp4 — and no K-quant at all — which is why
 * Qualcomm's own table marks `Q4_0` "Hexagon NPU" and `Q4_K_M` "GPU / CPU,
 * not optimized for Hexagon NPU" (docs/en/models/supported.mdx, v0.4.0).
 */
export const GENIEX_SPIKE_PRECISION = "Q4_0";

/** The GenieX cache prefix for a model the user supplied themselves. */
const LOCAL_PREFIX = "local/";

/**
 * The model manager's cache key for an imported directory.
 *
 * `org/repo`-shaped, because the runtime validates that shape ("invalid model
 * name: … must be 'org/repo'"), with `local/` as the org — the convention
 * Qualcomm's own documentation uses for a self-imported bundle.
 */
export function genieXLocalModelName(displayName: string): string {
  const slug =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "model";
  return `${LOCAL_PREFIX}${slug}`;
}

export interface GenieXImportRequest {
  modelName: string;
  localPath: string;
  displayName: string;
  precision: string;
}

/**
 * The arguments for `npuImportBundle()`. `hub` is not among them: the native
 * side pins it to `LOCALFS` for every import, which is the one place that
 * decision belongs.
 *
 * Exported for the tests — this is the request shape the device experiment
 * depends on, and it is checkable without a Qualcomm phone.
 */
export function genieXImportRequest(
  localPath: string,
  displayName: string,
  precision: string = GENIEX_SPIKE_PRECISION,
): GenieXImportRequest {
  return {
    modelName: genieXLocalModelName(displayName),
    localPath,
    displayName,
    precision,
  };
}

/**
 * The registry row for a GGUF the GenieX manager now owns.
 *
 * Three fields carry the whole routing decision and are worth naming:
 *
 *   backend            `geniex_llama_cpp` — a fact recorded about the row.
 *   artifact           stays `gguf`. It IS a GGUF; pretending otherwise would
 *                      make every artifact-shaped rule lie about it.
 *   runtimeModelName   set, which is what separates this from an ordinary
 *                      GGUF: the runtime owns the file and is asked for it by
 *                      name. `GenieXLlamaCppBackend.supports()` keys on exactly
 *                      this pair, so nothing Vesta downloads itself can be
 *                      captured by that lane.
 *
 * `sizeBytes` is the MODEL FILE's size, not the directory total: activation
 * re-stats `filePath` and compares, and a total covering a tokenizer and a
 * manifest alongside it would fail that check on every load.
 */
export function genieXImportedRow(
  bundle: NpuBundleInfo,
  opts: { displayName: string; modelName: string; contextSize?: number },
): NewModel {
  return {
    displayName: opts.displayName,
    filePath: bundle.modelPath,
    sizeBytes: modelFileSize(bundle),
    contextSize: opts.contextSize ?? 4096,
    role: "primary",
    state: "ready",
    quant: GENIEX_SPIKE_PRECISION,
    // No digest, and none to compare against: the user supplied the file. Said
    // plainly rather than dressed up as a baseline.
    trust: "unverified",
    backend: "geniex_llama_cpp",
    artifact: "gguf",
    runtimeModelName: opts.modelName,
    // A GGUF embeds its own tokenizer, so this is usually null and stays null.
    tokenizerPath: bundle.tokenizerPath ?? null,
    // Deliberately empty. A recorded manifest is what makes `canVerify()` offer
    // Verify, and Verify on this row would run the QAIRT bundle check — which
    // demands metadata.json and .bin shards and would reject a perfectly good
    // GGUF. The spike does not need it.
    bundleFiles: [],
  };
}

/**
 * The directory, under app-specific external storage, the spike imports from.
 *
 * One fixed name so the push target and the import target cannot disagree.
 */
export const GENIEX_SPIKE_DIR = "geniex-spike";

export type SpikeGgufPick =
  | { ok: true; file: string; displayName: string }
  | { ok: false; reason: string };

/**
 * Which GGUF in the push directory the spike will import, or why it will not.
 *
 * Every refusal here is one the import would otherwise hit later and more
 * obscurely — and one of them is the hard stop this spike is built around:
 * a GGUF that is not Q4_0 will import happily and then run its matmuls off the
 * Hexagon DSP, which would look like a working experiment and prove nothing.
 * So an unsuitable quantization is refused by NAME, before any bytes move,
 * rather than substituted.
 */
export function pickSpikeGguf(names: string[]): SpikeGgufPick {
  const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf"));
  if (ggufs.length === 0) {
    return { ok: false, reason: `No .gguf in ${GENIEX_SPIKE_DIR}/.` };
  }
  // A projector is a companion file, not a candidate; it rides along in the
  // same directory for a VLM and must not be mistaken for the weights.
  const weights = ggufs.filter((n) => !/mmproj/i.test(n));
  if (weights.length === 0) {
    return { ok: false, reason: "Only an mmproj projector is there — no weights." };
  }
  if (weights.length > 1) {
    return {
      ok: false,
      reason: `${weights.length} GGUFs in ${GENIEX_SPIKE_DIR}/ — leave exactly one.`,
    };
  }
  const file = weights[0];
  // The manifest is inferred from the FILE NAME: `extract_quant()` has to find
  // a tag in it or the directory is refused as having no recognizable model
  // files, and the tag it finds has to be the one we pull by.
  if (!/(^|[^a-z0-9])q4_0([^a-z0-9]|$)/i.test(file)) {
    return {
      ok: false,
      reason:
        `${file} is not a Q4_0 artifact. Q4_0 is the only quantization the ` +
        "Hexagon backend has kernels for — rename the file if it IS Q4_0, " +
        "otherwise fetch the Q4_0 build. Nothing else will be substituted.",
    };
  }
  return {
    ok: true,
    file,
    displayName: file.replace(/\.gguf$/i, ""),
  };
}

/** The size of the file `modelPath` points at, or 0 when the list cannot say. */
function modelFileSize(bundle: NpuBundleInfo): number {
  const wanted = baseName(bundle.modelPath);
  for (const file of bundle.files ?? []) {
    if (baseName(file.path) === wanted) return file.sizeBytes;
  }
  // 0 rather than the directory total: activation skips the size check when it
  // is 0, and a wrong number there would refuse every load.
  return 0;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}
