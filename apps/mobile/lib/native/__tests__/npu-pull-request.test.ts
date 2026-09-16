// What actually goes out on the wire for an AI Hub pull.
//
// The request is built in one place so every catalogue model is treated the
// same way, and exactly one field is decided there: `display_name`. These
// tests pin down that the rest of the request is passed through untouched —
// the experiment is only worth running if it has a single variable.

import { aiHubPullRequest } from "../npu";
import type { NpuPullConfig } from "../npu";

const HUB_ROW: NpuPullConfig = {
  modelName: "qualcomm/Qwen3-4B-Instruct-2507",
  chipset: "SM8850",
  precision: null,
  hub: "AIHUB",
  // The card title the installer passes, which is what used to go out.
  displayName: "Qwen3 4B Instruct 2507",
};

describe("the AI Hub pull request", () => {
  it("sends the display_name the catalogue name implies", () => {
    expect(aiHubPullRequest(HUB_ROW).displayName).toBe("Qwen3-4B-Instruct-2507");
  });

  it("keeps the full catalogue string as the model name", () => {
    expect(aiHubPullRequest(HUB_ROW).modelName).toBe(
      "qualcomm/Qwen3-4B-Instruct-2507",
    );
  });

  // The single-variable guarantee: hub, chipset and precision are what the
  // caller decided, and this must not become a second place they are chosen.
  it("changes nothing else about the request", () => {
    const { displayName, ...rest } = aiHubPullRequest(HUB_ROW);
    const { displayName: _was, ...original } = HUB_ROW;
    expect(rest).toEqual(original);
    expect(displayName).not.toBe(_was);
  });

  it("is generic — any qualcomm/ row gets the same treatment", () => {
    expect(
      aiHubPullRequest({ ...HUB_ROW, modelName: "qualcomm/Llama-v3.2-3B-Chat" })
        .displayName,
    ).toBe("Llama-v3.2-3B-Chat");
  });

  // A name from any other hub is left exactly as the caller built it, down to
  // the display name — this experiment is scoped to the AI Hub catalogue.
  it("leaves a non-Qualcomm request byte-identical", () => {
    const other: NpuPullConfig = {
      ...HUB_ROW,
      modelName: "ai-hub-models/Qwen3-4B-Instruct-2507",
      hub: "AUTO",
      displayName: "Qwen3 4B Instruct (2507)",
    };
    expect(aiHubPullRequest(other)).toEqual(other);
  });

  it("leaves a request with no derivable name alone rather than blanking it", () => {
    const bare: NpuPullConfig = { ...HUB_ROW, modelName: "qualcomm/" };
    expect(aiHubPullRequest(bare).displayName).toBe("Qwen3 4B Instruct 2507");
  });
});
