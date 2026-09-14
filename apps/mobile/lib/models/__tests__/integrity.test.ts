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
