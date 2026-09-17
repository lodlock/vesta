// The facts the NPU backend needs, and WHEN it needs them.
//
// The bug this pins down was a cold-start one, and it would have looked like a
// hardware problem rather than an ordering one: the chipset was set only by the
// Models screen's refresh(), and the runtime was probed fire-and-forget AFTER
// the model load. Force-stop the app, invoke the assistant, ask a question —
// the load reached the compatibility check with no chipset and no probe, and an
// NPU model that works perfectly was refused as "this device doesn't report its
// chipset". A correct refusal about a world that had simply not been read yet.

const mockSetDeviceSoc = jest.fn();
const mockSetRuntimeChipsets = jest.fn();
const mockProbe = jest.fn(async () => ({
  version: "2.45.0",
  computeUnit: "npu",
  soc: "SM8850",
}));
const mockDeviceChipset = jest.fn(async () => ({
  socModel: "SM8850",
  // As the OnePlus 15 reports it: the runtime names the chip by a device
  // string and carries the SoC number as an alias.
  known: [
    {
      name: "Snapdragon 8 Elite Gen 5 QRD",
      aliases: ["SM8850", "Snapdragon 8 Elite Gen 5"],
    },
  ],
}));
const mockIsNpuBuild = jest.fn(() => true);
const mockGetDeviceInfo = jest.fn(async () => ({ soc: "SM8850" }));

const mockSetComputeUnit = jest.fn();

jest.mock("../../llm/backends/registry", () => ({
  setDeviceSoc: (...a: unknown[]) => mockSetDeviceSoc(...a),
  setRuntimeChipsets: (...a: unknown[]) => mockSetRuntimeChipsets(...a),
  genieXLlamaCpp: () => ({ setComputeUnit: mockSetComputeUnit }),
}));
// Readiness also puts the remembered GenieX compute unit back on the backend.
// Mocked at the module rather than at the database it reads, so this file stays
// about ORDERING and does not acquire a SQLite dependency —
// __tests__/geniex-compute.test.ts owns the storage half.
jest.mock("../geniex-compute", () => ({
  loadGenieXComputeUnit: jest.fn(async () => "npu"),
}));
jest.mock("../../native/system-actions", () => ({
  getDeviceInfo: () => mockGetDeviceInfo(),
}));
jest.mock("../../native/npu", () => ({
  isNpuBuild: () => mockIsNpuBuild(),
  probeNpuRuntime: () => mockProbe(),
  npuUnavailableReason: jest.fn(() => "The QAIRT plugin did not register."),
  npuDeviceChipset: () => mockDeviceChipset(),
}));

import { prepareNpuBackend, resetNpuReadinessForTests } from "../npu-ready";

beforeEach(() => {
  jest.clearAllMocks();
  resetNpuReadinessForTests();
  mockIsNpuBuild.mockReturnValue(true);
});

describe("on an NPU build with a working runtime", () => {
  it("restores the remembered compute unit, so a load is not built on a default", async () => {
    await prepareNpuBackend();
    expect(mockSetComputeUnit).toHaveBeenCalledWith("npu");
  });

  it("tells the backend the chipset before anything else", async () => {
    await prepareNpuBackend();
    expect(mockSetDeviceSoc).toHaveBeenCalledWith("SM8850");
  });

  it("reads the chipset itself when the caller doesn't have one", async () => {
    await prepareNpuBackend();
    expect(mockGetDeviceInfo).toHaveBeenCalled();
  });

  it("uses the caller's chipset when it has one, without re-reading it", async () => {
    // The Models screen already paid for a device-caps read; making it pay
    // again — and stat the filesystem a second time — is pure waste.
    await prepareNpuBackend("SM8850");
    expect(mockGetDeviceInfo).not.toHaveBeenCalled();
    expect(mockSetDeviceSoc).toHaveBeenCalledWith("SM8850");
  });

  it("hands over the runtime's own chipset table for cross-checking", async () => {
    const ready = await prepareNpuBackend();
    expect(mockSetRuntimeChipsets).toHaveBeenCalledWith([
      {
        name: "Snapdragon 8 Elite Gen 5 QRD",
        aliases: ["SM8850", "Snapdragon 8 Elite Gen 5"],
      },
    ]);
    // The raw runtime string is reported as-is — it is what the install path
    // hands back to the runtime and what diagnostics shows…
    expect(ready.runtimeChipset).toBe("Snapdragon 8 Elite Gen 5 QRD");
    // …while the id everything is compared on is the SoC number both Android
    // and the catalog use.
    expect(ready.canonicalSoc).toBe("SM8850");
  });

  it("reports 'not recognised' rather than a guess for an unknown chip", async () => {
    mockGetDeviceInfo.mockResolvedValueOnce({ soc: "SM9999" } as never);
    const ready = await prepareNpuBackend();
    expect(ready.runtimeChipset).toBeNull();
    expect(ready.canonicalSoc).toBe("SM9999");
  });

  it("reports what it found", async () => {
    const ready = await prepareNpuBackend();
    expect(ready).toMatchObject({
      inBuild: true,
      available: true,
      reason: null,
      runtimeVersion: "2.45.0",
      soc: "SM8850",
    });
  });

  it("does the work once per process", async () => {
    await prepareNpuBackend("SM8850");
    await prepareNpuBackend("SM8850");
    await prepareNpuBackend();
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockDeviceChipset).toHaveBeenCalledTimes(1);
  });
});

describe("when the runtime does not start", () => {
  it("passes the SDK's own reason through, and asks for no chipset table", async () => {
    mockProbe.mockResolvedValueOnce(null as never);
    const ready = await prepareNpuBackend("SM8850");
    expect(ready.available).toBe(false);
    expect(ready.reason).toBe("The QAIRT plugin did not register.");
    expect(mockDeviceChipset).not.toHaveBeenCalled();
    // The chipset is still published: the backend needs it to explain a
    // refusal, even when the refusal is about the runtime rather than the chip.
    expect(mockSetDeviceSoc).toHaveBeenCalledWith("SM8850");
  });

  it("leaves runtimeChipset as 'never asked', not 'not recognised'", async () => {
    mockProbe.mockResolvedValueOnce(null as never);
    const ready = await prepareNpuBackend("SM8850");
    expect(ready.runtimeChipset).toBeUndefined();
  });
});

describe("on a default build", () => {
  it("does nothing at all", async () => {
    mockIsNpuBuild.mockReturnValue(false);
    const ready = await prepareNpuBackend();
    // Not even a device-info call: a GGUF-only boot must pay nothing for a
    // backend that is not in the binary.
    expect(mockGetDeviceInfo).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSetDeviceSoc).not.toHaveBeenCalled();
    expect(ready).toMatchObject({ inBuild: false, available: false, reason: null });
  });
});
