// What actually goes out on the wire for an NPU load.
//
// A JSON `null` is not "absent" once it reaches Android. `org.json`'s
// `optString(key, fallback)` returns `JSON.toString()` of the JSONObject.NULL
// sentinel — the four-character string "null" — and never takes the fallback
// branch (the platform's own bytecode: `JSONObject$1.toString()` is
// `const-string v0, "null"`). So `tokenizerPath: null` crossed the bridge as a
// PATH called "null", the native tokenizer fallback never ran, and QAIRT died
// on `qwen3::makePipeline failed: failed to open file: null`.
//
// The native side no longer reads a JSON null as a value. These tests pin the
// other half: such a value never goes out in the first place.

import { npuLoadRequest } from "../npu";
import type { NpuLoadConfig } from "../npu";

const AI_HUB_BUNDLE: NpuLoadConfig = {
  modelName: "qualcomm/Qwen3-4B-Instruct-2507",
  modelPath:
    "/data/user/0/com.cosmico.vesta/files/geniex/models/qualcomm/Qwen3-4B-Instruct-2507/part3_of_4.bin",
  // What the backend sends for every catalogue bundle: the model manager owns
  // the tokenizer, so Vesta has no path of its own to offer.
  tokenizerPath: null,
};

describe("the NPU load request", () => {
  it("does not send a null tokenizer path", () => {
    expect(JSON.stringify(npuLoadRequest(AI_HUB_BUNDLE))).not.toContain("null");
  });

  it("drops the key entirely rather than blanking it", () => {
    // An empty string is a path too, and would defeat the native fallback just
    // as a null did. Absent means absent.
    expect("tokenizerPath" in npuLoadRequest(AI_HUB_BUNDLE)).toBe(false);
  });

  it("keeps every value the caller actually supplied", () => {
    expect(npuLoadRequest(AI_HUB_BUNDLE)).toEqual({
      modelName: AI_HUB_BUNDLE.modelName,
      modelPath: AI_HUB_BUNDLE.modelPath,
    });
  });

  it("passes a real tokenizer path straight through", () => {
    const withTokenizer: NpuLoadConfig = {
      ...AI_HUB_BUNDLE,
      tokenizerPath: "/data/local/bundle/tokenizer.json",
    };
    expect(npuLoadRequest(withTokenizer)).toEqual(withTokenizer);
  });

  it("drops an undefined the same way it drops a null", () => {
    expect(
      npuLoadRequest({ modelName: "x", modelPath: undefined }),
    ).toEqual({ modelName: "x" });
  });

  it("leaves a request with nothing to say empty, not full of nulls", () => {
    expect(npuLoadRequest({ modelName: null, modelPath: null })).toEqual({});
  });
});
