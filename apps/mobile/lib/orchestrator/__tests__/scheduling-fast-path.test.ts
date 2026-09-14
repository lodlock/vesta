// The deterministic scheduling fast path, at the orchestrator boundary.
//
// Two things must hold: a confidently-parsed scheduling command never reaches
// the LLM (that is the whole point — no sampling in the path that arms an
// alarm), and everything else still does, unchanged. The confirmation gate is
// the same one the model-routed path uses, so a destructive tool must still
// come back as pending rather than firing.

import { processMessage } from "../orchestrator";
import { generate, isLoaded } from "../../llm/llm-engine";
import { dispatchToolCall } from "../tool-dispatcher";

jest.mock("../../llm/llm-engine", () => ({
  generate: jest.fn(),
  isLoaded: jest.fn(() => true),
}));
jest.mock("../tool-dispatcher", () => ({ dispatchToolCall: jest.fn() }));
jest.mock("../memory-manager", () => ({
  getMemoriesForPrompt: jest.fn(async () => null),
  extractMemories: jest.fn(async () => {}),
  shouldExtractMemory: jest.fn(() => false),
  cancelExtraction: jest.fn(),
}));
jest.mock("../knowledge-manager", () => ({
  getKnowledgeForPrompt: jest.fn(async () => null),
}));
jest.mock("../session-warmer", () => ({ schedulePrefixPersist: jest.fn() }));
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => "true"), // confirmations ON
}));

const mockGenerate = generate as jest.MockedFunction<typeof generate>;
const mockDispatch = dispatchToolCall as jest.MockedFunction<typeof dispatchToolCall>;
const mockIsLoaded = isLoaded as jest.MockedFunction<typeof isLoaded>;

const SENT_AT = new Date(2026, 8, 16, 10, 0, 0);

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLoaded.mockReturnValue(true);
  mockDispatch.mockResolvedValue({ success: true, message: "ok" });
});

const send = (text: string, lang: "en" | "it" = "en") =>
  processMessage(text, [], lang, undefined, undefined, SENT_AT);

describe("fast path — resolved commands never reach the model", () => {
  it("runs a stammered timer without generating", async () => {
    const res = await send("set a uh set a five five minute timer");

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(res.type).toBe("tool_call");
    // set_timer is not confirm-gated, so it dispatches directly.
    expect(mockDispatch).toHaveBeenCalledWith("set_timer", { minutes: 5 }, "en");
  });

  it("gates a self-corrected alarm for confirmation instead of arming it", async () => {
    const res = await send("alarm for eight… no, eight thirty tomorrow");

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(res.type).toBe("pending_tool_call");
    if (res.type === "pending_tool_call") {
      expect(res.tool).toBe("set_alarm");
      expect(res.parameters).toMatchObject({ time: "08:30" });
    }
    // Nothing touched the device during routing.
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("asks for clarification instead of guessing an ambiguous time", async () => {
    const res = await send("give me forty-five minutes, but remind me five minutes before too");

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(res.type).toBe("text");
    if (res.type === "text") expect(res.content).toMatch(/two things at once/i);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("asks in Italian when the language is Italian", async () => {
    const res = await send("metti un timer", "it");
    expect(res).toEqual({ type: "text", content: "Di quanto deve essere il timer?" });
  });

  it("works with no model loaded", async () => {
    mockIsLoaded.mockReturnValue(false);

    const res = await send("set a timer for thirty seconds");

    expect(res.type).toBe("tool_call");
    expect(mockDispatch).toHaveBeenCalledWith("set_timer", { minutes: 0.5 }, "en");
  });
});

describe("fast path — everything else still goes to the model", () => {
  it("passes ordinary conversation through to generate", async () => {
    mockGenerate.mockResolvedValue({
      text: "Ciao!",
      reasoningContent: "",
      tokensPredicted: 0,
      tokensEvaluated: 0,
      timings: { promptMs: 0, predictedMs: 0, predictedPerSecond: 0 },
      stoppedByLimit: false,
      stoppedByUser: false,
    });

    const res = await send("tell me something about the hearth");

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ type: "text", content: "Ciao!" });
  });

  it("still reports no model loaded for a non-scheduling message", async () => {
    mockIsLoaded.mockReturnValue(false);

    expect(await send("what's the weather like")).toEqual({
      type: "error",
      error: "No model loaded",
    });
  });
});
