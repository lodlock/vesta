// The hub AS the catalogue.
//
// On device, `listHubModels()` returned 19 models and Qwen3-4B-Instruct-2507
// was not among them. That settles the -100010 — the asset is not published —
// and it condemns the shape of the old UI: a hard-coded list of one
// downloadable model was going to be wrong whenever Qualcomm's list changed,
// and it is wrong now.
//
// So these tests are written against a catalogue nobody here controls. Nothing
// below hard-codes which models exist; every case is about what the code does
// with whatever comes back.

import {
  breakDownHubModels,
  hubAvailability,
  hubModelLabel,
  parseSnapshot,
  serializeSnapshot,
  EMPTY_HUB,
  type HubModel,
  type HubState,
} from "../npu-hub";
import type { RuntimeChipset } from "../chipset-identity";

const TABLE: RuntimeChipset[] = [
  {
    name: "Snapdragon 8 Elite Gen 5 QRD",
    aliases: ["SM8850", "qualcomm-snapdragon-8-elite-gen5"],
  },
  { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750", "qualcomm-snapdragon-8-elite"] },
];

const model = (
  name: string,
  chipsets: string[],
  modelType = "LLM",
): HubModel => ({ name, modelType, chipsets });

const snapshotOf = (models: HubModel[], over: Partial<HubState> = {}): HubState => ({
  snapshot: { models, checkedAt: 1_700_000_000_000, cached: false },
  error: null,
  checking: false,
  ...over,
});

describe("splitting the hub's catalogue against this device", () => {
  it("offers only what the hub lists for this silicon", () => {
    const breakdown = breakDownHubModels(
      [
        model("ai-hub-models/A", ["qualcomm-snapdragon-8-elite-gen5"]),
        model("ai-hub-models/B", ["qualcomm-snapdragon-8-elite"]),
        model("ai-hub-models/C", ["SM8850"]),
      ],
      "SM8850",
      TABLE,
    );
    expect(breakdown.compatible.map((m) => m.entry.name)).toEqual([
      "ai-hub-models/A",
      "ai-hub-models/C",
    ]);
    expect(breakdown.otherChipsets).toBe(1);
  });

  it("hands back the HUB'S chipset spelling to pull with, and the canonical id to record", () => {
    // Two different jobs: one string goes to Qualcomm, the other is what the
    // load-time guard checks against Build.SOC_MODEL on every later boot.
    const breakdown = breakDownHubModels(
      [model("ai-hub-models/A", ["qualcomm-snapdragon-8-elite-gen5"])],
      "SM8850",
      TABLE,
    );
    expect(breakdown.compatible[0].chipset).toBe(
      "qualcomm-snapdragon-8-elite-gen5",
    );
    expect(breakdown.compatible[0].canonicalSoc).toBe("SM8850");
  });

  it("does not offer a model type this app has no runtime for", () => {
    // The NPU backend builds an LlmWrapper. A VLM bundle does not run slowly
    // on it, it fails — so this is a compatibility fact, not a judgement.
    const breakdown = breakDownHubModels(
      [model("ai-hub-models/Vision", ["SM8850"], "VLM")],
      "SM8850",
      TABLE,
    );
    expect(breakdown.compatible).toEqual([]);
    expect(breakdown.unsupportedType).toBe(1);
  });

  it("offers nothing at all when the device reports no chipset", () => {
    const breakdown = breakDownHubModels(
      [model("ai-hub-models/A", ["SM8850"])],
      null,
      TABLE,
    );
    expect(breakdown.compatible).toEqual([]);
    expect(breakdown.otherChipsets).toBe(1);
  });

  it("refuses to bridge spellings the runtime never declared equivalent", () => {
    // Without the table, the AI Hub slug and SM8850 are unrelated strings and
    // this code will not invent the connection — the same refusal the
    // compatibility guard makes.
    const breakdown = breakDownHubModels(
      [model("ai-hub-models/A", ["qualcomm-snapdragon-8-elite-gen5"])],
      "SM8850",
      undefined,
    );
    expect(breakdown.compatible).toEqual([]);
  });

  it("keeps the previous generation out", () => {
    const breakdown = breakDownHubModels(
      [model("ai-hub-models/A", ["SM8750"])],
      "SM8850",
      TABLE,
    );
    expect(breakdown.compatible).toEqual([]);
  });

  it("handles an empty catalogue without inventing one", () => {
    const breakdown = breakDownHubModels([], "SM8850", TABLE);
    expect(breakdown.compatible).toEqual([]);
    expect(breakdown.otherChipsets).toBe(0);
  });
});

describe("where Vesta's preferred model stands", () => {
  const QWEN = "ai-hub-models/Qwen3-4B-Instruct-2507";

  it("claims nothing before the hub has been asked", () => {
    expect(hubAvailability(EMPTY_HUB, QWEN, "SM8850", TABLE).status).toBe(
      "unchecked",
    );
  });

  it("reports listed, with the string to pull with", () => {
    const availability = hubAvailability(
      snapshotOf([model(QWEN, ["qualcomm-snapdragon-8-elite-gen5"])]),
      QWEN,
      "SM8850",
      TABLE,
    );
    expect(availability.status).toBe("listed");
    if (availability.status === "listed") {
      expect(availability.chipset).toBe("qualcomm-snapdragon-8-elite-gen5");
      expect(availability.canonicalSoc).toBe("SM8850");
    }
  });

  it("reports absent — the state the device is actually in today", () => {
    // 19 models came back and this was not one of them.
    const availability = hubAvailability(
      snapshotOf([model("ai-hub-models/Something-Else", ["SM8850"])]),
      QWEN,
      "SM8850",
      TABLE,
    );
    expect(availability.status).toBe("absent");
  });

  it("treats listed-for-another-chip as absent HERE", () => {
    const availability = hubAvailability(
      snapshotOf([model(QWEN, ["SM8750"])]),
      QWEN,
      "SM8850",
      TABLE,
    );
    expect(availability.status).toBe("absent");
  });

  it("carries the age of the answer, so absence is never permanent", () => {
    // The UI renders this timestamp beside "Check again". An absence with no
    // age reads as a fact about the future, which it never is.
    const availability = hubAvailability(
      snapshotOf([], { snapshot: { models: [], checkedAt: 42, cached: true } }),
      QWEN,
      "SM8850",
      TABLE,
    );
    if (availability.status !== "absent") throw new Error("expected absent");
    expect(availability.checkedAt).toBe(42);
    expect(availability.cached).toBe(true);
  });

  it("finds it under an alias the manager resolved", () => {
    const availability = hubAvailability(
      snapshotOf([model(QWEN, ["SM8850"])]),
      "ai-hub-models/Qwen3-4B",
      "SM8850",
      TABLE,
      QWEN,
    );
    expect(availability.status).toBe("listed");
  });
});

describe("naming a hub model", () => {
  it("shows the repo segment, readably", () => {
    expect(hubModelLabel("ai-hub-models/Qwen3-4B-Instruct-2507")).toBe(
      "Qwen3 4B Instruct 2507",
    );
  });

  it("copes with a name that has no org segment", () => {
    expect(hubModelLabel("solo")).toBe("solo");
  });

  it("never returns nothing", () => {
    expect(hubModelLabel("org/").length).toBeGreaterThan(0);
  });
});

describe("the cached catalogue", () => {
  it("round-trips, and comes back marked as cached", () => {
    const models = [model("ai-hub-models/A", ["SM8850"])];
    const restored = parseSnapshot(
      serializeSnapshot({ models, checkedAt: 99, cached: false }),
    );
    expect(restored).toEqual({ models, checkedAt: 99, cached: true });
  });

  it("degrades to 'never checked' rather than to a half-list", () => {
    // A partially-trusted catalogue would be read as the hub's answer, and an
    // absence derived from it would be a claim nobody made.
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("")).toBeNull();
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot("[]")).toBeNull();
    expect(parseSnapshot('{"models":[]}')).toBeNull();
    expect(parseSnapshot('{"checkedAt":1}')).toBeNull();
    expect(parseSnapshot('{"models":[{"name":"a"}],"checkedAt":1}')).toBeNull();
    expect(
      parseSnapshot('{"models":[{"name":"a","modelType":"LLM","chipsets":[1]}],"checkedAt":1}'),
    ).toBeNull();
  });

  it("accepts a well-formed empty catalogue — the hub may genuinely have none", () => {
    expect(parseSnapshot('{"models":[],"checkedAt":7}')).toEqual({
      models: [],
      checkedAt: 7,
      cached: true,
    });
  });
});
