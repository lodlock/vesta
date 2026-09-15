// One canonical name per piece of silicon.
//
// Three different parties name the chip in this phone, and on the OnePlus 15
// they do not use the same words:
//
//   Android      `Build.SOC_MODEL`            → "SM8850"
//   GenieX       `ChipsetInfo.name`           → a marketing/device name
//                                               ("Snapdragon 8 Elite Gen 5 QRD")
//   the bundle   the catalog's `targetSoc`    → "SM8850"
//
// All three are the same chip. Comparing them as strings says they are three
// different chips, and the compatibility guard — which refuses on any
// disagreement, correctly — then refuses a bundle that would have run.
//
// This module is the single place that turns any of those spellings into one
// canonical id, so the guard can keep comparing with `===` and keep refusing on
// every real difference.
//
// ## What decides that two names are the same chip
//
// The runtime's own table, and nothing else. `ModelManagerWrapper.listChipsets()`
// returns `ChipsetInfo(name, aliases)` — read out of geniex-android 0.4.0 with
// `javap`, those two fields are all it has; there is no separate machine-readable
// id field. But the record as a whole IS the machine-readable answer: every
// spelling inside one entry is a spelling Qualcomm declares equivalent.
//
// So equality here is set membership in a runtime-supplied equivalence class.
// It is NOT, and must never become:
//   - substring matching (`contains("Elite")`)
//   - prefix matching (`SM88…`)
//   - edit distance
//   - inferring a generation from a marketing name
// SM8750 and SM8850 are different silicon, one digit apart, and a context
// binary built for one does not run on the other.
//
// The pattern below picks a *label* for an equivalence class that has already
// been established by the table. It never decides whether two names match.

/** One row of `listChipsets()` — the runtime's own vocabulary. */
export interface RuntimeChipset {
  name: string;
  aliases: string[];
}

export interface ChipsetIdentity {
  /**
   * The id every spelling of this chip reduces to. Compare these, never the
   * raw strings.
   */
  canonical: string;
  /** Exactly what we were handed, untouched — for diagnostics. */
  raw: string;
  /** The runtime's own name for this chip, when its table had an entry. */
  runtimeName: string | null;
  /** Every other spelling the runtime declared equivalent, raw. */
  aliases: string[];
  /** Whether a non-empty runtime table was available to consult at all. */
  tableConsulted: boolean;
  /**
   * Whether the table was consulted AND had this chip in it.
   *
   * False with `tableConsulted` true is the fail-closed case: the runtime has
   * never heard of this silicon, so it cannot be trusted to reject a bundle
   * built for different silicon either.
   */
  knownToRuntime: boolean;
}

/**
 * Canonical form of a single chipset id, before the table is consulted.
 *
 * Case and a vendor prefix are noise — `qcom-sm8850`, `SM8850` and `sm8850` are
 * one chipset. Nothing else is normalized away on purpose: SM8850 and SM8750
 * differ by one character and are different silicon.
 */
export function normalizeChipsetId(
  soc: string | null | undefined,
): string | null {
  if (!soc) return null;
  const trimmed = soc.trim().toUpperCase().replace(/^QCOM[-_]?/, "");
  return trimmed.length > 0 ? trimmed : null;
}

// A Qualcomm SoC model number: "SM8850", "SM8750", "SM8650". This is the id
// Android reports, the id the catalog files bundles under, and the only one of
// the spellings in a ChipsetInfo that is stable across SDK releases and
// marketing rebrands — so when an equivalence class contains one, it is the
// class's name.
//
// Used ONLY to label a class the runtime already grouped. It decides nothing.
const SOC_MODEL = /^SM[0-9]{3,4}[A-Z0-9]*$/;

/**
 * The label for an equivalence class: its SoC model number when it has one,
 * otherwise the runtime's own name for it.
 *
 * Deterministic — shortest SoC-model-shaped member, ties broken
 * lexicographically — because this string ends up in refusal messages and in
 * diagnostics, where a value that moves between runs is worse than useless.
 */
function labelFor(chip: RuntimeChipset): string {
  const members = [chip.name, ...(chip.aliases ?? [])]
    .map(normalizeChipsetId)
    .filter((id): id is string => id !== null);

  const socModels = members.filter((id) => SOC_MODEL.test(id));
  if (socModels.length > 0) {
    return socModels.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
  }
  // No SoC number anywhere in the class. The runtime's own name is then the
  // most stable thing available, and it is still a canonical id because every
  // member of the class resolves to it.
  return normalizeChipsetId(chip.name) ?? members[0];
}

function findEntry(
  id: string,
  table: RuntimeChipset[],
): RuntimeChipset | undefined {
  return table.find(
    (chip) =>
      normalizeChipsetId(chip.name) === id ||
      (chip.aliases ?? []).some((alias) => normalizeChipsetId(alias) === id),
  );
}

/**
 * Resolves one chipset spelling — from Android, from the runtime, or from a
 * bundle's target — to a canonical identity.
 *
 * Returns null only when there is no id at all to resolve. A chip the runtime
 * has never heard of still comes back as an identity, with `knownToRuntime`
 * false, so the caller can tell "no chipset reported" apart from "chipset the
 * runtime does not recognise" and refuse each with the right words.
 *
 * @param table `undefined` or empty means the runtime's table was not available
 *   — the identity then carries the normalized id alone, which is what the
 *   pre-runtime paths (a default build, a probe that hasn't run) already
 *   compare on.
 */
export function canonicalChipset(
  soc: string | null | undefined,
  table?: RuntimeChipset[] | null,
): ChipsetIdentity | null {
  const id = normalizeChipsetId(soc);
  if (!id) return null;

  const raw = String(soc).trim();
  const consultable = !!table && table.length > 0;
  if (!consultable) {
    return {
      canonical: id,
      raw,
      runtimeName: null,
      aliases: [],
      tableConsulted: false,
      knownToRuntime: false,
    };
  }

  const entry = findEntry(id, table!);
  if (!entry) {
    return {
      canonical: id,
      raw,
      runtimeName: null,
      aliases: [],
      tableConsulted: true,
      knownToRuntime: false,
    };
  }

  return {
    canonical: labelFor(entry),
    raw,
    runtimeName: entry.name,
    aliases: [...(entry.aliases ?? [])],
    tableConsulted: true,
    knownToRuntime: true,
  };
}

/** True when two spellings name the same silicon. Null is never equal to anything. */
export function sameChipset(
  a: ChipsetIdentity | null,
  b: ChipsetIdentity | null,
): boolean {
  return a !== null && b !== null && a.canonical === b.canonical;
}
