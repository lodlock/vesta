// Structural pre-check for locally imported .gguf files. Early rejection only
// — see gguf-header.ts on what this does and does not claim.

import { inspectGgufHeader, base64ToBytes, GGUF_HEADER_BYTES } from "../gguf-header";

// Builds a 24-byte GGUF header. Little-endian, u32 version + two u64 counts.
function header({
  magic = "GGUF",
  version = 3,
  tensorCount = 291,
  kvCount = 24,
}: {
  magic?: string;
  version?: number;
  tensorCount?: number;
  kvCount?: number;
} = {}): Uint8Array {
  const b = new Uint8Array(GGUF_HEADER_BYTES);
  for (let i = 0; i < 4; i++) b[i] = magic.charCodeAt(i);
  const u32 = (off: number, v: number) => {
    b[off] = v & 0xff;
    b[off + 1] = (v >> 8) & 0xff;
    b[off + 2] = (v >> 16) & 0xff;
    b[off + 3] = (v >>> 24) & 0xff;
  };
  u32(4, version);
  u32(8, tensorCount);
  u32(12, 0); // high word of the u64
  u32(16, kvCount);
  u32(20, 0);
  return b;
}

const BIG = 4_000_000_000; // a plausible model size in bytes

describe("inspectGgufHeader", () => {
  it("accepts a well-formed header", () => {
    expect(inspectGgufHeader(header(), BIG)).toEqual({
      ok: true,
      version: 3,
      tensorCount: 291,
      kvCount: 24,
    });
  });

  it("accepts every GGUF version llama.cpp reads", () => {
    for (const version of [1, 2, 3]) {
      expect(inspectGgufHeader(header({ version }), BIG).ok).toBe(true);
    }
  });

  it("rejects a file that is not GGUF at all", () => {
    const zip = header({ magic: "PK" });
    expect(inspectGgufHeader(zip, BIG)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a gguf/i),
    });
  });

  it("rejects an unsupported version", () => {
    expect(inspectGgufHeader(header({ version: 9 }), BIG)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/version 9/i),
    });
    expect(inspectGgufHeader(header({ version: 0 }), BIG).ok).toBe(false);
  });

  it("rejects a header cut short", () => {
    expect(inspectGgufHeader(header().subarray(0, 10), BIG)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/truncated/i),
    });
  });

  it("rejects a file too small to hold weights", () => {
    expect(inspectGgufHeader(header(), 512)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/too small/i),
    });
  });

  it("rejects implausible counts (wrong endianness, or not a header)", () => {
    expect(inspectGgufHeader(header({ tensorCount: 900_000_000 }), BIG)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/implausible/i),
    });
    expect(inspectGgufHeader(header({ kvCount: 900_000_000 }), BIG).ok).toBe(false);
  });

  it("rejects a header declaring no tensors", () => {
    expect(inspectGgufHeader(header({ tensorCount: 0 }), BIG)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no tensors/i),
    });
  });
});

describe("base64ToBytes", () => {
  it("round-trips a known header", () => {
    const bytes = header();
    // Build the base64 the same way a file read would hand it to us.
    const b64 = Buffer.from(bytes).toString("base64");
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });

  it("decodes the ASCII magic correctly", () => {
    expect(Array.from(base64ToBytes("R0dVRg=="))).toEqual([0x47, 0x47, 0x55, 0x46]);
  });
});
