// Asking the hub what it has, instead of assuming.
//
// The install failed with `rc=-100010` on a device whose runtime, chipset and
// QAIRT plugin had all just been proven good. Three strings decide whether an
// asset resolves — model name, chipset, precision — and Vesta was supplying all
// three from its own catalog. A hand-maintained copy of someone else's
// catalogue is wrong the moment they change it, and cannot say WHICH of the
// three is wrong when it is.
//
// So the chipset string now comes from the hub's own list for this model,
// matched to this device through the runtime's chipset table — the same
// equivalence the compatibility guard uses, with the same refusal to guess.

import {
  resolveAgainstHub,
  hubChipsetFor,
  explainResolution,
  type HubCatalog,
  type HubModel,
} from "../npu-hub";
import type { RuntimeChipset } from "../chipset-identity";

const MODEL = "ai-hub-models/Qwen3-4B-Instruct-2507";

// Shaped the way the device reports it: the runtime's `name` is a device
// string and the SoC number is one of its aliases.
const TABLE: RuntimeChipset[] = [
  {
    name: "Snapdragon 8 Elite Gen 5 QRD",
    aliases: ["SM8850", "qualcomm-snapdragon-8-elite-gen5"],
  },
  { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750", "qualcomm-snapdragon-8-elite"] },
];

const offering = (chipsets: string[]): HubModel => ({
  name: MODEL,
  modelType: "LLM",
  chipsets,
});

const catalog = (models: HubModel[]): HubCatalog => ({ ok: true, models });

describe("picking the chipset string the pull must be given", () => {
  it("uses the HUB'S spelling, not Android's and not the catalog's", () => {
    // The whole point: AI Hub keys on its own slug. Sending SM8850 because
    // that is what Build.SOC_MODEL says is a guess, and a guess is what
    // produced a 404.
    const entry = offering(["qualcomm-snapdragon-8-elite-gen5"]);
    expect(hubChipsetFor(entry, "SM8850", TABLE)).toBe(
      "qualcomm-snapdragon-8-elite-gen5",
    );
  });

  it("works when the hub happens to spell it the same way the device does", () => {
    expect(hubChipsetFor(offering(["SM8850"]), "SM8850", TABLE)).toBe("SM8850");
  });

  it("matches through the runtime's table and nothing looser", () => {
    // Without the table, the slug and SM8850 are two unrelated strings, and
    // this module will not invent the connection.
    expect(
      hubChipsetFor(
        offering(["qualcomm-snapdragon-8-elite-gen5"]),
        "SM8850",
        undefined,
      ),
    ).toBeNull();
  });

  it("does not match the previous generation", () => {
    expect(
      hubChipsetFor(offering(["qualcomm-snapdragon-8-elite"]), "SM8850", TABLE),
    ).toBeNull();
    expect(hubChipsetFor(offering(["SM8750"]), "SM8850", TABLE)).toBeNull();
  });

  it("picks this device's entry out of a list of many", () => {
    const entry = offering([
      "qualcomm-snapdragon-8-elite",
      "qualcomm-snapdragon-8-gen-3",
      "qualcomm-snapdragon-8-elite-gen5",
    ]);
    expect(hubChipsetFor(entry, "SM8850", TABLE)).toBe(
      "qualcomm-snapdragon-8-elite-gen5",
    );
  });

  it("returns null when the device reports no chipset", () => {
    expect(hubChipsetFor(offering(["SM8850"]), null, TABLE)).toBeNull();
  });
});

describe("resolving a catalog entry against the hub", () => {
  it("reports available, with the string to pull with", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["qualcomm-snapdragon-8-elite-gen5"])]),
      MODEL,
      "SM8850",
      TABLE,
    );
    expect(resolution.status).toBe("available");
    if (resolution.status === "available") {
      expect(resolution.chipset).toBe("qualcomm-snapdragon-8-elite-gen5");
    }
  });

  it("tells 'hub has it for other chips' apart from 'hub never heard of it'", () => {
    // Two completely different situations with two different next steps, and
    // a bare -100010 flattens them into one number.
    const wrongChip = resolveAgainstHub(
      catalog([offering(["qualcomm-snapdragon-8-elite"])]),
      MODEL,
      "SM8850",
      TABLE,
    );
    expect(wrongChip.status).toBe("wrong-chipset");

    const unknown = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "ai-hub-models/Some-Other-Model",
      "SM8850",
      TABLE,
    );
    expect(unknown.status).toBe("unknown-model");
  });

  it("matches the model name exactly, ignoring only case and spacing", () => {
    const found = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "  AI-HUB-MODELS/QWEN3-4B-INSTRUCT-2507  ",
      "SM8850",
      TABLE,
    );
    expect(found.status).toBe("available");
  });

  it("does not match a model name loosely", () => {
    // Installing a different model than the catalog entry promised is a worse
    // outcome than a clean "not found".
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "ai-hub-models/Qwen3-4B",
      "SM8850",
      TABLE,
    );
    expect(resolution.status).toBe("unknown-model");
  });

  it("returns the HUB'S spelling of the model name, not ours", () => {
    // Same principle as the chipset: the pull is given the catalogue's own
    // string, because that is the one that resolves an asset.
    const entry = { ...offering(["SM8850"]), name: "ai-hub-models/Qwen3-4B-Instruct-2507" };
    const resolution = resolveAgainstHub(
      catalog([entry]),
      "AI-HUB-MODELS/qwen3-4b-instruct-2507",
      "SM8850",
      TABLE,
    );
    expect(resolution.status).toBe("available");
    if (resolution.status === "available") {
      expect(resolution.modelName).toBe("ai-hub-models/Qwen3-4B-Instruct-2507");
    }
  });

  it("falls back to the alias the manager resolved, when the literal name misses", () => {
    // resolveAlias() is public where query() is not, so it is what stands in
    // for a name the catalogue lists differently.
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "ai-hub-models/Qwen3-4B",
      "SM8850",
      TABLE,
      MODEL,
    );
    expect(resolution.status).toBe("available");
    if (resolution.status === "available") {
      expect(resolution.modelName).toBe(MODEL);
    }
  });

  it("prefers the literal name over the alias when both match", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"]), { ...offering(["SM8850"]), name: "other/name" }]),
      MODEL,
      "SM8850",
      TABLE,
      "other/name",
    );
    expect(resolution.status).toBe("available");
    if (resolution.status === "available") expect(resolution.modelName).toBe(MODEL);
  });

  it("still refuses when neither the name nor its alias is listed", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "ai-hub-models/Nope",
      "SM8850",
      TABLE,
      "ai-hub-models/Also-Nope",
    );
    expect(resolution.status).toBe("unknown-model");
  });

  it("treats an unreachable hub as 'unknown', never as 'refused'", () => {
    // A phone with no connectivity must still be allowed to attempt the pull
    // with the catalog's own target — the runtime's verdict is the authority.
    const resolution = resolveAgainstHub(
      { ok: false, error: "Network unreachable" },
      MODEL,
      "SM8850",
      TABLE,
    );
    expect(resolution.status).toBe("unreachable");
    expect(explainResolution(resolution, "Qwen3 4B", "SM8850")).toBeNull();
  });
});

describe("what the user is told", () => {
  it("names the chipsets the hub DOES offer", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["qualcomm-snapdragon-8-elite"])]),
      MODEL,
      "SM8850",
      TABLE,
    );
    const message = explainResolution(resolution, "Qwen3 4B", "SM8850");
    expect(message).toContain("SM8850");
    expect(message).toContain("qualcomm-snapdragon-8-elite");
  });

  it("says how many models the hub has, when the name is the problem", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      "ai-hub-models/Nope",
      "SM8850",
      TABLE,
    );
    const message = explainResolution(resolution, "Nope", "SM8850");
    expect(message).toMatch(/does not list/i);
    expect(message).toContain(MODEL);
  });

  it("says nothing when there is nothing wrong", () => {
    const resolution = resolveAgainstHub(
      catalog([offering(["SM8850"])]),
      MODEL,
      "SM8850",
      TABLE,
    );
    expect(explainResolution(resolution, "Qwen3 4B", "SM8850")).toBeNull();
  });

  it("handles a hub that returned an empty catalogue", () => {
    const resolution = resolveAgainstHub(catalog([]), MODEL, "SM8850", TABLE);
    expect(resolution.status).toBe("unknown-model");
    expect(explainResolution(resolution, "Qwen3 4B", "SM8850")).toMatch(
      /no models at all/i,
    );
  });
});
