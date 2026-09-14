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
