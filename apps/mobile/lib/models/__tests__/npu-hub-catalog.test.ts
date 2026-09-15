// The hub AS the catalogue.
//
// A hard-coded list of one downloadable model was going to be wrong whenever
// Qualcomm's list changed. The device proved it twice over: `listHubModels()`
// returns 19 models, and the one Vesta had hard-coded WAS among them — under
// `qualcomm/Qwen3-4B-Instruct-2507`, not the `ai-hub-models/…` the Android
// sample uses. The exact-match lookup missed, and the card reported "not
// available" for a model that was listed all along.
//
// Two lessons are pinned down below. Identifiers come from the hub, not from a
// sample file. And the hub's chipset METADATA is not the pull's chipset
// PARAMETER — see the asset-key test.
//
// These tests are written against a catalogue nobody here controls. Nothing
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

  // The bug this pins down cost a second identical -100010. AI Hub's release
  // manifest keys assets as "qualcomm-snapdragon-8-elite-gen5"; GenieX's
  // ModelPullInput.chipset takes the SoC identifier, and Qualcomm's Android
  // docs give exactly this example (SM8750 = Snapdragon 8 Elite, SM8850 =
  // Snapdragon 8 Elite Gen 5). They are different fields on different beans —
  // HubModel.chipsets vs ModelPullInput.chipset — and the type system never
  // claimed they matched. An earlier revision passed the asset key to the pull
  // on the assumption that "the hub's own spelling" must be what the hub wants
  // back. It is not.
  it("separates the catalogue's asset key from the SoC id the pull takes", () => {
    const breakdown = breakDownHubModels(
      [model("qualcomm/Qwen3-4B-Instruct-2507", ["qualcomm-snapdragon-8-elite-gen5"])],
      "SM8850",
      TABLE,
    );
    const entry = breakdown.compatible[0];

    // What goes to ModelPullInput.chipset.
    expect(entry.canonicalSoc).toBe("SM8850");
    // What the manifest calls it. Display and matching only.
    expect(entry.hubChipsetKey).toBe("qualcomm-snapdragon-8-elite-gen5");
    // And they are genuinely not interchangeable.
    expect(entry.canonicalSoc).not.toBe(entry.hubChipsetKey);
  });

  it("still decides compatibility through the canonical equivalence machinery", () => {
    // The SoC id is DERIVED from the runtime's own chipset table, not pattern-
    // matched out of the asset key: strip the table and nothing resolves, which
    // is the same refusal the load-time guard makes.
    expect(
      breakDownHubModels(
        [model("qualcomm/Qwen3-4B-Instruct-2507", ["qualcomm-snapdragon-8-elite-gen5"])],
        "SM8850",
        undefined,
      ).compatible,
    ).toEqual([]);

    // And a neighbouring generation stays out, one character apart.
    expect(
      breakDownHubModels(
        [model("qualcomm/X", ["qualcomm-snapdragon-8-elite"])],
        "SM8850",
        TABLE,
      ).compatible,
    ).toEqual([]);
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
      // Same split as above: the SoC id is the pull parameter, the asset key
      // is metadata.
      expect(availability.canonicalSoc).toBe("SM8850");
      expect(availability.hubChipsetKey).toBe("qualcomm-snapdragon-8-elite-gen5");
    }
  });

  it("reports absent only when the name is genuinely not in the catalogue", () => {
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

  it("misses a model listed under a different org segment — exactly what happened", () => {
    // The hub lists `qualcomm/Qwen3-4B-Instruct-2507`; Vesta asked for
    // `ai-hub-models/…`. Matching is exact by design — a loose match would
    // install a different model than the card promised — so the fix is to
    // carry the identifier the hub actually publishes, not to relax this.
    const availability = hubAvailability(
      snapshotOf([model("qualcomm/Qwen3-4B-Instruct-2507", ["SM8850"])]),
      "ai-hub-models/Qwen3-4B-Instruct-2507",
      "SM8850",
      TABLE,
    );
    expect(availability.status).toBe("absent");

    // With the right identifier it resolves, and the pull gets the SoC id.
    const fixed = hubAvailability(
      snapshotOf([
        model("qualcomm/Qwen3-4B-Instruct-2507", [
          "qualcomm-snapdragon-8-elite-gen5",
        ]),
      ]),
      "qualcomm/Qwen3-4B-Instruct-2507",
      "SM8850",
      TABLE,
    );
    expect(fixed.status).toBe("listed");
    if (fixed.status === "listed") expect(fixed.canonicalSoc).toBe("SM8850");
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
