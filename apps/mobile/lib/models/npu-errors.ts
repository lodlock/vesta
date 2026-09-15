// GenieX return codes, turned into sentences — without losing the code.
//
// A failed install used to reach the user as `rc=-100010: geniex_model_pull
// failed (rc=-100010)`. That is the right information in the wrong form: it
// says nothing about what went wrong or what to do, and it says the same thing
// twice. But the number is also the ONLY token that can be looked up against
// Qualcomm's error definitions, so it must survive into diagnostics verbatim.
//
// Hence two outputs from one input: a `message` for the person, and `rc` kept
// raw for the report.
//
// ## Why this table is short
//
// Only codes with a source are in it. Three come from the SDK's own bytecode
// (`ModelManagerWrapper`'s private constants, read with `javap -constants`),
// and one from Qualcomm's published error definitions. Everything else is
// reported as an unrecognised code with its number intact, because an invented
// explanation for a code nobody verified is worse than no explanation — it
// sends the reader somewhere that isn't the problem.

/** Codes with a verified meaning. Anything absent is reported raw. */
const KNOWN: Record<number, { name: string; message: string }> = {
  // javap -constants on ModelManagerWrapper: GENIEX_SUCCESS = 0
  0: { name: "GENIEX_SUCCESS", message: "Succeeded." },

  // javap -constants: GENIEX_ERROR_CANCELLED = -100006
  [-100006]: {
    name: "GENIEX_ERROR_CANCELLED",
    message: "The download was canceled.",
  },

  // javap -constants: GENIEX_ERROR_ALREADY_INITIALIZED = -100008
  [-100008]: {
    name: "GENIEX_ERROR_ALREADY_INITIALIZED",
    message: "The Qualcomm runtime was already initialized.",
  },

  // Qualcomm's published GenieX error definitions: an HTTP 404 from the hub.
  // The distinction that matters to the reader is that this is about the
  // REMOTE catalogue, not about this phone: nothing about the device, the
  // chipset or the build changes the answer, so retrying the same request is
  // not a fix and neither is buying different hardware.
  [-100010]: {
    name: "GENIEX_ERROR_COMMON_HUB_MODEL_NOT_FOUND",
    message:
      "Qualcomm's model hub does not currently have this NPU model for the requested target. " +
      "You can retry later, or import a compatible SM8850 bundle manually.",
  },
};

export interface GenieXFailure {
  /** The runtime's own code, or null when the failure carried none. */
  rc: number | null;
  /** The constant's name, when the code is one we can source. */
  name: string | null;
  /** What to show the user. Always set. */
  message: string;
  /** The runtime's original string, unmodified, for diagnostics. */
  raw: string;
}

// The native side formats failures as `rc=<n>: <message>[: <nativeMessage>]`,
// with the code first and always. Parsed rather than passed as a separate
// field because a promise rejection across the RN bridge carries one string.
const RC = /(?:^|[^\w-])rc=(-?\d+)/;

/**
 * Reads a GenieX failure out of whatever the bridge threw.
 *
 * Never throws and never returns an empty message: an unparseable error still
 * has to reach the user as something, and the original text is the honest
 * fallback.
 */
export function readGenieXFailure(err: unknown): GenieXFailure {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const match = RC.exec(raw);
  const rc = match ? Number(match[1]) : null;

  if (rc === null) {
    return { rc: null, name: null, message: raw || "The install failed.", raw };
  }

  const known = KNOWN[rc];
  if (known) {
    return { rc, name: known.name, message: known.message, raw };
  }

  // No entry, so no claim about what it means — but the number is still the
  // thing to look up, so it leads.
  return {
    rc,
    name: null,
    message: `The Qualcomm runtime refused this install with code ${rc}.`,
    raw,
  };
}

/**
 * The one-line form for the Models screen: the readable sentence, with the raw
 * code kept on the end so a screenshot is still diagnosable.
 */
export function describeGenieXFailure(err: unknown): string {
  const failure = readGenieXFailure(err);
  if (failure.rc === null) return failure.message;
  return `${failure.message} (${failure.name ?? "code"} ${failure.rc})`;
}

/** True when the hub simply does not carry this asset — the manual-import case. */
export function isHubModelNotFound(err: unknown): boolean {
  return readGenieXFailure(err).rc === -100010;
}
