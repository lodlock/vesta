// The assistant turn: system gesture → transcript → action, or an answer.
//
// The claims worth locking down are about WHEN the model is loaded and WHAT
// gets spoken. A scheduling command must reach the device intent with the
// weights untouched; an unhandled request must reach the model without the user
// tapping anything; and nothing the model thought to itself may be shown or
// said. So ensureModelLoaded and speak are mocked and asserted against, not
// just the visible outcome.

import { useAssistStore } from "../assist-store";
import { processMessage, executeToolCall } from "../../orchestrator/orchestrator";
import { startAssistCapture } from "../../native/assist";
import { speak, stopSpeaking } from "../../native/speech";
import { getConfig } from "../../storage/database";

jest.mock("../../orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  executeToolCall: jest.fn(),
}));
jest.mock("../../native/assist", () => ({
  startAssistCapture: jest.fn(async () => {}),
}));
jest.mock("../../native/speech", () => ({
  speak: jest.fn(async () => "done"),
  stopSpeaking: jest.fn(),
}));
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null), // unset → both assistant settings ON
}));

// `mock`-prefixed so the factory may close over it (jest hoists these).
const mockEnsureModelLoaded = jest.fn(async () => {});
jest.mock("../chat-store", () => ({
  useChatStore: {
    getState: () => ({ language: "en", ensureModelLoaded: mockEnsureModelLoaded }),
  },
}));

const mockProcess = processMessage as jest.MockedFunction<typeof processMessage>;
const mockExecute = executeToolCall as jest.MockedFunction<typeof executeToolCall>;
const mockCapture = startAssistCapture as jest.MockedFunction<typeof startAssistCapture>;
const mockSpeak = speak as jest.MockedFunction<typeof speak>;
const mockStop = stopSpeaking as jest.MockedFunction<typeof stopSpeaking>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().dismiss();
  mockSpeak.mockResolvedValue("done");
  mockConfig.mockResolvedValue(null);
});

const state = () => useAssistStore.getState();
const spokenWords = () => mockSpeak.mock.calls.map((c) => c[0]);

const toolCall = (message: string, success = true) =>
  ({
    type: "tool_call" as const,
    tool: "set_timer",
    parameters: { minutes: 5 },
    message,
    result: { success, message: success ? "ok" : "failed" },
  });

describe("scheduling stays local", () => {
  it("runs the action, speaks it, and never loads the model", async () => {
    mockProcess.mockResolvedValue(toolCall("Timer set for 5 minutes"));

    await state().handle("set a five minute timer");

    expect(mockProcess).toHaveBeenCalledWith("set a five minute timer", [], "en");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    expect(spokenWords()).toEqual(["Timer set for 5 minutes"]);
  });

  it("dismisses itself once the confirmation has been spoken", async () => {
    mockProcess.mockResolvedValue(toolCall("Timer set for 5 minutes"));

    await state().handle("set a five minute timer");

    // Speech is awaited before the overlay goes, so the tail isn't clipped.
    expect(mockSpeak).toHaveBeenCalled();
    expect(state().active).toBe(false);
  });

  it("stays open when the action FAILED", async () => {
    mockProcess.mockResolvedValue(toolCall("No clock app installed", false));

    await state().handle("set a five minute timer");

    expect(state()).toMatchObject({ active: true, phase: "done", failed: true });
    expect(spokenWords()).toEqual(["No clock app installed"]);
  });

  it("gates a destructive action, then dismisses after confirming", async () => {
    mockProcess.mockResolvedValue({
      type: "pending_tool_call",
      tool: "set_alarm",
      parameters: { time: "07:00" },
      message: "Alarm set for 07:00 tomorrow",
    });

    await state().handle("wake me at seven");

    expect(state()).toMatchObject({ active: true, phase: "confirm" });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();

    mockExecute.mockResolvedValue({ success: true, message: "Alarm set for 07:00" });
    await state().confirm(true);

    expect(mockExecute).toHaveBeenCalledWith("set_alarm", { time: "07:00" }, "en");
    expect(state().active).toBe(false);
  });
});

describe("clarification stays local", () => {
  it("asks aloud without loading the model, and completes the original", async () => {
    mockProcess.mockResolvedValueOnce({
      type: "text",
      content: "Do you mean 4 AM or 4 PM?",
    });

    await state().handle("set an alarm tomorrow at four");

    expect(state()).toMatchObject({ active: true, phase: "clarify" });
    expect(spokenWords()).toEqual(["Do you mean 4 AM or 4 PM?"]);
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();

    await state().listenAgain();
    expect(mockCapture).toHaveBeenCalled();

    mockProcess.mockResolvedValueOnce(toolCall("Alarm set for 16:00 tomorrow"));
    await state().handle("pm");

    expect(mockProcess).toHaveBeenLastCalledWith(
      "set an alarm tomorrow at four pm",
      [],
      "en",
    );
    // Resolved by the parser — still no model.
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("falls back to the model only if the CLARIFIED request still declines", async () => {
    mockProcess.mockResolvedValueOnce({ type: "text", content: "What time?" });
    await state().handle("set an alarm");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();

    mockProcess
      .mockResolvedValueOnce({ type: "error", error: "No model loaded" })
      .mockResolvedValueOnce({ type: "text", content: "I couldn't work that out." });
    await state().handle("whenever, you decide");

    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
  });
});

describe("catch-all fallback", () => {
  it("routes a declined utterance to the model with no extra tap", async () => {
    mockProcess
      .mockResolvedValueOnce({ type: "error", error: "No model loaded" })
      .mockResolvedValueOnce({ type: "text", content: "Providence." });

    await state().handle("what is the capital of rhode island");

    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
    // Second call runs in assist mode, which disables the reasoning pass.
    expect(mockProcess).toHaveBeenLastCalledWith(
      "what is the capital of rhode island",
      [],
      "en",
      undefined,
      undefined,
      undefined,
      { assistMode: true },
    );
    expect(state()).toMatchObject({ phase: "answer", message: "Providence." });
  });

  it("keeps the answer on the assistant overlay and speaks it", async () => {
    mockProcess
      .mockResolvedValueOnce({ type: "error", error: "No model loaded" })
      .mockResolvedValueOnce({ type: "text", content: "Providence." });

    await state().handle("what is the capital of rhode island");

    // No navigation to chat, and the overlay stays up to be read.
    expect(state().active).toBe(true);
    expect(spokenWords()).toEqual(["Providence."]);
  });

  it("shows nothing the model thought to itself", async () => {
    mockProcess.mockResolvedValueOnce({ type: "error", error: "No model loaded" }).mockResolvedValueOnce({
      type: "text",
      content:
        "<think>The user wants a capital. Rhode Island's capital is Providence.</think>Providence is the capital.",
    });

    await state().handle("what is the capital of rhode island");

    expect(state().message).toBe("Providence is the capital.");
    expect(state().message).not.toMatch(/think|user wants/i);
    expect(spokenWords()).toEqual(["Providence is the capital."]);
  });

  it("does not load the model when the setting is off", async () => {
    mockConfig.mockImplementation(async (key: string) =>
      key === "assist_auto_model" ? "false" : null,
    );
    mockProcess.mockResolvedValueOnce({ type: "error", error: "No model loaded" });

    await state().handle("tell me a story");

    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    expect(state().phase).toBe("fallback");

    // ...and the manual button still works.
    mockProcess.mockResolvedValueOnce({ type: "text", content: "Once upon a time." });
    await state().askModel();
    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
  });
});

describe("speech lifecycle", () => {
  it("says nothing when speaking is turned off", async () => {
    mockConfig.mockImplementation(async (key: string) =>
      key === "assist_speak" ? "false" : null,
    );
    mockProcess.mockResolvedValue(toolCall("Timer set for 5 minutes"));

    await state().handle("set a five minute timer");

    expect(mockSpeak).not.toHaveBeenCalled();
    // Still dismisses — speech is an enhancement, not a gate.
    expect(state().active).toBe(false);
  });

  it("cuts off the previous answer when invoked again", async () => {
    mockProcess.mockResolvedValue(toolCall("Timer set for 5 minutes"));
    await state().handle("set a five minute timer");
    mockStop.mockClear();

    await state().handle("set another timer");

    expect(mockStop).toHaveBeenCalled();
  });

  it("cuts off speech when dismissed", () => {
    state().dismiss();
    expect(mockStop).toHaveBeenCalled();
  });

  it("does not let a silent engine hold the overlay open", async () => {
    // An engine that never reports back.
    mockSpeak.mockImplementation(() => new Promise(() => {}));
    mockProcess.mockResolvedValue(toolCall("Timer set for 5 minutes"));

    jest.useFakeTimers();
    const turn = state().handle("set a five minute timer");
    await jest.advanceTimersByTimeAsync(20000);
    await turn;
    jest.useRealTimers();

    expect(state().active).toBe(false);
  });
});
