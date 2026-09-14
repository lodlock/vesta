// SHA-256 of a local file, computed natively.
//
// Model files are multi-GB: hashing them in JS would mean streaming the whole
// file through the bridge, so the digest runs in Kotlin (SystemActionsModule,
// 1 MB chunks on a worker thread) and only the 64-char hex result crosses.
//
// Availability mirrors system-actions.ts: Android with the native module
// loaded. `null` means "cannot hash here" (iOS / Expo Go / older native build)
// and is deliberately distinct from a hash mismatch — callers must decide what
// an unverifiable file means rather than treating it as verified.

import { NativeModules, Platform } from "react-native";

const { SystemActionsModule } = NativeModules;

export function canHashFiles(): boolean {
  return (
    Platform.OS === "android" &&
    !!SystemActionsModule &&
    typeof SystemActionsModule.sha256File === "function"
  );
}

export async function sha256File(path: string): Promise<string | null> {
  if (!canHashFiles()) return null;
  const hex = (await SystemActionsModule.sha256File(path)) as string;
  return hex.toLowerCase();
}

// Normalizes a hash for comparison: HuggingFace's LFS oid is a bare hex
// sha256, but the API has also been seen prefixed ("sha256:abc…"), and case
// varies. Anything that isn't 64 hex chars is not a usable sha256 — return
// null so callers skip verification loudly instead of comparing garbage.
export function normalizeSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}
