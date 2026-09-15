// The prefix KV session cache must sit out the Qualcomm path entirely.
//
// The regression this guards against is quiet and destructive. A QAIRT context
// binary has its KV layout compiled in and GenieX exposes no state save/load at
// all, so snapshotPrefixSession throws on that path. persistPrefixSession's
// catch treats a failed save as a possibly-partial file and DELETES the cache
// files — so without this guard, one turn on the NPU model would wipe the
// session cache a llama.cpp model spent ~30s of cold prefill to build, and the
// user would pay that again the next time they switched back.
//
// So the cache asks whether the loaded runtime supports it, rather than finding
// out by throwing.

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  readAsStringAsync: jest.fn(async () => "{}"),
  writeAsStringAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
}));

jest.mock("../llm-engine", () => ({
  getKvCacheType: jest.fn(() => "n/a"),
  getModelInfo: jest.fn(() => ({
    loaded: true,
    path: "/files/geniex/models/qwen3/model",
  })),
  loadSessionFile: jest.fn(),
  snapshotPrefixSession: jest.fn(),
  supportsKvSessionCache: jest.fn(() => false),
}));

import { restorePrefixSession, persistPrefixSession } from "../session-cache";
import { loadSessionFile, snapshotPrefixSession } from "../llm-engine";

const fs = jest.requireMock("expo-file-system/legacy");

const PREFIX = "You are Vesta.".repeat(20);

beforeEach(() => jest.clearAllMocks());

describe("with a Qualcomm NPU session loaded", () => {
  it("does not try to restore a KV session", async () => {
    await expect(restorePrefixSession(PREFIX)).resolves.toBeNull();
    expect(loadSessionFile).not.toHaveBeenCalled();
  });

  it("does not try to save one", async () => {
    await expect(persistPrefixSession(PREFIX, "a", "b")).resolves.toBeNull();
    expect(snapshotPrefixSession).not.toHaveBeenCalled();
  });

  it("leaves the cache files alone", async () => {
    // The whole point. A thrown save would have deleted them; a declined one
    // must not touch a cache that still belongs to the llama.cpp model.
    await restorePrefixSession(PREFIX);
    await persistPrefixSession(PREFIX, "a", "b");
    expect(fs.deleteAsync).not.toHaveBeenCalled();
    expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
  });
});
