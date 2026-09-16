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
  formatGenieXLog,
  mentionsModel,
  type GenieXLogLike,
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

  it("includes JSON bodies whole — an abbreviated manifest answers nothing", () => {
    const body = '{"models":[{"id":"Qwen3-4B-Instruct-2507","domain":"qualcomm"}]}';
    const text = formatCacheReport(
      {
        dataDir: "/data/geniex",
        dataDirExists: true,
        files: [
          { path: "aihub/info.json", sizeBytes: 99, modifiedAt: 0, content: body },
        ],
      },
      REPO,
    );
    expect(text).toContain(body);
    expect(text).not.toContain("…");
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

  const withAnalysis = (analysis: Record<string, unknown>) =>
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

  it("prints whole matching entries, not a summary of them", () => {
    const entry =
      '{"id":"qwen3_4b_instruct_2507","display_name":"Qwen3-4B-Instruct-2507",' +
      '"domain":"qualcomm","supported_chipsets":["qualcomm-snapdragon-8-elite-gen5"]}';
    const text = withAnalysis({ modelCount: 19, matches: [entry] });
    expect(text).toContain(entry);
    expect(text).toContain("entries matching needle: 1");
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
    filter: null,
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

  it("records which filter was passed, including none", () => {
    expect(formatListProbe(probe(), "qwen3")).toContain("listHubModels(null)");
    expect(formatListProbe(probe({ filter: "SM8850" }), "qwen3")).toContain(
      "listHubModels(SM8850)",
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
