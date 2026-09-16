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
 * The one-line form for the Models screen: the readable sentence, the raw code,
 * and THE RUNTIME'S OWN WORDS.
 *
 * That last part was missing and it cost a diagnostic round trip. For -100010
 * the runtime composes its message as `"AI Hub model " + <name> + " not found
 * on hub"` — the two halves are visible as separate string constants in
 * libgeniex.so — so it names THE EXACT KEY IT LOOKED UP, after whatever
 * internal normalization it applied. Replacing that with a friendly sentence
 * threw away the one fact that distinguishes "the asset is absent" from "we
 * asked under the wrong name".
 *
 * So the sentence explains and the runtime's text substantiates. Only added
 * when it says something the sentence does not.
 */
export function describeGenieXFailure(err: unknown): string {
  const failure = readGenieXFailure(err);
  if (failure.rc === null) return failure.message;
  const head = `${failure.message} (${failure.name ?? "code"} ${failure.rc})`;
  const detail = runtimeDetail(failure);
  return detail ? `${head} — runtime said: ${detail}` : head;
}

/**
 * The runtime's message with our own `rc=` prefix stripped back off.
 *
 * The native side formats failures as `rc=<n>: <message>`, so the raw string
 * carries both. Null when nothing survives the strip — an empty quote adds
 * noise, not evidence.
 */
function runtimeDetail(failure: GenieXFailure): string | null {
  const withoutRc = failure.raw.replace(/^\s*rc=-?\d+\s*:?\s*/, "").trim();
  if (!withoutRc) return null;
  // The native wrapper repeats the code inside its own text; one mention is
  // enough and the head already carries it.
  return withoutRc === failure.raw.trim() && /^rc=-?\d+$/.test(failure.raw.trim())
    ? null
    : withoutRc;
}

/** True when the hub simply does not carry this asset — the manual-import case. */
export function isHubModelNotFound(err: unknown): boolean {
  return readGenieXFailure(err).rc === -100010;
}

/**
 * The one code an interrupted download is worth simply asking for again.
 *
 * ## What -100005 is, and what it is not
 *
 * It is not named anywhere available. `javap -constants` on
 * `ModelManagerWrapper` yields three codes and this is not among them
 * (`GENIEX_SUCCESS` 0, `GENIEX_ERROR_CANCELLED` -100006,
 * `GENIEX_ERROR_ALREADY_INITIALIZED` -100008); Qualcomm's published definitions
 * gave us -100010 and not this; and `libgeniex.so` carries no constant name for
 * it, because the -1000xx codes are Rust-side integers built as instruction
 * immediates, not strings and not data. Grepping the binary for the name would
 * find nothing because there is nothing to find. So this deliberately does NOT
 * claim a meaning — `npu-errors`' own rule is that an invented explanation for
 * an unverified code is worse than none, and that rule is not suspended because
 * a retry would be convenient.
 *
 * What IS established is the behaviour, from two independent directions.
 *
 * From the device: it appears repeatedly during large pulls, the SAME request
 * has failed and later succeeded with nothing changed, and a retry after a
 * failure at ~97% of 2.4 GB fetched roughly the remainder instead of starting
 * over. A code that resolves itself on an identical request is transient by
 * definition, and one whose partial work survives is safe to resume.
 *
 * From the SDK: `libgeniex.so` carries `GENIEX_DL_CHUNK_SIZE`,
 * `byte range starts at `, `local range short read for ` and two
 * `get_range retry ` messages — one formatted with a transport error, one with
 * an HTTP status — beside `.inflight` and `.progress`. The downloader fetches
 * ranged chunks, already retries them internally, and keeps what it has. A pull
 * failure is what the user sees when those internal retries run out; asking
 * again is resuming, not restarting.
 *
 * ## Why exactly one code
 *
 * Every other rc either has a verified meaning that is NOT transient
 * (-100010 is a 404: the asset is absent, and asking twice cannot publish it;
 * -100006 is the user's own cancel) or has no meaning we can source at all. An
 * unknown code is not evidence of transience — retrying one could mean burning
 * a user's data on a request that can never succeed. So the list is this single
 * number, and it grows only when another code has the same two kinds of
 * evidence behind it.
 */
export function isTransientPullFailure(err: unknown): boolean {
  return readGenieXFailure(err).rc === TRANSIENT_PULL_RC;
}

/**
 * Observed on device as a transient download failure. Named, not inlined, so
 * the number appears once and the tests can state which code they mean.
 */
export const TRANSIENT_PULL_RC = -100005;
