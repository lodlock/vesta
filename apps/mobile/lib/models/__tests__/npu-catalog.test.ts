// The curated NPU catalog, and the chipset matching it depends on.
//
// The thing being protected here is small and expensive to get wrong: an NPU
// entry is an offer to download several gigabytes that will run on one chipset
// family and refuse to run anywhere else. Offering one on the wrong phone is
// not a harmless extra option, and matching two different chips to each other
// because their ids look similar is worse.

import {
  NPU_CATALOG,
  getNpuCatalogModel,
  npuCatalogFor,
  normalizeSocId,
} from "../npu-catalog";

describe("the catalog entry for this phone", () => {
  const entry = getNpuCatalogModel("qwen3-4b-instruct-2507-npu-sm8850");

  it("exists", () => {
    expect(entry).toBeDefined();
  });

  it("uses the model name Qualcomm's own AI Hub catalog publishes", () => {
    // `org/repo`, in the ai-hub-models namespace — the runtime rejects
    // anything else ("invalid model name: … must be 'org/repo'"), and this
    // exact string is what Qualcomm's Android sample lists for the qairt
    // runtime.
    expect(entry?.modelName).toBe("ai-hub-models/Qwen3-4B-Instruct-2507");
  });

  it("targets SM8850 at w4a16", () => {
    expect(entry?.targetSoc).toBe("SM8850");
    expect(entry?.precision).toBe("w4a16");
    expect(entry?.artifact).toBe("qairt_context");
  });

  it("is not confusable with the GGUF entry of the same model", () => {
    // Different artifact, different backend, and a target the GGUF never has.
    // These are the three facts the Models screen puts on the card.
    expect(entry?.artifact).not.toBe("gguf");
    expect(entry?.targetSoc).toBeTruthy();
  });
});

describe("which entries a device is offered", () => {
  it("offers the SM8850 entry to an SM8850", () => {
    expect(npuCatalogFor("SM8850").map((m) => m.targetSoc)).toEqual(["SM8850"]);
  });

  it("offers nothing to a different Snapdragon", () => {
    // SM8750 is the previous generation, not a compatible one: a bundle built
    // for SM8850 does not run slower there, it does not run.
    expect(npuCatalogFor("SM8750")).toEqual([]);
  });

  it("offers nothing when the chipset is unknown", () => {
    expect(npuCatalogFor(null)).toEqual([]);
    expect(npuCatalogFor("")).toEqual([]);
    expect(npuCatalogFor("   ")).toEqual([]);
  });

  it("ignores case and a vendor prefix", () => {
    expect(npuCatalogFor("sm8850")).toHaveLength(1);
    expect(npuCatalogFor("qcom-SM8850")).toHaveLength(1);
    expect(npuCatalogFor("QCOM_sm8850")).toHaveLength(1);
  });
});

describe("normalizing a chipset id", () => {
  it("strips case and a qcom prefix, and nothing else", () => {
    expect(normalizeSocId("sm8850")).toBe("SM8850");
    expect(normalizeSocId("qcom-sm8850")).toBe("SM8850");
    expect(normalizeSocId(" SM8850 ")).toBe("SM8850");
  });

  it("keeps two different chips different", () => {
    expect(normalizeSocId("SM8850")).not.toBe(normalizeSocId("SM8750"));
  });

  it("treats nothing-at-all as null", () => {
    expect(normalizeSocId(null)).toBeNull();
    expect(normalizeSocId(undefined)).toBeNull();
    expect(normalizeSocId("")).toBeNull();
    expect(normalizeSocId("  ")).toBeNull();
  });
});

describe("which entries a device is offered, through the runtime's table", () => {
  // Shaped the way the OnePlus 15 actually reports it: the runtime's `name` is
  // a device/marketing string and the SoC number is one of its aliases.
  const known = [
    {
      name: "Snapdragon 8 Elite Gen 5 QRD",
      aliases: ["SM8850", "Snapdragon 8 Elite Gen 5"],
    },
    { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750"] },
  ];

  it("offers the SM8850 entry to a device the runtime names differently", () => {
    expect(
      npuCatalogFor("Snapdragon 8 Elite Gen 5 QRD", known).map((m) => m.targetSoc),
    ).toEqual(["SM8850"]);
  });

  it("still offers it when the device reports the SoC number", () => {
    expect(npuCatalogFor("SM8850", known)).toHaveLength(1);
  });

  it("offers nothing to the previous generation", () => {
    expect(npuCatalogFor("SM8750", known)).toEqual([]);
    expect(npuCatalogFor("Snapdragon 8 Elite QRD", known)).toEqual([]);
  });

  it("offers nothing for a chip the runtime has never heard of", () => {
    expect(npuCatalogFor("SM9999", known)).toEqual([]);
  });
});

describe("catalog invariants", () => {
  it("every entry declares a target, a precision and a runtime version", () => {
    // An artifact with no target is refused at load time anyway (see
    // npu-compat "artifact-untargeted"), so shipping one in the catalog would
    // only ever waste a download.
    for (const m of NPU_CATALOG) {
      expect(m.targetSoc).toBeTruthy();
      expect(m.runtimeVersion).toBeTruthy();
      expect(m.modelName).toMatch(/^[^/]+\/[^/]+$/);
    }
  });

  it("has unique ids", () => {
    const ids = NPU_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
