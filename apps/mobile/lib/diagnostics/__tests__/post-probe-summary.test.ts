// The summary after a hub probe, on a device that actually has something on it.
//
// This is the regression. "Copy summary" was compact before a probe and
// ballooned after one, until it hit the 64 KiB guard and came back marked
//
//     --- REPORT CUT HERE ...
//
// The guard was doing its job. The report should never have been that size: two
// sections were putting their FULL form into the compact one, and neither was
// visible on an empty device because both grow with what the device holds.
//
//   - `installed` declared no separate compact form, so the clipboard carried
//     a listing of every file in a 2.4 GB bundle
//   - `hub cache` printed a block per file in the geniex data directory, each
//     with a `topLevelKeys` line — which on a vocabulary file is one entry per
//     token
//
// So the fixture below is a POPULATED device: a cached 19-model manifest, a
// pulled bundle with 48 files, two vocabulary files with 150k keys between
// them, and a 400-line native log. Every number in it is the shape the real
// device reported. If a future section starts leaking its full form, this test
// is where it shows up — on a laptop, rather than on someone's phone.

import { CLIPBOARD_MAX_BYTES, utf8ByteLength } from "../clipboard-safe";
import { buildReports, SECTION_SUMMARY_MAX_BYTES } from "../report";
import { formatHubState, probeSections, type HubDiag } from "../sections";
import type {
  CacheFileLike,
  CacheReportLike,
  GenieXLogLike,
  InstalledReportLike,
  ListProbeLike,
} from "../../models/npu-hub-probe";

const REPO = "Qwen3-4B-Instruct-2507";
const DATA_DIR = "/data/user/0/com.cosmico.vesta/files/geniex";

/** A vocabulary file's worth of top-level keys. This is the line that blew up. */
const vocabKeys = (n: number) =>
  Array.from({ length: n }, (_, i) => `token_${i}_Ġword`);

/** What the data directory looks like after a successful pull. */
function cacheReport(): CacheReportLike {
  const files: CacheFileLike[] = [
    {
      path: "aihub/manifest.json",
      sizeBytes: 311_319,
      modifiedAt: 1_757_900_000_000,
      analysis: {
        topLevelKeys: ["models", "aihm_version", "version"],
        versionFields: { aihm_version: "0.60.0", version: "2" },
        modelsKey: "models",
        modelCount: 19,
        exactDisplayName: true,
        exactId: true,
        matches: [
          '{"id":"qwen3_4b_instruct_2507","display_name":"Qwen3-4B-Instruct-2507",' +
            '"domain":"qualcomm","supported_chipsets":["qualcomm-snapdragon-8-elite-gen5"],' +
            '"supported_runtimes":["RUNTIME_GENIEX_QAIRT"],"manifest_urls":{"release_assets":"https://…"}}'.repeat(
              8,
            ),
        ],
        matchSummaries: [
          "id=qwen3_4b_instruct_2507 display_name=Qwen3-4B-Instruct-2507 " +
            "domain=qualcomm runtimes=[RUNTIME_GENIEX_QAIRT] " +
            "chipsets=[qualcomm-snapdragon-8-elite-gen5] release_assets=YES",
        ],
      },
    },
    {
      path: "aihub/platform.json",
      sizeBytes: 8_420,
      modifiedAt: 1_757_900_000_000,
      content: '{"chipsets":[{"id":"SM8850","aliases":["qualcomm-snapdragon-8-elite-gen5"]}]}',
    },
    // The two that did the damage: parsed JSON, no manifest finding, and one
    // top-level key per token.
    {
      path: `models/qualcomm/${REPO}/vocab.json`,
      sizeBytes: 2_776_833,
      modifiedAt: 1_757_900_100_000,
      analysis: { topLevelKeys: vocabKeys(120_000), modelCount: 0 },
    },
    {
      path: `models/qualcomm/${REPO}/added_tokens.json`,
      sizeBytes: 1_204_991,
      modifiedAt: 1_757_900_100_000,
      analysis: { topLevelKeys: vocabKeys(30_000), modelCount: 0 },
    },
  ];
  // And the bundle itself: shards, configs, a lock. Inventory, not evidence.
  for (let i = 0; i < 44; i++) {
    files.push({
      path: `models/qualcomm/${REPO}/weights_${String(i).padStart(3, "0")}.bin`,
      sizeBytes: 54_090_909,
      modifiedAt: 1_757_900_100_000,
    });
  }
  return { env: {}, dataDir: DATA_DIR, dataDirExists: true, files };
}

function installedReport(): InstalledReportLike {
  return {
    installed: ["qualcomm/Qwen3-4B-Instruct-2507"],
    installedCount: 1,
    probes: [
      {
        asked: "qualcomm/Qwen3-4B-Instruct-2507",
        inList: true,
        resolveAlias: "qualcomm/Qwen3-4B-Instruct-2507",
        getPaths: true,
        resolvedName: "qualcomm/Qwen3-4B-Instruct-2507",
        modelDir: `${DATA_DIR}/models/qualcomm/${REPO}`,
        modelPath: `${DATA_DIR}/models/qualcomm/${REPO}`,
        tokenizerPath: `${DATA_DIR}/models/qualcomm/${REPO}/tokenizer.json`,
        runtimeId: "qairt",
        modelType: "LLM",
        getType: "LLM",
        dirExists: true,
        fileCount: 48,
        totalBytes: 2_380_000_000,
        zeroLengthFiles: [".lock"],
        files: Array.from({ length: 48 }, (_, i) => ({
          path: `models/qualcomm/${REPO}/weights_${String(i).padStart(3, "0")}.bin`,
          sizeBytes: 54_090_909,
        })),
      },
    ],
  };
}

function listProbe(): ListProbeLike {
  return {
    chipset: null,
    before: { exists: true, sizeBytes: 311_319, modifiedAt: 1_757_900_000_000 },
    after: { exists: true, sizeBytes: 311_319, modifiedAt: 1_757_900_000_000 },
    count: 19,
    models: Array.from({ length: 19 }, (_, i) => ({
      name: i === 3 ? `qualcomm/${REPO}` : `qualcomm/Model-${i}`,
      modelType: "LLM",
      chipsets: ["qualcomm-snapdragon-8-elite-gen5", "qualcomm-snapdragon-8-gen-3"],
    })),
  };
}

function genieXLog(): GenieXLogLike {
  const lines = Array.from(
    { length: 400 },
    (_, i) =>
      `09-16 20:1${i % 10}:0${i % 10}.00${i % 10}  4211  4288 V GenieXSdk: ` +
      `[TRACE] dispatch: step ${i} of the pull, plugin=qairt, ` +
      "detail=".padEnd(140, "x"),
  );
  return {
    tag: "GenieXSdk",
    command: "logcat -d -v threadtime -t 400 -s GenieXSdk:V",
    sdkStarted: true,
    lines,
    lineCount: 400,
    totalLines: 1312,
    truncated: true,
    byPriority: { V: 380, D: 4, I: 12, W: 2, E: 2 },
    sawStdoutSelfTest: true,
    sawStderrSelfTest: true,
    verboseSeen: true,
  };
}

/** The numbers the device actually reported, so the assertions are real ones. */
const HUB: HubDiag = {
  checkedAt: 1_757_900_000_000,
  cached: true,
  total: 19,
  compatible: 14,
  otherChipsets: 1,
  unsupportedType: 4,
  pullability: { compatible: 14, downloadable: 5, manualExport: 9, unknown: 0 },
  canonicalSoc: "SM8850",
  error: null,
  activeNpuModel: "Qwen3 4B Instruct 2507",
};

/**
 * The screen's own three sections, as strings.
 *
 * `formatDeviceState` and `formatCacheHealth` live in the screen because they
 * take its gathered state; their shapes are reproduced here at realistic size.
 * The hub-state section is the real formatter, because the counts this test
 * asserts survive are the ones it produces.
 */
const DEVICE_SUMMARY = [
  "Vesta diagnostics — device, runtime and active model",
  "captured: 2026-09-16T20:16:00.000Z (America/New_York)",
  "platform: android 35",
  "active model: Qwen3 4B Instruct 2507",
  "loaded: yes",
  "backend qualcomm_npu: loaded",
  "  soc: SM8850",
  "  canonicalChipset: SM8850",
  "  runtimeVersion: 2.38.0",
  "  lastError: pull failed rc=-100000",
].join("\n");

const CACHE_HEALTH = [
  "Cache health",
  "prefix session cache: present",
  "size: 41.2 MB",
  "primed this session: yes",
  "database: 1.4 MB",
].join("\n");

function build(withProbe: boolean) {
  const probe = withProbe
    ? probeSections({
        repo: REPO,
        pullTrace: "NPU pull trace\n\nattempt 1 (initial)\noutcome: FAILED after 31284 ms\nerror: rc=-100000",
        identityProbe: "Hub identity probe\nPull model name: qualcomm/Qwen3-4B-Instruct-2507",
        chipsetIdentity:
          "Chipset identity\ndevice SoC (Build.SOC_MODEL): SM8850\ncanonical target: SM8850\n" +
          "hub chipset keys for this device: qualcomm-snapdragon-8-elite-gen5\nknown to runtime: YES",
        cache: cacheReport(),
        listProbe: listProbe(),
        installed: installedReport(),
        genieXLog: genieXLog(),
      })
    : [];
  return buildReports([
    {
      name: "device",
      summary: DEVICE_SUMMARY,
      full: `${DEVICE_SUMMARY}\n  (every backend detail key)`,
      essential: true,
    },
    ...probe,
    { name: "hub state", summary: formatHubState(HUB), essential: true },
    { name: "cache health", summary: CACHE_HEALTH, essential: true },
  ]);
}

describe("the summary after a hub probe", () => {
  const after = build(true);

  it("does not truncate — the whole bug, in one assertion", () => {
    expect(after.summary).not.toContain("REPORT CUT HERE");
    expect(after.summaryTruncated).toBe(false);
    expect(after.omitted).toEqual([]);
  });

  it("stays comfortably inside the clipboard guard", () => {
    expect(after.summaryBytes).toBeLessThan(CLIPBOARD_MAX_BYTES);
    // Not "just under". The guard should be nowhere in sight.
    expect(after.summaryBytes).toBeLessThan(20 * 1024);
  });

  it("stays the same order of magnitude as before the probe", () => {
    const before = build(false);
    // The probe adds real content — findings, a pull trace, a log tail — so
    // this is not "no growth". It is growth bounded by the FIELDS rather than
    // by the 2.7 MB vocabulary file sitting next to them.
    expect(after.summaryBytes).toBeGreaterThan(before.summaryBytes);
    expect(after.summaryBytes).toBeLessThan(before.summaryBytes * 12);
  });

  it("leaves every section within its own budget", () => {
    // A name here would say which section is leaking, which is the thing the
    // old whole-report cut never told anybody.
    expect(after.oversized).toEqual([]);
  });
});

describe("what the summary must not carry", () => {
  const summary = build(true).summary;

  it("has no per-file cache inventory", () => {
    expect(summary).not.toContain(`path: models/qualcomm/${REPO}/weights_000.bin`);
    expect(summary).not.toContain("weights_043.bin");
    // The aggregate says the same thing in one line.
    expect(summary).toContain("files: 48");
    expect(summary).toContain("listed below: 1 of 48");
  });

  it("has no model shard or per-model file listing", () => {
    // formatInstalledReport's listing lines are "  <bytes>\t<path>".
    expect(summary).not.toMatch(/\n\s+\d+\tmodels\/qualcomm\//);
    expect(summary).toContain("files: 48, 2380000000 bytes");
    expect(summary).toContain("48 files not listed");
  });

  it("has no vocabulary or token key dump", () => {
    // Worth stating the magnitude, because it is the whole explanation: ONE
    // `topLevelKeys:` line, for ONE of the two vocabulary files, is 2.4 MB.
    // That is 37 times the entire clipboard guard, on a line whose purpose is
    // to say what shape a file is.
    expect(utf8ByteLength(vocabKeys(120_000).join(", "))).toBeGreaterThan(
      2_000_000,
    );
    expect(summary).not.toContain("token_0_Ġword");
    expect(summary).not.toContain("token_119999_Ġword");
    // And the file that carried them is not printed at all: it answers nothing
    // about whether the hub publishes this model.
    expect(summary).not.toContain("vocab.json");
    expect(summary).not.toContain("added_tokens.json");
  });

  it("has no giant topLevelKeys dump", () => {
    // The manifest's own three keys are fine and useful; 150,000 are not.
    expect(summary).toContain("topLevelKeys: models, aihm_version, version");
    expect(summary).not.toMatch(/topLevelKeys:(.{600,})/);
  });

  it("has no raw manifest JSON", () => {
    expect(summary).not.toContain('"supported_runtimes":["RUNTIME_GENIEX_QAIRT"]');
    expect(summary).toContain("raw entries omitted");
  });

  it("has no full GenieX log — the tail, and a count for the rest", () => {
    // The newest lines are the ones a failure is in, so they stay.
    expect(summary).toContain("step 399 of the pull");
    // The other 380 do not.
    expect(summary).not.toContain("step 0 of the pull");
    expect(summary).not.toContain("step 200 of the pull");
    expect(summary).toContain("380 older omitted");
  });
});

describe("what the summary must still carry", () => {
  const summary = build(true).summary;

  it("device, runtime and active model", () => {
    expect(summary).toContain("active model: Qwen3 4B Instruct 2507");
    expect(summary).toContain("backend qualcomm_npu: loaded");
    expect(summary).toContain("runtimeVersion: 2.38.0");
  });

  it("the pull trace outcome", () => {
    expect(summary).toContain("outcome: FAILED after 31284 ms");
    expect(summary).toContain("error: rc=-100000");
  });

  // The counts the device reported, every one of them. These are the reason
  // anybody pastes this report anywhere.
  it("every hub count", () => {
    expect(summary).toContain("models returned: 19");
    expect(summary).toContain("compatible here: 14");
    expect(summary).toContain("5 directly downloadable");
    expect(summary).toContain("9 require manual export");
    expect(summary).toContain("excluded — other chipsets: 1");
    expect(summary).toContain("excluded — unsupported model type: 4");
  });

  it("chipset identity", () => {
    expect(summary).toContain("device SoC (Build.SOC_MODEL): SM8850");
    expect(summary).toContain("canonical target: SM8850");
    expect(summary).toContain("hub chipset keys for this device: qualcomm-snapdragon-8-elite-gen5");
    expect(summary).toContain("known to runtime: YES");
  });

  it("the manifest match and whether a bundle is published for it", () => {
    expect(summary).toContain("exact display_name match: YES");
    expect(summary).toContain("exact id match: YES");
    expect(summary).toContain("release_assets=YES");
    expect(summary).toContain("modelCount: 19");
  });

  it("concise cache health", () => {
    expect(summary).toContain("prefix session cache: present");
    expect(summary).toContain("database: 1.4 MB");
  });

  it("the errors", () => {
    expect(summary).toContain("lastError: pull failed rc=-100000");
  });
});

describe("the full report, unchanged", () => {
  const built = build(true);

  it("still carries everything the summary drops", () => {
    expect(built.full).toContain("weights_043.bin");
    expect(built.full).toContain("token_119999_Ġword");
    expect(built.full).toContain('"supported_runtimes":["RUNTIME_GENIEX_QAIRT"]');
    expect(built.full).toContain("step 399 of the pull");
  });

  it("is never cut", () => {
    expect(built.full).not.toContain("REPORT CUT HERE");
    expect(built.full).not.toContain("SECTION TRIMMED");
    expect(built.fullBytes).toBeGreaterThan(CLIPBOARD_MAX_BYTES);
  });
});

describe("the per-section backstop", () => {
  it("trims only the offending section, and names it", () => {
    const built = buildReports([
      { name: "device", summary: DEVICE_SUMMARY, essential: true },
      { name: "runaway", summary: "leaked line\n".repeat(20_000), essential: true },
      { name: "hub state", summary: formatHubState(HUB), essential: true },
    ]);
    expect(built.oversized).toEqual(["runaway"]);
    expect(built.summary).toContain('SECTION TRIMMED: the compact form of "runaway"');
    // Everything on either side of it survives intact — which the whole-report
    // cut did not do.
    expect(built.summary).toContain("active model: Qwen3 4B Instruct 2507");
    expect(built.summary).toContain("models returned: 19");
    expect(built.summary).not.toContain("REPORT CUT HERE");
  });

  it("bounds a runaway section rather than letting it eat the report", () => {
    const built = buildReports([
      { name: "runaway", summary: "x".repeat(4_000_000), essential: true },
    ]);
    expect(utf8ByteLength(built.summary)).toBeLessThanOrEqual(SECTION_SUMMARY_MAX_BYTES);
  });

  it("does nothing at all to a section of normal size", () => {
    const built = buildReports([
      { name: "hub state", summary: formatHubState(HUB), essential: true },
    ]);
    expect(built.oversized).toEqual([]);
    expect(built.summary).toBe(formatHubState(HUB));
  });
});
