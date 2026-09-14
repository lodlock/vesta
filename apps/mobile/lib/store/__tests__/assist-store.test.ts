// The assistant turn: system gesture → transcript → Android action.
//
// The claim worth locking down is what does NOT happen. A spoken scheduling
// command must reach the device intent without the model being loaded — that
// is the entire reason this path exists rather than reusing the chat screen.
// So `ensureModelLoaded` is mocked and asserted against, not just the outcome.

import { useAssistStore } from "../assist-store";
import { processMessage, executeToolCall } from "../../orchestrator/orchestrator";
import { useChatStore } from "../chat-store";
import { startAssistCapture } from "../../native/assist";

jest.mock("../../orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  executeToolCall: jest.fn(),
}));
jest.mock("../../native/assist", () => ({
  startAssistCapture: jest.fn(async () => {}),
}));

// `mock`-prefixed so the factory may close over it (jest hoists these above
// the imports).
const mockEnsureModelLoaded = jest.fn(async () => {});
jest.mock("../chat-store", () => ({
  useChatStore: {
    getState: () => ({ language: "en", ensureModelLoaded: mockEnsureModelLoaded }),
  },
}));

const mockProcess = processMessage as jest.MockedFunction<typeof processMessage>;
const mockExecute = executeToolCall as jest.MockedFunction<typeof executeToolCall>;
const mockCapture = startAssistCapture as jest.MockedFunction<typeof startAssistCapture>;

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().dismiss();
});

const state = () => useAssistStore.getState();

describe("assist turn — a resolved scheduling command", () => {
  it("runs the action and never loads the model", async () => {
    mockProcess.mockResolvedValue({
      type: "tool_call",
      tool: "set_timer",
      parameters: { minutes: 0.5 },
      message: "Timer set for 30 seconds",
      result: { success: true, message: "ok" },
    });

    await state().handle("set a 30 second timer");

    expect(mockProcess).toHaveBeenCalledWith("set a 30 second timer", [], "en");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      active: true,
      phase: "done",
      failed: false,
      message: "Timer set for 30 seconds",
    });
  });

  it("surfaces a failed action instead of claiming success", async () => {
    mockProcess.mockResolvedValue({
      type: "tool_call",
      tool: "set_timer",
      parameters: { minutes: 1 },
      message: "Timer set for 1 minute",
      result: { success: false, message: "No clock app", error: "no activity" },
    });

    await state().handle("set a one minute timer");

    expect(state().failed).toBe(true);
  });
});

describe("assist turn — a gated action", () => {
  it("waits for confirmation and only then touches the device", async () => {
    mockProcess.mockResolvedValue({
      type: "pending_tool_call",
      tool: "set_alarm",
      parameters: { time: "07:00" },
      message: "Alarm set for 07:00 tomorrow",
    });

    await state().handle("wake me at seven");

    expect(state().phase).toBe("confirm");
    expect(mockExecute).not.toHaveBeenCalled();

    mockExecute.mockResolvedValue({ success: true, message: "Alarm set for 07:00" });
    await state().confirm(true);

    expect(mockExecute).toHaveBeenCalledWith("set_alarm", { time: "07:00" }, "en");
    expect(state()).toMatchObject({ phase: "done", failed: false });
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("cancelling runs nothing", async () => {
    mockProcess.mockResolvedValue({
      type: "pending_tool_call",
      tool: "set_alarm",
      parameters: { time: "07:00" },
      message: "Alarm set for 07:00",
    });

    await state().handle("wake me at seven");
    await state().confirm(false);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(state().phase).toBe("done");
  });
});

describe("assist turn — a clarification", () => {
  it("asks, then completes the ORIGINAL utterance with the answer", async () => {
    mockProcess.mockResolvedValueOnce({
      type: "text",
      content: "Do you mean 4 AM or 4 PM?",
    });

    await state().handle("set an alarm tomorrow at four");

    expect(state()).toMatchObject({
      phase: "clarify",
      message: "Do you mean 4 AM or 4 PM?",
    });
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();

    // Answering re-opens the recognizer...
    await state().listenAgain();
    expect(mockCapture).toHaveBeenCalled();
    expect(state().phase).toBe("listening");

    // ...and the follow-up is parsed as the whole command, so "pm" alone is
    // enough and the parser still needs no conversation state.
    mockProcess.mockResolvedValueOnce({
      type: "tool_call",
      tool: "set_alarm",
      parameters: { time: "16:00", date: "2026-09-17" },
      message: "Alarm set for 16:00 tomorrow",
      result: { success: true, message: "ok" },
    });
    await state().handle("pm");

    expect(mockProcess).toHaveBeenLastCalledWith(
      "set an alarm tomorrow at four pm",
      [],
      "en",
    );
    expect(state().phase).toBe("done");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("does not keep prefixing once a turn resolves", async () => {
    mockProcess.mockResolvedValueOnce({ type: "text", content: "What time?" });
    await state().handle("set an alarm");
    mockProcess.mockResolvedValueOnce({
      type: "tool_call",
      tool: "set_alarm",
      parameters: { time: "07:00" },
      message: "ok",
      result: { success: true, message: "ok" },
    });
    await state().handle("at seven am");
    expect(state().clarifying).toBeNull();

    mockProcess.mockResolvedValueOnce({
      type: "tool_call",
      tool: "set_timer",
      parameters: { minutes: 5 },
      message: "ok",
      result: { success: true, message: "ok" },
    });
    await state().handle("five minute timer");
    expect(mockProcess).toHaveBeenLastCalledWith("five minute timer", [], "en");
  });
});

describe("assist turn — not a scheduling command", () => {
  it("offers the model rather than loading it", async () => {
    mockProcess.mockResolvedValueOnce({ type: "error", error: "No model loaded" });

    await state().handle("tell me a story");

    expect(state().phase).toBe("fallback");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("loads the model only when the user asks for the fallback", async () => {
    mockProcess.mockResolvedValueOnce({ type: "error", error: "No model loaded" });
    await state().handle("tell me a story");

    mockProcess.mockResolvedValueOnce({ type: "text", content: "Once upon a time…" });
    await state().askModel();

    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ phase: "answer", message: "Once upon a time…" });
  });
});

describe("assist session lifecycle", () => {
  it("dismiss clears everything so the next gesture starts clean", async () => {
    mockProcess.mockResolvedValue({ type: "text", content: "What time?" });
    await state().handle("set an alarm");

    state().dismiss();

    expect(state()).toMatchObject({
      active: false,
      phase: "idle",
      transcript: "",
      clarifying: null,
      pending: null,
    });
  });
});
