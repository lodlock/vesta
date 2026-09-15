// Shared types for the in-app model manager (discovery, download, selection).
// Android-first, but all pure TypeScript so it carries to iOS later.

export type ModelRole = "primary" | "router" | "embedding";
export type RecommendedFor = "phone" | "tablet" | "any";

// A curated, bundled catalog entry. Static — works fully offline for browsing.
// The exact downloadable file is resolved live against the HF repo tree at
// download time, so a drifted `preferredFile` never blocks the user.
export interface CatalogModel {
  id: string; // stable catalog id, e.g. "qwen3-4b"
  displayName: string;
  description: string;
  hfRepo: string; // e.g. "Qwen/Qwen3-4B-GGUF"
  preferredFile: string; // best-known .gguf filename (verified live)
  quant: string; // e.g. "Q4_K_M"
  sizeBytesApprox: number;
  minRamMb: number; // RAM the device should have to run this comfortably
  paramsB: number; // billions of parameters
  contextSize: number; // default n_ctx to load with
  role: ModelRole;
  recommendedFor: RecommendedFor;
  supportsTools: boolean;
  license: string;
  licenseUrl?: string;
}

// How much is actually known about the bytes on disk. Three different things
// get called "verified" in a model manager, and conflating them is how an
// unchecked file ends up looking trustworthy:
//
//   verified_upstream       the file hashes to the digest its source repo
//                           published (HuggingFace's LFS oid). Provenance and
//                           integrity.
//   verified_user_checksum  the file hashes to a digest the USER supplied at
//                           import. Integrity, with provenance vouched for by
//                           the user.
//   user_supplied_baseline  a local file the user explicitly chose, with no
//                           external digest to check. We hash it at import and
//                           keep that as a baseline, so a later unexpected
//                           change is detectable. Integrity FROM import
//                           onwards; it proves nothing about where it came
//                           from.
//   unverified              no digest at all — hashing was unavailable when it
//                           was imported, or the row predates this field.
export type ModelTrust =
  | "verified_upstream"
  | "verified_user_checksum"
  | "user_supplied_baseline"
  | "unverified";

// Which runtime a model belongs to. Not a preference — a fact about the file.
export type ModelBackendId = "llama_cpp" | "qualcomm_npu";

// The on-disk shape. `gguf` is one portable file; the Qualcomm formats are
// compiled for a specific SoC and usually arrive as a directory of files.
export type ModelArtifact = "gguf" | "qairt_context" | "geniex_bundle";

// One file of a multi-file model bundle. A bundle is verified as a single
// integrity unit: every listed file must match, or the model is not loadable.
export interface BundleFile {
  // Path relative to the model directory — "weights.bin", "tokenizer.json".
  path: string;
  sha256: string | null;
  sizeBytes?: number;
}

export type DownloadStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "paused"
  | "verifying"
  | "ready"
  | "error"
  | "canceled";

// A model the user has installed (downloaded or imported). Backed by the
// `models` SQLite table — the single source of truth, replacing the old
// bare `model_path` config key.
export interface InstalledModel {
  id: string; // uuid
  displayName: string;
  hfRepo: string | null;
  hfFile: string | null;
  filePath: string;
  quant: string | null;
  sizeBytes: number;
  minRamMb: number | null;
  chatTemplate: string | null;
  contextSize: number;
  role: ModelRole;
  state: DownloadStatus;
  resumeToken: string | null;
  // The digest RECORDED for this file. While a download runs it is the expected
  // one; afterwards it is whatever `trust` says it is. Null when unknown.
  sha256: string | null;
  trust: ModelTrust;
  // Runtime and compatibility. Rows written before these existed read as a
  // GGUF on llama.cpp, which is what they are.
  backend: ModelBackendId;
  artifact: ModelArtifact;
  // The chipset this artifact was compiled for ("SM8850"). Null means portable
  // — true of every GGUF, and never true of a Qualcomm bundle.
  targetSoc: string | null;
  // The runtime version the artifact expects, when it declares one.
  runtimeVersion: string | null;
  // How a runtime that owns its own files addresses this model — GenieX's
  // "ai-hub-models/Qwen3-4B-Instruct-2507". Null for everything Vesta stores
  // itself, which is every GGUF.
  runtimeModelName: string | null;
  // Where the tokenizer is, for a bundle that keeps it apart from the weights.
  // Null for a GGUF, which embeds its own.
  tokenizerPath: string | null;
  // Files that make up a bundle, verified together. Empty for single-file models.
  bundleFiles: BundleFile[];
  isActive: boolean;
  createdAt: number;
}

// Live download progress, surfaced to the UI via the model store.
export interface DownloadProgress {
  modelId: string;
  status: DownloadStatus;
  bytesWritten: number;
  bytesTotal: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  error?: string;
}
