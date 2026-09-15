// One canonical name per piece of silicon.
//
// This exists because of a real refusal on a real phone. The OnePlus 15 reports
// `Build.SOC_MODEL = "SM8850"`; the GenieX runtime, asked what chipset that is,
// answers with a device name — "Snapdragon 8 Elite Gen 5 QRD" — and carries
// SM8850 as an alias. Compared as strings those are two chips, so the guard
// refused a bundle that would have run.
//
// The fix is not to compare more loosely. Every test below that passes does so
// because the RUNTIME'S OWN TABLE put the two spellings in one entry; every
// test that fails does so because nothing put them together. There is no
// substring match, no prefix match, no edit distance and no generation
// arithmetic anywhere in the module under test, and SM8750/SM8850 — one
// character apart, different silicon — stay firmly apart.

import {
  canonicalChipset,
  normalizeChipsetId,
  sameChipset,
  type RuntimeChipset,
} from "../chipset-identity";

// Shaped the way the device actually reports it: the runtime's `name` is the
// device/marketing string and the machine id lives in `aliases`.
const TABLE: RuntimeChipset[] = [
  {
    name: "Snapdragon 8 Elite Gen 5 QRD",
    aliases: ["SM8850", "Snapdragon 8 Elite Gen 5", "sun"],
  },
  { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750", "Snapdragon 8 Elite"] },
];

const canon = (soc: string | null, table?: RuntimeChipset[] | null) =>
  canonicalChipset(soc, table)?.canonical ?? null;

describe("normalizing a single id", () => {
  it("strips case and a qcom prefix, and nothing else", () => {
    expect(normalizeChipsetId("sm8850")).toBe("SM8850");
    expect(normalizeChipsetId("qcom-sm8850")).toBe("SM8850");
    expect(normalizeChipsetId("QCOM_sm8850")).toBe("SM8850");
    expect(normalizeChipsetId("  SM8850  ")).toBe("SM8850");
  });

  it("keeps two different chips different", () => {
    expect(normalizeChipsetId("SM8850")).not.toBe(normalizeChipsetId("SM8750"));
  });

  it("treats nothing-at-all as null", () => {
    expect(normalizeChipsetId(null)).toBeNull();
    expect(normalizeChipsetId(undefined)).toBeNull();
    expect(normalizeChipsetId("")).toBeNull();
    expect(normalizeChipsetId("   ")).toBeNull();
  });
});

describe("the three names for one chip all reduce to one id", () => {
  // The bug, stated as a test: these are the exact three strings the OnePlus 15
  // path deals with — Android's, the runtime's, and the bundle's target.
  it("SM8850, the runtime's device name, and the bundle target agree", () => {
    const device = canon("SM8850", TABLE);
    const runtime = canon("Snapdragon 8 Elite Gen 5 QRD", TABLE);
    const bundle = canon("SM8850", TABLE);

    expect(device).toBe("SM8850");
    expect(runtime).toBe("SM8850");
    expect(bundle).toBe("SM8850");
  });

  it("resolves the marketing name without the QRD suffix too", () => {
    // A second real spelling in the same entry, and it is only equal because
    // the entry lists it — not because it shares a prefix with the first.
    expect(canon("Snapdragon 8 Elite Gen 5", TABLE)).toBe("SM8850");
  });

  it("resolves an internal codename the runtime happens to carry", () => {
    expect(canon("sun", TABLE)).toBe("SM8850");
  });

  it("ignores case and spacing on the way in", () => {
    expect(canon("snapdragon 8 elite gen 5 qrd", TABLE)).toBe("SM8850");
    expect(canon("  sm8850 ", TABLE)).toBe("SM8850");
    expect(canon("qcom-SM8850", TABLE)).toBe("SM8850");
  });

  it("prefers the SoC model number as the canonical label", () => {
    // The label is picked from an equivalence class the runtime already
    // declared; the SoC number is chosen because it is the one spelling that
    // survives a marketing rebrand — and because it is what Android and the
    // catalog both use.
    const id = canonicalChipset("Snapdragon 8 Elite Gen 5 QRD", TABLE);
    expect(id?.canonical).toBe("SM8850");
    expect(id?.runtimeName).toBe("Snapdragon 8 Elite Gen 5 QRD");
  });
});

describe("chips that are genuinely different stay different", () => {
  it("SM8850 is not SM8750", () => {
    expect(canon("SM8850", TABLE)).not.toBe(canon("SM8750", TABLE));
  });

  it("Snapdragon 8 Elite Gen 5 is not Snapdragon 8 Elite", () => {
    // One is a substring of the other. A `contains()` check would call these
    // the same chip; the table does not, so neither does this.
    expect(canon("Snapdragon 8 Elite Gen 5", TABLE)).toBe("SM8850");
    expect(canon("Snapdragon 8 Elite", TABLE)).toBe("SM8750");
  });

  it("an 8 Elite Gen 4 that does not exist in the table is not gen 5", () => {
    expect(canon("Snapdragon 8 Elite Gen 4", TABLE)).not.toBe("SM8850");
  });

  it("SM8650 is not SM8850 even with no table at all", () => {
    expect(canon("SM8650")).not.toBe(canon("SM8850"));
  });
});

describe("a chip the runtime has never heard of", () => {
  it("still resolves to an id, but is marked unknown so callers can fail closed", () => {
    const id = canonicalChipset("SM9999", TABLE);
    expect(id).not.toBeNull();
    expect(id?.canonical).toBe("SM9999");
    expect(id?.tableConsulted).toBe(true);
    expect(id?.knownToRuntime).toBe(false);
    expect(id?.runtimeName).toBeNull();
  });

  it("is told apart from a device that reported no chipset at all", () => {
    // Two different refusals with two different messages: "the runtime does
    // not know this chip" and "this device won't say what chip it is".
    expect(canonicalChipset(null, TABLE)).toBeNull();
    expect(canonicalChipset("  ", TABLE)).toBeNull();
  });
});

describe("when there is no table to consult", () => {
  it("passes the id through, and says the table was not consulted", () => {
    for (const table of [undefined, null, [] as RuntimeChipset[]]) {
      const id = canonicalChipset("SM8850", table);
      expect(id?.canonical).toBe("SM8850");
      expect(id?.tableConsulted).toBe(false);
      expect(id?.knownToRuntime).toBe(false);
    }
  });

  it("cannot resolve a marketing name — there is nothing that could", () => {
    // Deliberate. Guessing "Snapdragon 8 Elite Gen 5" means SM8850 without the
    // runtime saying so is the hand-written mapping this module exists to
    // avoid; the caller refuses instead.
    expect(canon("Snapdragon 8 Elite Gen 5")).toBe("SNAPDRAGON 8 ELITE GEN 5");
    expect(canon("Snapdragon 8 Elite Gen 5")).not.toBe("SM8850");
  });
});

describe("the raw strings survive", () => {
  it("keeps what was reported, what the runtime calls it, and its aliases", () => {
    const id = canonicalChipset("  sm8850 ", TABLE);
    expect(id?.raw).toBe("sm8850");
    expect(id?.runtimeName).toBe("Snapdragon 8 Elite Gen 5 QRD");
    expect(id?.aliases).toEqual([
      "SM8850",
      "Snapdragon 8 Elite Gen 5",
      "sun",
    ]);
    // …and the canonical id is separate from all three, so diagnostics can
    // show the reported value and the decided value side by side.
    expect(id?.canonical).toBe("SM8850");
  });
});

describe("a table whose entries carry no SoC number", () => {
  const nameOnly: RuntimeChipset[] = [
    { name: "Snapdragon 8 Elite Gen 5 QRD", aliases: ["sun"] },
  ];

  it("falls back to the runtime's own name as the canonical id", () => {
    expect(canon("sun", nameOnly)).toBe("SNAPDRAGON 8 ELITE GEN 5 QRD");
  });

  it("then refuses to recognise SM8850, rather than assuming it", () => {
    // Nothing in this table says SM8850 is that chip. Fail closed.
    expect(canonicalChipset("SM8850", nameOnly)?.knownToRuntime).toBe(false);
  });
});

describe("sameChipset", () => {
  it("is true only for one chip", () => {
    const a = canonicalChipset("SM8850", TABLE);
    const b = canonicalChipset("Snapdragon 8 Elite Gen 5 QRD", TABLE);
    const c = canonicalChipset("SM8750", TABLE);
    expect(sameChipset(a, b)).toBe(true);
    expect(sameChipset(a, c)).toBe(false);
  });

  it("never matches an absent id, not even against another absent one", () => {
    expect(sameChipset(null, null)).toBe(false);
    expect(sameChipset(canonicalChipset("SM8850", TABLE), null)).toBe(false);
  });
});
