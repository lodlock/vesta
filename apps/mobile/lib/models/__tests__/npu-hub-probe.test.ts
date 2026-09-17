// Which spelling does the runtime recognise?
//
// Three -100010s, each from a different wrong string, is enough evidence that
// guessing the next one is a bad strategy. `resolveAlias()` is the only public
// call that asks the SDK directly, so the probe asks it once per candidate and
// reports every answer rather than picking one.
//
// What is tested here is the candidate set and the reporting. The resolver is
// injected, so none of this needs a device — and deliberately, none of it
// decides anything: choosing between the answers is a human's job.

import {
  identityCandidates,
  probeHubIdentity,
  formatProbe,
  formatCacheReport,
  formatListProbe,
  formatChipsetIdentity,
  formatGenieXLog,
  formatInstalledReport,
  mentionsModel,
  type GenieXLogLike,
  type InstalledReportLike,
} from "../npu-hub-probe";

const QWEN = "qualcomm/Qwen3-4B-Instruct-2507";

describe("the spellings worth asking about", () => {
  it("covers every form that has actually been in play", () => {
    const candidates = identityCandidates(QWEN, null).map((c) => c.candidate);
    // The catalog entry, the org the sample uses, the org the device returns,
    // the bare manifest id, and the QAIRT plugin's own registry style.
    expect(candidates).toContain(QWEN);
    expect(candidates).toContain("ai-hub-models/Qwen3-4B-Instruct-2507");
    expect(candidates).toContain("Qwen3-4B-Instruct-2507");
    expect(candidates).toContain("qwen3_4b_instruct_2507");
  });

  it("includes what listHubModels actually returned, attributed", () => {
    const rows = identityCandidates("ai-hub-models/Qwen3-4B-Instruct-2507", QWEN);
    const hubRow = rows.find((r) => r.candidate === QWEN);
    expect(hubRow?.source).toContain("listHubModels()");
  });

  it("asks about each distinct string once, merging where they coincide", () => {
    // The catalog entry already IS the device-org form today, so the two must
    // not produce a duplicate row.
    const candidates = identityCandidates(QWEN, QWEN).map((c) => c.candidate);
    expect(new Set(candidates).size).toBe(candidates.length);
    const merged = identityCandidates(QWEN, QWEN).find(
      (c) => c.candidate === QWEN,
    );
    expect(merged?.source).toContain("catalog entry");
  });

  it("derives from whatever model it is given, not from a hard-coded name", () => {
    const candidates = identityCandidates("org/Some-Other-Model", null).map(
      (c) => c.candidate,
    );
    expect(candidates).toContain("ai-hub-models/Some-Other-Model");
    expect(candidates).toContain("some_other_model");
  });

  it("copes with a name that has no org segment", () => {
    const candidates = identityCandidates("bare", null).map((c) => c.candidate);
    expect(candidates).toContain("bare");
    expect(candidates).toContain("ai-hub-models/bare");
  });
});

describe("asking the runtime", () => {
  it("reports every answer, including the ones that came back empty", () => {
    // A null is an ANSWER — "the runtime has nothing to say about this
    // spelling" is different from "it echoed it back" — so it is reported
    // rather than dropped.
    const resolve = async (name: string) =>
      name === QWEN ? "resolved/name" : null;
    return probeHubIdentity(QWEN, null, resolve, QWEN, "AIHUB").then((probe) => {
      expect(probe.rows.length).toBeGreaterThan(1);
      expect(probe.rows.find((r) => r.candidate === QWEN)?.resolved).toBe(
        "resolved/name",
      );
      expect(
        probe.rows.filter((r) => r.resolved === null).length,
      ).toBeGreaterThan(0);
    });
  });

  it("survives a resolver that throws, and keeps the other rows", () => {
    const resolve = async (name: string) => {
      if (name.startsWith("ai-hub-models/")) throw new Error("bridge gone");
      return "ok";
    };
    return probeHubIdentity(QWEN, null, resolve, QWEN, "AIHUB").then((probe) => {
      expect(
        probe.rows.find((r) => r.candidate.startsWith("ai-hub-models/"))?.resolved,
      ).toBeNull();
      expect(probe.rows.some((r) => r.resolved === "ok")).toBe(true);
    });
  });

  it("records what the install path would actually send", () => {
    return probeHubIdentity(QWEN, null, async () => null, QWEN, "AIHUB").then(
      (probe) => {
        expect(probe.pullName).toBe(QWEN);
        expect(probe.hub).toBe("AIHUB");
      },
    );
  });

  it("gives every value its own full-length line, under its own label", () => {
    // The screen truncated `qualcomm/Qwen3-4B-Instruct-2507` and
    // `ai-hub-models/Qwen3-4B-Instruct-2507` down to an identical stub — they
    // differ only in a prefix, and a two-column layout put that prefix off the
    // right edge. So the text form never abbreviates and never aligns.
    return probeHubIdentity(
      QWEN,
      null,
      async (n) => (n.startsWith("ai-hub-models/") ? "resolved/x" : null),
      QWEN,
      "AIHUB",
    ).then((probe) => {
      const lines = formatProbe(probe).split("\n");

      // Each candidate appears ALONE on a line, whole.
      for (const row of probe.rows) {
        expect(lines).toContain(row.candidate);
      }
      expect(lines).toContain("ai-hub-models/Qwen3-4B-Instruct-2507");
      expect(lines).toContain(QWEN);

      // Nothing is shortened.
      expect(formatProbe(probe)).not.toContain("…");
      expect(formatProbe(probe)).not.toContain("...");
    });
  });

  it("keeps the four values distinguishable, each explicitly labelled", () => {
    // Pull name, hub, candidate and resolveAlias result. Conflating any two of
    // them is how the last three attempts went wrong.
    return probeHubIdentity(QWEN, null, async () => null, QWEN, "AIHUB").then(
      (probe) => {
        const text = formatProbe(probe);
        expect(text).toContain("Pull model name: " + QWEN);
        expect(text).toContain("HubSource: AIHUB");
        expect(text).toContain("Candidate:");
        expect(text).toContain("resolveAlias:");
        expect(text).toContain("source: ");
      },
    );
  });

  it("writes <null> for a resolver that answered nothing", () => {
    // Distinct from the string echoing back unchanged, and distinct from a
    // blank — a blank reads as neither.
    return probeHubIdentity(QWEN, null, async () => null, QWEN, "AIHUB").then(
      (probe) => {
        const lines = formatProbe(probe).split("\n");
        expect(lines).toContain("<null>");
        // Every resolveAlias label is followed by a real value, never by a
        // blank. Blank lines DO appear — they separate entries — so the
        // invariant is about position, not about their absence.
        lines.forEach((line, i) => {
          if (line === "resolveAlias:") expect(lines[i + 1]).not.toBe("");
        });
      },
    );
  });
});

// The runtime caches its hub metadata under our own data directory, so the
// manifests listHubModels() and pull() consulted are files we can read.
// listHubModels() finds Qwen3-4B-Instruct-2507 and pull() reports it missing;
// both cannot be true of one manifest, and this is how a human sees which.
describe("the cache report", () => {
  const REPO = "Qwen3-4B-Instruct-2507";

  it("says plainly whether a cached manifest mentions the model", () => {
    expect(mentionsModel('{"id":"Qwen3-4B-Instruct-2507"}', REPO)).toContain(
      REPO,
    );
    // And catches the other spellings a manifest might key on.
    expect(mentionsModel('{"id":"qwen3_4b_instruct_2507"}', REPO)).toContain(
      "qwen3_4b_instruct_2507",
    );
    expect(mentionsModel('{"models":[]}', REPO)).toEqual([]);
  });

  it("marks a manifest that does NOT mention it, which is the whole point", () => {
    const text = formatCacheReport(
      {
        dataDir: "/data/geniex",
        dataDirExists: true,
        files: [
          {
            path: "aihub/info.json",
            sizeBytes: 12,
            modifiedAt: 0,
            content: '{"models":[]}',
          },
        ],
      },
      REPO,
    );
    expect(text).toContain(`mentions ${REPO}: NO`);
  });

  // This used to assert the opposite — "includes JSON bodies whole, an
  // abbreviated manifest answers nothing" — and that is what took the app down:
  // whole bodies plus whole matched entries built a 3.38 MB report, and
  // `Clipboard.setString` is a Binder call that cannot carry it
  // (TransactionTooLargeException, data parcel size 3377296 bytes). The body is
  // still available, in the form that has no size limit: logcat.
  describe("JSON bodies", () => {
    const body = '{"models":[{"id":"Qwen3-4B-Instruct-2507","domain":"qualcomm"}]}';
    const report = {
      dataDir: "/data/geniex",
      dataDirExists: true,
      files: [
        { path: "aihub/info.json", sizeBytes: 99, modifiedAt: 0, content: body },
      ],
    };

    it("keeps the finding but not the file in a summary", () => {
      const text = formatCacheReport(report, REPO, "summary");
      expect(text).not.toContain(body);
      // The finding the body was there for survives: does it mention the model.
      expect(text).toContain(`mentions ${REPO}`);
      // And the omission is stated, with its size and where to find it.
      expect(text).toContain("content omitted");
      expect(text).toContain(`${body.length} chars`);
      expect(text).toContain("logcat");
    });

    it("includes them whole in the full form", () => {
      const text = formatCacheReport(report, REPO, "full");
      expect(text).toContain(body);
    });

    it("summarises by default, so a careless caller cannot dump", () => {
      expect(formatCacheReport(report, REPO)).not.toContain(body);
    });
  });

  it("reports the endpoint and release, and says when they are unset", () => {
    // Unset is an ANSWER: it means the SDK's built-in default applies, and it
    // is what decides which manifest gets fetched.
    const text = formatCacheReport(
      {
        env: {
          GENIEX_AIHUBBASEURL: null,
          GENIEX_AIHUBVERSION: null,
          GENIEX_DATADIR: null,
          GENIEX_HFTOKEN: "unset",
        },
        files: [],
      },
      REPO,
    );
    expect(text).toContain("GENIEX_AIHUBBASEURL: <unset>");
    expect(text).toContain("GENIEX_AIHUBVERSION: <unset>");
  });

  it("never reports a token value, only whether one is set", () => {
    const text = formatCacheReport(
      {
        env: {
          GENIEX_AIHUBBASEURL: null,
          GENIEX_AIHUBVERSION: null,
          GENIEX_DATADIR: null,
          GENIEX_HFTOKEN: "set",
        },
        files: [],
      },
      REPO,
    );
    expect(text).toContain("GENIEX_HFTOKEN: set");
    // The native side only ever sends "set"/"unset"; nothing here can leak one.
    expect(text).not.toMatch(/hf_[A-Za-z0-9]{8,}/);
  });

  it("survives an empty or failed report without inventing content", () => {
    expect(formatCacheReport({ error: "boom" }, REPO)).toContain("error: boom");
    expect(formatCacheReport({}, REPO)).toContain("files: 0");
    expect(formatCacheReport({}, REPO)).toContain("dataDir: <none>");
  });
});

// The manifest the runtime cached is 311 KB and reports no mention of the
// friendly display name. That is not yet an answer: the model could be present
// under its internal id. So the report states three things explicitly — an
// exact display_name match, an exact id match, and every Qwen3-shaped entry in
// full — rather than one substring verdict.
describe("the targeted manifest analysis", () => {
  const REPO = "Qwen3-4B-Instruct-2507";

  const withAnalysis = (
    analysis: Record<string, unknown>,
    detail: "summary" | "full" = "summary",
  ) =>
    formatCacheReport(
      {
        dataDir: "/data/geniex",
        dataDirExists: true,
        files: [
          {
            path: "aihub/manifest.json",
            sizeBytes: 311319,
            modifiedAt: 0,
            analysis,
          },
        ],
      },
      REPO,
      detail,
    );

  it("answers both exact-match questions separately", () => {
    const text = withAnalysis({
      modelCount: 19,
      exactDisplayName: false,
      exactId: true,
      matches: [],
    });
    expect(text).toContain("exact display_name match: NO");
    expect(text).toContain("exact id match: YES");
  });

  it("reports the model count and which key held them", () => {
    const text = withAnalysis({ modelsKey: "models", modelCount: 19 });
    expect(text).toContain("modelsKey: models");
    expect(text).toContain("modelCount: 19");
  });

  it("surfaces top-level version fields, which identify the release", () => {
    const text = withAnalysis({
      versionFields: { aihm_version: "0.60.0", version: "2" },
      modelCount: 19,
    });
    expect(text).toContain("aihm_version: 0.60.0");
    expect(text).toContain("version: 2");
  });

  // Also inverted, and for the same reason: 12 entries at 4000 characters is
  // 48 KB per JSON file, and the geniex directory holds dozens of them.
  describe("matching entries", () => {
    const entry =
      '{"id":"falcon3_7b_instruct","display_name":"Falcon3-7B-Instruct",' +
      '"domain":"qualcomm","supported_chipsets":["qualcomm-snapdragon-8-elite-gen5"],' +
      '"supported_runtimes":["RUNTIME_GENIE"]}';
    const summary =
      "id=falcon3_7b_instruct display_name=Falcon3-7B-Instruct domain=qualcomm " +
      "runtimes=[RUNTIME_GENIE] chipsets=[qualcomm-snapdragon-8-elite-gen5]";

    it("counts them, and keeps the compact summary, in both forms", () => {
      // The summary is a few hundred bytes and carries the fields a pull's
      // manifest inference actually reads — including whether the entry offers
      // RUNTIME_GENIEX_QAIRT at all, which is the question -100000 refuses to
      // answer on its own.
      for (const detail of ["summary", "full"] as const) {
        const text = withAnalysis(
          { modelCount: 220, matches: [entry], matchSummaries: [summary] },
          detail,
        );
        expect(text).toContain("entries matching needle: 1");
        expect(text).toContain(summary);
      }
    });

    it("leaves the raw entry out of a summary, and says so", () => {
      const text = withAnalysis(
        { modelCount: 220, matches: [entry], matchSummaries: [summary] },
        "summary",
      );
      expect(text).not.toContain(entry);
      expect(text).toContain("raw entries omitted");
      expect(text).toContain("logcat");
    });

    it("includes the raw entry in the full form", () => {
      const text = withAnalysis(
        { modelCount: 220, matches: [entry], matchSummaries: [summary] },
        "full",
      );
      expect(text).toContain(entry);
    });
  });

  it("does not fall back to dumping the file when an analysis exists", () => {
    // The whole point of parsing natively is that 311 KB never crosses the
    // bridge or reaches logcat.
    const text = formatCacheReport(
      {
        files: [
          {
            path: "aihub/manifest.json",
            sizeBytes: 311319,
            modifiedAt: 0,
            content: "SHOULD-NOT-APPEAR",
            analysis: { modelCount: 19 },
          },
        ],
      },
      REPO,
    );
    expect(text).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("reports a parse failure rather than reading it as 'not present'", () => {
    const text = withAnalysis({ parseError: "Unterminated object" });
    expect(text).toContain("parseError: Unterminated object");
  });
});

describe("the hub-list probe", () => {
  const probe = (over: Record<string, unknown> = {}) => ({
    chipset: null,
    before: { exists: true, sizeBytes: 311319, modifiedAt: 1000 },
    after: { exists: true, sizeBytes: 311319, modifiedAt: 1000 },
    count: 19,
    models: [
      { name: "qualcomm/Qwen3-4B-Instruct-2507", modelType: "LLM", chipsets: ["SM8850"] },
      { name: "qualcomm/Other", modelType: "LLM", chipsets: ["SM8850"] },
    ],
    ...over,
  });

  it("prints only the matching entries, verbatim, with their chipsets", () => {
    const text = formatListProbe(probe(), "qwen3");
    expect(text).toContain("name: qualcomm/Qwen3-4B-Instruct-2507");
    expect(text).toContain("chipsets: SM8850");
    expect(text).toContain('entries matching "qwen3": 1');
    // The other 18 are a count, not 18 rows.
    expect(text).not.toContain("qualcomm/Other");
    expect(text).toContain("count: 19");
  });

  it("says whether the call changed the manifest under it", () => {
    // The tell: if listing rewrites the file the pull then reads, the two are
    // not looking at the same bytes.
    expect(formatListProbe(probe(), "qwen3")).toContain(
      "manifest changed by this call: no",
    );
    const touched = probe({
      after: { exists: true, sizeBytes: 400000, modifiedAt: 2000 },
    });
    expect(formatListProbe(touched, "qwen3")).toContain(
      "manifest changed by this call: YES",
    );
  });

  // The old label printed `listHubModels(null)`, and a capture carrying that
  // line beside the runtime's own `chipset "null" not found in platform.json`
  // read as a bug in the argument. It was not one: absent is the SDK's declared
  // default and its unfiltered query. The label now distinguishes the two.
  it("says an unfiltered call was unfiltered, not that it passed null", () => {
    const text = formatListProbe(probe(), "qwen3");
    expect(text).toContain("every model the hub has");
    expect(text).not.toContain("listHubModels(null)");
  });

  it("names the chipset when one was actually passed", () => {
    expect(formatListProbe(probe({ chipset: "SM8850" }), "qwen3")).toContain(
      "listHubModels(chipset: SM8850)",
    );
  });

  it("survives a failed call and an absent manifest", () => {
    const text = formatListProbe(
      { error: "boom", before: undefined, after: undefined },
      "qwen3",
    );
    expect(text).toContain("error: boom");
    expect(text).toContain("manifest before: <absent>");
  });
});

describe("GenieX's own log, reported", () => {
  const capture = (over: Partial<GenieXLogLike> = {}): GenieXLogLike => ({
    tag: "GenieXSdk",
    command: "logcat -d -v threadtime -t 400 -s GenieXSdk:V",
    sdkStarted: true,
    lines: [
      "09-15 10:00:00.001  4211  4211 V GenieXSdk: [TRACE] dispatch: probing plugins",
      "09-15 10:00:00.002  4211  4211 I GenieXSdk: [ INFO] geniex model manager initialized",
    ],
    lineCount: 2,
    totalLines: 2,
    truncated: false,
    byPriority: { V: 1, D: 0, I: 1, W: 0, E: 0 },
    sawStdoutSelfTest: true,
    sawStderrSelfTest: true,
    verboseSeen: true,
    ...over,
  });

  it("prints the capture verbatim, under a header that explains it", () => {
    const text = formatGenieXLog(capture());
    expect(text).toContain("tag: GenieXSdk");
    expect(text).toContain("by priority: V=1 D=0 I=1 W=0 E=0");
    expect(text).toContain("[TRACE] dispatch: probing plugins");
    expect(text).toContain("[ INFO] geniex model manager initialized");
  });

  // The whole point of the header: a VERBOSE line IS a GenieX TRACE line that
  // passed the level gate, so seeing one proves on-device that nothing is
  // being filtered — which is why no verbosity setting was added.
  it("reports whether TRACE is reaching logcat", () => {
    expect(formatGenieXLog(capture())).toContain("TRACE reaching logcat: YES");
    expect(
      formatGenieXLog(capture({ verboseSeen: false, byPriority: undefined })),
    ).toContain("TRACE reaching logcat: no VERBOSE line in this capture");
  });

  // Three quite different states all produce zero lines, and a reader has to
  // be able to tell them apart.
  it("distinguishes an empty buffer from an SDK that never started", () => {
    const quiet = formatGenieXLog(
      capture({ lines: [], lineCount: 0, verboseSeen: false }),
    );
    expect(quiet).toContain("SDK started: yes");
    expect(quiet).toContain("<no GenieX lines in the buffer>");

    const dead = formatGenieXLog(
      capture({
        sdkStarted: false,
        initError: "libgeniex_plugin_qairt.so is not present as a file",
        lines: [],
        lineCount: 0,
      }),
    );
    expect(dead).toContain("SDK started: NO");
    expect(dead).toContain(
      "init error: libgeniex_plugin_qairt.so is not present as a file",
    );
  });

  it("says when the capture hit its budget, so a gap is not read as silence", () => {
    expect(
      formatGenieXLog(
        capture({ truncated: true, lineCount: 400, totalLines: 1312 }),
      ),
    ).toContain("lines: 400 of 1312 (newest kept, older dropped)");
  });

  it("surfaces the self-tests that prove the stdout redirect is live", () => {
    const text = formatGenieXLog(
      capture({ sawStdoutSelfTest: false, sawStderrSelfTest: true }),
    );
    expect(text).toContain("stdout redirect self-test seen: no");
    expect(text).toContain("stderr redirect self-test seen: YES");
  });

  it("survives a capture that failed outright", () => {
    const text = formatGenieXLog({ error: "logcat: permission denied" });
    expect(text).toContain("error: logcat: permission denied");
    expect(text).toContain("<no GenieX lines in the buffer>");
  });
});

describe("what the runtime considers installed", () => {
  // The shape of the case under investigation: GenieX returned rc=0, the
  // bundle is in list(), getPaths() resolves — and there is a zero-byte .lock
  // beside the weights, which is what checkBundle() rejected the install on.
  const pulled: InstalledReportLike = {
    installed: ["qualcomm/Qwen3-4B-Instruct-2507"],
    installedCount: 1,
    probes: [
      {
        asked: "qualcomm/Qwen3-4B-Instruct-2507",
        inList: true,
        resolveAlias: "qualcomm/Qwen3-4B-Instruct-2507",
        getPaths: true,
        resolvedName: "qualcomm/Qwen3-4B-Instruct-2507",
        modelDir: "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3",
        modelPath: "/data/user/0/com.cosmico.vesta/files/geniex/models/qwen3",
        tokenizerPath: "…/tokenizer.json",
        runtimeId: "qairt",
        modelType: "LLM",
        getType: "LLM",
        dirExists: true,
        fileCount: 3,
        totalBytes: 2_380_000_000,
        zeroLengthFiles: [".lock"],
        files: [
          { path: ".lock", sizeBytes: 0 },
          { path: "metadata.json", sizeBytes: 4096 },
          { path: "weights_1.bin", sizeBytes: 2_379_995_904 },
        ],
      },
    ],
  };

  it("separates the register from the paths — they are two answers", () => {
    const text = formatInstalledReport(pulled);
    expect(text).toContain("list(): 1 model(s)");
    expect(text).toContain("in list(): YES");
    expect(text).toContain("getPaths: RESOLVED");
  });

  // The identity question: the catalogue name against the manager's cache key.
  it("says whether the resolved identity is the one asked for", () => {
    expect(formatInstalledReport(pulled)).toContain("identity matches asked: yes");
    const renamed: InstalledReportLike = {
      ...pulled,
      probes: [{ ...pulled.probes![0], resolvedName: "Qwen3-4B-Instruct-2507" }],
    };
    expect(formatInstalledReport(renamed)).toContain("identity matches asked: NO");
  });

  // The finding itself, made legible: a complete 2.38 GB bundle whose only
  // zero-length file is GenieX's own lock.
  it("names the zero-length files rather than burying them in the listing", () => {
    const text = formatInstalledReport(pulled);
    expect(text).toContain("zero-length files: .lock");
    expect(text).toContain("0\t.lock");
    expect(text).toContain("files: 3, 2380000000 bytes");
  });

  it("reports a clean bundle as having none", () => {
    const clean: InstalledReportLike = {
      ...pulled,
      probes: [{ ...pulled.probes![0], zeroLengthFiles: [] }],
    };
    expect(formatInstalledReport(clean)).toContain("zero-length files: none");
  });

  // Asking for an identity that is absent is the only way to get "it is gone"
  // as an answer rather than as an omission.
  it("distinguishes a missing model from one that merely has no paths", () => {
    const gone = formatInstalledReport({
      installed: [],
      installedCount: 0,
      probes: [{ asked: "qualcomm/Qwen3-4B-Instruct-2507", inList: false, getPaths: false }],
    });
    expect(gone).toContain("list(): 0 model(s)");
    expect(gone).toContain("in list(): no");
    expect(gone).toContain("getPaths: <null>");
    // Nothing downstream is printed for a probe with no paths.
    expect(gone).not.toContain("modelDir:");
  });

  it("survives a report that failed outright", () => {
    expect(formatInstalledReport({ error: "runtime unavailable" })).toContain(
      "error: runtime unavailable",
    );
  });
});

// The Hub identity probe's chipset half.
//
// This replaces a pair of listHubModels() calls — one unfiltered, one with the
// literal "SM8850" — that were made to "measure" what the parameter meant. The
// released 0.4.0 signature is `listHubModels(chipset: String? = null)`, so the
// first was production's own call repeated and the second was a guess at a key
// in the runtime's platform.json, which fails the whole call when wrong. A
// failed call is not a measurement.
//
// The question underneath was worth asking: which spelling of this chip does
// the SDK accept. Everything needed to answer it is already in the app — the
// device's SoC, the runtime's equivalence table, and the keys the hub itself
// published — so this reports that, with no call and no guess.
describe("the chipset identity block", () => {
  const TABLE = [
    {
      name: "Snapdragon 8 Elite Gen 5 QRD",
      aliases: ["SM8850", "qualcomm-snapdragon-8-elite-gen5"],
    },
    { name: "Snapdragon 8 Elite QRD", aliases: ["SM8750"] },
  ];
  const MODELS = [
    {
      name: "qualcomm/Qwen3-4B-Instruct-2507",
      modelType: "LLM",
      chipsets: ["qualcomm-snapdragon-8-elite-gen5"],
    },
    { name: "qualcomm/Older", modelType: "LLM", chipsets: ["SM8750"] },
  ];

  const full = () =>
    formatChipsetIdentity({ deviceSoc: "SM8850", table: TABLE, models: MODELS });

  // E: the identity evidence that must survive the simplification.
  it("reports the device SoC, the runtime's name for it, and its aliases", () => {
    const text = full();
    expect(text).toContain("device SoC (Build.SOC_MODEL): SM8850");
    expect(text).toContain("runtime name for this chip: Snapdragon 8 Elite Gen 5 QRD");
    expect(text).toMatch(/runtime aliases: .*qualcomm-snapdragon-8-elite-gen5/);
    expect(text).toContain("known to runtime: YES");
  });

  it("reports the canonical target", () => {
    expect(full()).toContain("canonical target: SM8850");
  });

  // The thing the second listHubModels() call was reaching for: a chipset
  // spelling the RUNTIME supplied, rather than one Vesta guessed.
  it("reports the hub's own chipset keys for this device", () => {
    const text = full();
    expect(text).toContain(
      "hub chipset keys for this device: qualcomm-snapdragon-8-elite-gen5",
    );
    // Not the key for the other silicon in the same catalogue.
    expect(text).not.toMatch(/hub chipset keys for this device:.*SM8750/);
    expect(text).toContain("hub models offered for it: 1 of 2");
  });

  it("separates a table never consulted from one that came back empty", () => {
    expect(
      formatChipsetIdentity({ deviceSoc: "SM8850", table: undefined, models: null }),
    ).toContain("runtime chipset table: not consulted");
    expect(
      formatChipsetIdentity({ deviceSoc: "SM8850", table: [], models: null }),
    ).toContain("runtime chipset table: empty");
  });

  it("says the chip is unknown to the runtime rather than inventing an entry", () => {
    // Fail closed, and say so: SM8750 and SM8850 are one digit apart and are
    // different silicon.
    const text = formatChipsetIdentity({
      deviceSoc: "SM7999",
      table: TABLE,
      models: MODELS,
    });
    expect(text).toContain("known to runtime: NO");
    expect(text).toContain("hub chipset keys for this device: <none>");
  });

  it("survives having no hub answer and no SoC at all", () => {
    const text = formatChipsetIdentity({
      deviceSoc: null,
      table: TABLE,
      models: null,
    });
    expect(text).toContain("device SoC (Build.SOC_MODEL): <unknown>");
    expect(text).toContain("hub chipset keys for this device: <no hub answer yet>");
  });
});

// The compact forms, pinned where the formatters live — because that is where
// the next edit to them will land. The end-to-end version of this is
// lib/diagnostics/__tests__/post-probe-summary.test.ts.
describe("staying compact on a populated device", () => {
  const REPO = "Qwen3-4B-Instruct-2507";

  it("counts the data directory rather than walking it", () => {
    const files = [
      {
        path: "aihub/manifest.json",
        sizeBytes: 311_319,
        modifiedAt: 0,
        analysis: { modelsKey: "models", modelCount: 19 },
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        path: `models/qualcomm/${REPO}/weights_${i}.bin`,
        sizeBytes: 54_090_909,
        modifiedAt: 0,
      })),
    ];
    const summary = formatCacheReport({ files }, REPO, "summary");

    expect(summary).toContain("files: 41");
    expect(summary).toContain("listed below: 1 of 41");
    expect(summary).toContain("aihub/manifest.json");
    // A weights shard is inventory. It says nothing about whether the hub
    // publishes this model, and after a pull there are dozens of it.
    expect(summary).not.toContain("weights_0.bin");

    // The full form still walks everything.
    const full = formatCacheReport({ files }, REPO, "full");
    expect(full).toContain("weights_39.bin");
  });

  // The single line that made the post-probe summary unsendable.
  it("counts top-level keys instead of printing a vocabulary", () => {
    const topLevelKeys = Array.from({ length: 50_000 }, (_, i) => `tok_${i}`);
    const report = {
      files: [
        { path: "vocab.json", sizeBytes: 2_776_833, modifiedAt: 0, analysis: { topLevelKeys } },
      ],
    };
    const summary = formatCacheReport(report, REPO, "summary");
    expect(summary).toContain("topLevelKeys: 50000 keys: tok_0,");
    expect(summary).toContain("49992 more");
    expect(summary).not.toContain("tok_49999");
    expect(summary.length).toBeLessThan(2000);

    expect(formatCacheReport(report, REPO, "full")).toContain("tok_49999");
  });

  it("keeps a short key list whole — the count is for runaways only", () => {
    const summary = formatCacheReport(
      {
        files: [
          {
            path: "aihub/manifest.json",
            sizeBytes: 10,
            modifiedAt: 0,
            analysis: { topLevelKeys: ["models", "version"], modelCount: 1 },
          },
        ],
      },
      REPO,
      "summary",
    );
    expect(summary).toContain("topLevelKeys: models, version");
  });

  it("drops the bundle's file listing from an installed summary, and says so", () => {
    const report: InstalledReportLike = {
      installed: ["qualcomm/Qwen3-4B-Instruct-2507"],
      installedCount: 1,
      probes: [
        {
          asked: "qualcomm/Qwen3-4B-Instruct-2507",
          inList: true,
          getPaths: true,
          resolvedName: "qualcomm/Qwen3-4B-Instruct-2507",
          dirExists: true,
          fileCount: 48,
          totalBytes: 2_380_000_000,
          zeroLengthFiles: [".lock"],
          files: Array.from({ length: 48 }, (_, i) => ({
            path: `weights_${i}.bin`,
            sizeBytes: 54_090_909,
          })),
        },
      ],
    };
    const summary = formatInstalledReport(report, "summary");

    // The counts the listing was there to support survive.
    expect(summary).toContain("files: 48, 2380000000 bytes");
    expect(summary).toContain("zero-length files: .lock");
    expect(summary).toContain("48 files not listed");
    expect(summary).not.toContain("weights_0.bin");

    // And the default is still the complete form, which is what the shared
    // report and logcat want.
    expect(formatInstalledReport(report)).toContain("weights_47.bin");
  });
});
