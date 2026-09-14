// Cheap structural check of a .gguf file, run BEFORE anything hands the path to
// llama.cpp.
//
// This is early rejection for obviously-bad files — a truncated download, a
// renamed .zip, a half-copied import — so the user gets "that isn't a GGUF"
// instead of whatever a native parser does with 3 GB of garbage. It is NOT a
// safety boundary: a well-formed header says nothing about the rest of the
// file, and parsing arbitrary model files natively stays inherently risky. Do
// not treat a pass here as "safe to load", only a fail as "definitely don't".
//
// GGUF header, little-endian:
//   0..3    magic "GGUF"
//   4..7    uint32 version
//   8..15   uint64 tensor_count
//   16..23  uint64 metadata_kv_count

import * as FileSystem from "expo-file-system/legacy";

export const GGUF_HEADER_BYTES = 24;

// llama.cpp reads v1-v3. A v0 or v9 file is either corrupt or something this
// build cannot load; either way, say so before the native parser tries.
const MIN_VERSION = 1;
const MAX_VERSION = 3;

// Counts this large mean the bytes aren't what we think they are (wrong
// endianness, or not a header at all) long before they mean a real model.
const MAX_PLAUSIBLE_COUNT = 1_000_000;

// A real GGUF carries weights. Anything this small is a stub or a truncation.
const MIN_PLAUSIBLE_FILE_BYTES = 1024;

export interface GgufHeaderCheck {
  ok: boolean;
  version?: number;
  tensorCount?: number;
  kvCount?: number;
  error?: string;
}

function readUint32LE(b: Uint8Array, off: number): number {
  return (
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
  );
}

// uint64 as a JS number. Anything with a non-zero high word is already far past
// MAX_PLAUSIBLE_COUNT, so returning Infinity for it loses nothing.
function readUint64LE(b: Uint8Array, off: number): number {
  const lo = readUint32LE(b, off);
  const hi = readUint32LE(b, off + 4);
  return hi === 0 ? lo : Number.POSITIVE_INFINITY;
}

// Pure: the whole decision, given the first bytes and the file's size.
export function inspectGgufHeader(
  bytes: Uint8Array,
  fileSize: number,
): GgufHeaderCheck {
  if (fileSize < MIN_PLAUSIBLE_FILE_BYTES) {
    return { ok: false, error: `File is too small to be a model (${fileSize} bytes).` };
  }
  if (bytes.length < GGUF_HEADER_BYTES) {
    return { ok: false, error: "File is truncated — no complete GGUF header." };
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "GGUF") {
    return { ok: false, error: "Not a GGUF file (bad magic bytes)." };
  }
  const version = readUint32LE(bytes, 4);
  if (version < MIN_VERSION || version > MAX_VERSION) {
    return { ok: false, error: `Unsupported GGUF version ${version}.` };
  }
  const tensorCount = readUint64LE(bytes, 8);
  const kvCount = readUint64LE(bytes, 16);
  if (tensorCount > MAX_PLAUSIBLE_COUNT || kvCount > MAX_PLAUSIBLE_COUNT) {
    return { ok: false, error: "GGUF header is not readable (implausible counts)." };
  }
  if (tensorCount === 0) {
    return { ok: false, error: "GGUF file declares no tensors." };
  }
  return { ok: true, version, tensorCount, kvCount };
}

// Pure: base64 → bytes. Written out rather than relying on a global `atob`,
// which is not guaranteed across Hermes versions.
export function base64ToBytes(b64: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = alphabet.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

// Reads just the header off disk and inspects it. Never throws: an unreadable
// file is itself a failed check.
export async function checkGgufFile(path: string): Promise<GgufHeaderCheck> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return { ok: false, error: "File not found." };
    const b64 = await FileSystem.readAsStringAsync(path, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: GGUF_HEADER_BYTES,
    });
    return inspectGgufHeader(base64ToBytes(b64), info.size ?? 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read the file: ${message}` };
  }
}
