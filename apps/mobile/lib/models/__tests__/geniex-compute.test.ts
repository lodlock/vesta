// The GenieX compute unit survives a restart, and survives it as a PENDING
// choice.
//
// It was process state: a field on the backend singleton, set from the
// Diagnostics buttons and gone the moment the app was killed. So every restore
// built its session with `hybrid` no matter what had been selected, and the
// selector came back showing the default while a session existed that nobody
// had configured.
//
// The second thing pinned here is the distinction that made the earlier
// compute-unit bug: restoring a choice says what the NEXT load will use. It
// must not touch, and cannot describe, a session that already exists.

import {
  GENIEX_COMPUTE_UNIT_KEY,
  loadGenieXComputeUnit,
  parseComputeUnit,
  saveGenieXComputeUnit,
} from "../geniex-compute";
import { prepareNpuBackend, resetNpuReadinessForTests } from "../npu-ready";
import { genieXLlamaCpp } from "../../llm/backends/registry";
import { getConfig, setConfig } from "../../storage/database";

jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  setConfig: jest.fn(async () => {}),
}));
jest.mock("../../native/system-actions", () => ({
  getDeviceInfo: jest.fn(async () => ({ soc: "SM8850" })),
}));
jest.mock("../../native/npu", () => ({
  isNpuBuild: jest.fn(() => true),
  npuProbeHasRun: jest.fn(() => true),
  isNpuRuntimeAvailable: jest.fn(() => true),
  probeNpuRuntime: jest.fn(async () => ({ version: "0.4.0" })),
  npuUnavailableReason: jest.fn(() => null),
  npuDeviceChipset: jest.fn(async () => ({ known: [] })),
  npuLoadLlamaCpp: jest.fn(),
  npuGenerate: jest.fn(),
  npuUnload: jest.fn(async () => {}),
  npuCancel: jest.fn(),
  onNpuToken: jest.fn(() => () => {}),
  DEFAULT_GENIEX_COMPUTE_UNIT: "hybrid",
}));

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockSetConfig = setConfig as jest.MockedFunction<typeof setConfig>;

beforeEach(() => {
  jest.clearAllMocks();
  resetNpuReadinessForTests();
  genieXLlamaCpp().setComputeUnit("hybrid");
  mockGetConfig.mockResolvedValue(null);
});

describe("what is accepted off disk", () => {
  it("takes the four aliases the runtime understands", () => {
    expect(parseComputeUnit("npu")).toBe("npu");
    expect(parseComputeUnit("hybrid")).toBe("hybrid");
    expect(parseComputeUnit("gpu")).toBe("gpu");
    expect(parseComputeUnit("cpu")).toBe("cpu");
  });

  it("refuses anything else rather than casting it", () => {
    // A value from a newer build, or a hand-edited row. Passing it through
    // would turn a stale config row into a load failure on every boot.
    expect(parseComputeUnit("htp0")).toBeNull();
    expect(parseComputeUnit("")).toBeNull();
    expect(parseComputeUnit(null)).toBeNull();
  });

  it("falls back to the runtime's own default when nothing is stored", async () => {
    await expect(loadGenieXComputeUnit()).resolves.toBe("hybrid");
  });

  it("falls back rather than failing when the database cannot be read", async () => {
    mockGetConfig.mockRejectedValue(new Error("database is locked"));
    await expect(loadGenieXComputeUnit()).resolves.toBe("hybrid");
  });
});

describe("the choice is remembered", () => {
  it("is written under one key", async () => {
    await saveGenieXComputeUnit("npu");
    expect(mockSetConfig).toHaveBeenCalledWith(GENIEX_COMPUTE_UNIT_KEY, "npu");
  });

  it("comes back on the next launch", async () => {
    mockGetConfig.mockResolvedValue("npu");
    await expect(loadGenieXComputeUnit()).resolves.toBe("npu");
  });
});

describe("readiness restores it before anything can be loaded", () => {
  it("puts the stored unit back on the backend", async () => {
    mockGetConfig.mockResolvedValue("npu");

    await prepareNpuBackend("SM8850");

    expect(genieXLlamaCpp().getComputeUnit()).toBe("npu");
  });

  it("restores it as pending, claiming nothing about a session", async () => {
    mockGetConfig.mockResolvedValue("npu");

    await prepareNpuBackend("SM8850");

    // A restored preference is not a session. The loaded unit stays null until
    // a load succeeds and reports what it actually built.
    expect(genieXLlamaCpp().getLoadedComputeUnit()).toBeNull();
    expect(genieXLlamaCpp().getDiagnostics().details.requestedComputeUnit).toBe("n/a");
    expect(genieXLlamaCpp().getDiagnostics().details.pendingComputeUnit).toBe("npu");
  });

  it("reads the row once, so a later choice is not undone by a second prepare", async () => {
    mockGetConfig.mockResolvedValue("npu");
    await prepareNpuBackend("SM8850");

    genieXLlamaCpp().setComputeUnit("hybrid");
    await prepareNpuBackend("SM8850");

    expect(genieXLlamaCpp().getComputeUnit()).toBe("hybrid");
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
  });
});
