// Compatible is not downloadable.
//
// On device, every Qwen entry started downloading and every Llama entry and
// Falcon3 returned `rc=-100000` instantly. The reason is one field, and
// `AiHubSource::plan()` checks it before it does anything else:
//
//   let release_assets_url = &entry.manifest_urls.release_assets;
//   if release_assets_url.is_empty() {
//       return Err(Error::Hub("No pre-compiled assets available … due to
//           licensing restrictions … manually export the model"));
//   }
//
// `list_hub_models()` does not check it — it filters on the supported runtime
// and the chipset only — which is why models nobody can download were being
// offered with a Download button.
//
// The rule under test is that field and nothing else. Not the model family:
// "every Llama failed" is an observation, and Qualcomm can publish a Llama
// bundle tomorrow. Not `supported_runtimes`: Falcon3 advertises the runtime and
// ships nothing.

import {
  pullabilityIndex,
  pullabilityOf,
  countPullability,
  describePullabilityCounts,
  type PullabilityReport,
} from "../npu-pullability";

/** The three models the device sweep actually covered. */
const REPORT: PullabilityReport = {
  manifestExists: true,
  modelCount: 220,
  models: [
    {
      id: "qwen3_4b_instruct_2507",
      displayName: "Qwen3-4B-Instruct-2507",
      hasReleaseAssets: true,
    },
    {
      id: "llama_v3_2_3b_chat",
      displayName: "Llama-v3.2-3B-Chat",
      hasReleaseAssets: false,
    },
    {
      id: "falcon3_7b_instruct",
      displayName: "Falcon3-7B-Instruct",
      hasReleaseAssets: false,
    },
  ],
};

const index = () => pullabilityIndex(REPORT);

describe("the rule", () => {
  it("calls a non-empty release_assets downloadable", () => {
    expect(pullabilityOf("qualcomm/Qwen3-4B-Instruct-2507", index())).toBe(
      "downloadable",
    );
  });

  it("calls an empty release_assets manual-export", () => {
    // The Falcon3 case, verbatim: the runtime named it in logcat and returned
    // -100000 with the sentence dropped.
    expect(pullabilityOf("qualcomm/Falcon3-7B-Instruct", index())).toBe(
      "manual-export",
    );
  });

  it("classifies a failing Llama the same way, on the same field", () => {
    expect(pullabilityOf("qualcomm/Llama-v3.2-3B-Chat", index())).toBe(
      "manual-export",
    );
  });

  // The thing that must not creep back in.
  it("does not classify by model family", () => {
    // A Llama whose assets ARE published is downloadable, whatever the others
    // in its family do.
    const published = pullabilityIndex({
      models: [
        { id: "llama_v3_2_3b_chat", displayName: "Llama-v3.2-3B-Chat", hasReleaseAssets: true },
      ],
    });
    expect(pullabilityOf("qualcomm/Llama-v3.2-3B-Chat", published)).toBe("downloadable");
  });

  it("matches on the repo part, whatever org prefix the hub used", () => {
    for (const name of [
      "qualcomm/Falcon3-7B-Instruct",
      "ai-hub-models/Falcon3-7B-Instruct",
      "Falcon3-7B-Instruct",
    ]) {
      expect(pullabilityOf(name, index())).toBe("manual-export");
    }
  });

  it("matches the manifest id as well as the display name", () => {
    expect(pullabilityOf("qualcomm/falcon3_7b_instruct", index())).toBe("manual-export");
  });

  it("is case-insensitive, because the two spellings differ in case", () => {
    expect(pullabilityOf("qualcomm/QWEN3-4B-INSTRUCT-2507", index())).toBe(
      "downloadable",
    );
  });
});

// Unknown is a real state and must never collapse into either of the others:
// declaring a model undownloadable on no evidence hides one that works.
describe("before anything has been read", () => {
  it("is unknown with no index at all", () => {
    expect(pullabilityOf("qualcomm/Qwen3-4B-Instruct-2507", null)).toBe("unknown");
  });

  it("is unknown when the manifest has not been cached yet", () => {
    const report: PullabilityReport = {
      manifestExists: false,
      error: "no cached manifest yet",
    };
    expect(pullabilityIndex(report)).toBeNull();
    expect(pullabilityOf("qualcomm/Falcon3-7B-Instruct", pullabilityIndex(report))).toBe(
      "unknown",
    );
  });

  it("is unknown when the read failed", () => {
    expect(pullabilityIndex({ error: "boom" })).toBeNull();
  });

  it("is unknown for a model the manifest does not list", () => {
    expect(pullabilityOf("qualcomm/Something-Else", index())).toBe("unknown");
  });

  it("is unknown for an empty name", () => {
    expect(pullabilityOf("qualcomm/", index())).toBe("unknown");
  });
});

// The device's own numbers: 14 compatible, and not 14 installable.
describe("the counts the screen shows", () => {
  const compatible = [
    "qualcomm/Qwen3-4B-Instruct-2507",
    "qualcomm/Llama-v3.2-3B-Chat",
    "qualcomm/Falcon3-7B-Instruct",
    "qualcomm/Not-In-The-Manifest",
  ];

  it("separates compatible from downloadable", () => {
    const counts = countPullability(compatible, index());
    expect(counts).toEqual({
      compatible: 4,
      downloadable: 1,
      manualExport: 2,
      unknown: 1,
    });
  });

  it("never folds unknown into either real answer", () => {
    const counts = countPullability(compatible, null);
    expect(counts.downloadable).toBe(0);
    expect(counts.manualExport).toBe(0);
    expect(counts.unknown).toBe(4);
  });

  it("reads as a sentence, and omits what it has nothing to say about", () => {
    expect(
      describePullabilityCounts({
        compatible: 14,
        downloadable: 10,
        manualExport: 4,
        unknown: 0,
      }),
    ).toBe("14 compatible · 10 directly downloadable · 4 require manual export");

    // Before the manifest is read, the only honest line is the first one.
    expect(
      describePullabilityCounts({
        compatible: 14,
        downloadable: 0,
        manualExport: 0,
        unknown: 14,
      }),
    ).toBe("14 compatible · 14 not yet known");
  });
});
