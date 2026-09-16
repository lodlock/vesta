// The two remaining nullable fields that crossed the bridge as the word "null".
//
// Same defect as the tokenizer path, same cause: Android's `org.json` reads a
// JSON null back as the four-character string "null" — `optString(key,
// fallback)` returns `JSON.toString()` of the JSONObject.NULL sentinel and
// never takes the fallback branch. So a null `precision` became the precision
// "null", and a null hub `filter` became a chipset by that name, which the
// runtime reported on device as `chipset "null" not found in platform.json`.
//
// The native bridge now reads both with `stringOrNull`. These tests pin the
// other half — that neither value goes out as a JSON null in the first place —
// and, just as importantly, that a real string is still passed through
// untouched. The contract drops `null` and `undefined` and nothing else.

import { npuPullRequest, npuHubListProbeRequest } from "../npu";
import type { NpuPullConfig } from "../npu";

const HUB_PULL: NpuPullConfig = {
  modelName: "qualcomm/Qwen3-4B-Instruct-2507",
  chipset: "SM8850",
  precision: null,
  hub: "AIHUB",
  displayName: "Qwen3 4B Instruct 2507",
};

describe("the precision on an AI Hub pull", () => {
  it("does not send a null precision", () => {
    expect("precision" in npuPullRequest(HUB_PULL)).toBe(false);
  });

  it("does not send a missing precision either", () => {
    const { precision: _omitted, ...noPrecision } = HUB_PULL;
    expect("precision" in npuPullRequest(noPrecision)).toBe(false);
  });

  it("keeps a real precision exactly as it was given", () => {
    expect(npuPullRequest({ ...HUB_PULL, precision: "w4a16" }).precision).toBe(
      "w4a16",
    );
  });

  // The helper drops the two JavaScript values that mean "nothing". A hub that
  // genuinely named a precision "null" would have to reach the runtime spelled
  // that way — guessing otherwise is how this bug started.
  it("treats the STRING \"null\" as a value, not as absence", () => {
    expect(npuPullRequest({ ...HUB_PULL, precision: "null" }).precision).toBe(
      "null",
    );
  });

  // The single-variable guarantee this path already had: display_name is the
  // only field decided here, and nothing else about the request moves.
  it("leaves model identity, chipset, hub and display_name alone", () => {
    expect(npuPullRequest(HUB_PULL)).toEqual({
      modelName: "qualcomm/Qwen3-4B-Instruct-2507",
      chipset: "SM8850",
      hub: "AIHUB",
      displayName: "Qwen3-4B-Instruct-2507",
    });
  });
});

// `listHubModels(chipset: String? = null)` — the released 0.4.0 signature, read
// out of the bytecode: the parameter is named `chipset`, carries @Nullable, and
// has a Kotlin default. So an absent chipset is the SDK's own unfiltered query,
// and it has to arrive absent: a JSON null read back with optString() is the
// four-character string "null", and the runtime then looks for a chipset by
// that name — `chipset "null" not found in platform.json`.
describe("the chipset on a hub list probe", () => {
  it("does not send a null chipset", () => {
    expect(npuHubListProbeRequest(null)).toEqual({});
  });

  it("sends no chipset key at all, rather than an empty one", () => {
    expect(JSON.stringify(npuHubListProbeRequest(null))).toBe("{}");
  });

  // Absence must not survive as the WORD for absence anywhere in the payload.
  it("puts no \"null\" anywhere in the serialised request", () => {
    expect(JSON.stringify(npuHubListProbeRequest(null))).not.toContain("null");
  });

  // A key the runtime supplied is passed through byte for byte. Nothing in
  // Vesta currently sends one — see the probe — but the bridge must not be the
  // thing that mangles it when something does.
  it("passes a real chipset straight through", () => {
    expect(npuHubListProbeRequest("SM8850")).toEqual({ chipset: "SM8850" });
  });

  it("treats the STRING \"null\" as a chipset, not as absence", () => {
    // Not special-cased: "null" is a string a caller chose, and silently
    // reading it as absence would hide the very bug this shape exists to stop.
    expect(npuHubListProbeRequest("null")).toEqual({ chipset: "null" });
  });
});
