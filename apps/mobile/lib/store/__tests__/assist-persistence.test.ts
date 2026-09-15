// What the assistant writes down, and when.
//
// The rule being locked here is a product decision, not an implementation
// detail: a timer is its own receipt, so asking for one must not litter the
// chat list; an answer the user waited for a model to produce must survive the
// overlay closing itself, which it only does if it is written BEFORE the
// speech-and-leave sequence starts. Everything else follows from those two.
//
// The database is mocked at the module boundary rather than the session helper,
// so these tests exercise the real persistence code and can see exactly which
// rows a turn produces.

import { useAssistStore } from "../assist-store";
import { processMessage, executeToolCall } from "../../orchestrator/orchestrator";
import { finishAssistantActivity } from "../../native/assist";
import { speak } from "../../native/speech";
import {
  getConfig,
  createConversation,
  saveMessage,
  updateConversationTitle,
} from "../../storage/database";
import type { Message } from "../../orchestrator/types";

// Call order across module boundaries — needed to prove that the write happens
// before anything that could take the screen away.
const mockOrder: string[] = [];

jest.mock("../../orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  executeToolCall: jest.fn(),
}));
jest.mock("../../native/assist", () => ({
  startAssistCapture: jest.fn(async () => {}),
  finishAssistantActivity: jest.fn(),
}));
jest.mock("../../native/speech", () => ({
  speak: jest.fn(async () => "done"),
  stopSpeaking: jest.fn(),
}));
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => null),
  createConversation: jest.fn(async () => {}),
  saveMessage: jest.fn(async () => {}),
  updateConversationTitle: jest.fn(async () => {}),
  touchConversation: jest.fn(async () => {}),
}));
// uuid ships ESM that jest-expo does not transform; ids only need to be unique.
jest.mock("uuid", () => {
  let n = 0;
  return { v4: () => `id-${++n}` };
});

// The conversation that was open in the app before the assistant was invoked.
// Nothing this screen does may ever resolve to it.
const PREVIOUS_CHAT = "chat-open-before-the-assistant-was-invoked";
const mockEnsureModelLoaded = jest.fn(async () => {});
jest.mock("../chat-store", () => ({
  useChatStore: {
    getState: () => ({
      language: "en",
      currentConversationId: PREVIOUS_CHAT,
      ensureModelLoaded: mockEnsureModelLoaded,
    }),
  },
}));

const mockProcess = processMessage as jest.MockedFunction<typeof processMessage>;
const mockExecute = executeToolCall as jest.MockedFunction<typeof executeToolCall>;
const mockFinish = finishAssistantActivity as jest.MockedFunction<
  typeof finishAssistantActivity
>;
const mockSpeak = speak as jest.MockedFunction<typeof speak>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockCreate = createConversation as jest.MockedFunction<typeof createConversation>;
const mockSave = saveMessage as jest.MockedFunction<typeof saveMessage>;
const mockTitle = updateConversationTitle as jest.MockedFunction<
  typeof updateConversationTitle
>;

// A speech engine that never reports back. Holds a turn at exactly the moment
// the final response is on screen and the overlay has not yet taken itself
// away — the window in which the user can actually reach Done or Open Chat.
const silentEngine = () => {
  mockSpeak.mockImplementation(() => {
    mockOrder.push("speak");
    // Never settles, and never needs to produce a SpeechOutcome.
    return new Promise<never>(() => {});
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  useAssistStore.getState().dismiss();
  mockConfig.mockResolvedValue(null);
  mockCreate.mockImplementation(async (id: string) => {
    mockOrder.push(`create:${id}`);
  });
  mockSpeak.mockImplementation(async () => {
    mockOrder.push("speak");
    return "done";
  });
});

afterEach(() => {
  // Cancel any auto-finish still armed BEFORE the fake clock is thrown away,
  // otherwise its timer outlives the suite and holds the worker open.
  useAssistStore.getState().dismiss();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const state = () => useAssistStore.getState();

const savedMessages = () => mockSave.mock.calls.map((c) => c[0] as Message);
const conversationsCreated = () => mockCreate.mock.calls.map((c) => c[0] as string);

const timerResult = (message: string) =>
  ({
    type: "tool_call" as const,
    tool: "set_timer",
    parameters: { minutes: 0.5 },
    message,
    result: { success: true, message: "ok" },
  });

/** Runs a turn to its very end, including the auto-finish timeout. */
async function runToCompletion(turn: Promise<void>, ms = 20000) {
  await jest.advanceTimersByTimeAsync(ms);
  await turn;
}

/**
 * Starts a turn and stops it at its final response, before the overlay goes.
 *
 * The pending turn comes back wrapped: awaiting a bare promise here would
 * chain onto it and wait for the very thing this helper exists to stop short
 * of.
 */
async function pauseAtResponse(transcript: string): Promise<{ turn: Promise<void> }> {
  silentEngine();
  jest.useFakeTimers();
  const turn = state().handle(transcript);
  await jest.advanceTimersByTimeAsync(0);
  return { turn };
}

describe("a deterministic action is its own receipt", () => {
  it("timer + Done leaves no chat behind", async () => {
    mockProcess.mockResolvedValue(timerResult("Timer set for 30 seconds"));
    const { turn } = await pauseAtResponse("set a 30 second timer");

    expect(state()).toMatchObject({ phase: "done", failed: false });
    state().close();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    await runToCompletion(turn);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("timer + timeout leaves no chat behind", async () => {
    mockProcess.mockResolvedValue(timerResult("Timer set for 30 seconds"));
    jest.useFakeTimers();
    const turn = state().handle("set a 30 second timer");
    await runToCompletion(turn);

    // It left on its own, and left nothing behind.
    expect(mockFinish).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("timer + Open Chat creates one chat holding request and confirmation", async () => {
    mockProcess.mockResolvedValue(timerResult("Timer set for 30 seconds"));
    const { turn } = await pauseAtResponse("set a 30 second timer");

    const chatId = await state().openChat();

    expect(conversationsCreated()).toEqual([chatId]);
    expect(mockTitle).toHaveBeenCalledWith(chatId, "set a 30 second timer");
    expect(savedMessages().map((m) => [m.role, m.content])).toEqual([
      ["user", "set a 30 second timer"],
      ["assistant", "Timer set for 30 seconds"],
    ]);
    await runToCompletion(turn);
  });

  it("never reaches a model backend, not even to write the turn down", async () => {
    mockProcess.mockResolvedValue(timerResult("Timer set for 30 seconds"));
    const { turn } = await pauseAtResponse("set a 30 second timer");
    await state().openChat();

    // Persisting a turn must never become an excuse to load multi-GB weights.
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    expect(mockProcess).toHaveBeenCalledTimes(1);
    await runToCompletion(turn);
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });
});

describe("a model answer is kept without being asked", () => {
  const askModel = (answer: string) => {
    mockProcess
      .mockResolvedValueOnce({ type: "error", error: "No model loaded" })
      .mockResolvedValueOnce({ type: "text", content: answer });
  };

  it("model Q&A + Done keeps the saved chat", async () => {
    askModel("Providence.");
    const { turn } = await pauseAtResponse("what is the capital of rhode island");

    expect(conversationsCreated()).toHaveLength(1);
    state().close();

    // Leaving does not unwrite it.
    expect(conversationsCreated()).toHaveLength(1);
    expect(savedMessages()).toHaveLength(2);
    await runToCompletion(turn);
    expect(conversationsCreated()).toHaveLength(1);
  });

  it("model Q&A + timeout keeps the saved chat", async () => {
    askModel("Providence.");
    jest.useFakeTimers();
    const turn = state().handle("what is the capital of rhode island");
    await runToCompletion(turn);

    expect(state().active).toBe(false);
    expect(conversationsCreated()).toHaveLength(1);
    expect(savedMessages()).toHaveLength(2);
  });

  it("model Q&A + Open Chat opens the SAME saved chat", async () => {
    askModel("Providence.");
    const { turn } = await pauseAtResponse("what is the capital of rhode island");
    const written = conversationsCreated()[0];

    const opened = await state().openChat();

    expect(opened).toBe(written);
    await runToCompletion(turn);
  });

  it("Open Chat after automatic persistence does not create a duplicate", async () => {
    askModel("Providence.");
    const { turn } = await pauseAtResponse("what is the capital of rhode island");

    await state().openChat();
    await state().openChat(); // and a second tap changes nothing either

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(2);
    await runToCompletion(turn);
  });

  it("Open Chat never resolves to the previously active, unrelated chat", async () => {
    askModel("Providence.");
    const { turn: modelTurn } = await pauseAtResponse("what is the capital of rhode island");
    const fromModel = await state().openChat();
    expect(fromModel).not.toBe(PREVIOUS_CHAT);
    await runToCompletion(modelTurn);

    jest.clearAllMocks();
    mockCreate.mockImplementation(async () => {});
    mockProcess.mockResolvedValue(timerResult("Timer set for 30 seconds"));
    const { turn: timerTurn } = await pauseAtResponse("set a 30 second timer");
    const fromTimer = await state().openChat();

    // The deterministic path had nothing written yet, and still must not fall
    // back to whatever chat happened to be open in the app.
    expect(fromTimer).not.toBe(PREVIOUS_CHAT);
    expect(fromTimer).toBe(conversationsCreated()[0]);
    await runToCompletion(timerTurn);
  });

  it("persists before the auto-finish sequence can destroy the surface", async () => {
    askModel("Providence.");
    jest.useFakeTimers();
    const turn = state().handle("what is the capital of rhode island");
    await runToCompletion(turn);

    // Speech is what precedes the linger-then-leave, so the write landing
    // before the first utterance is the guarantee that matters.
    expect(mockOrder.filter((e) => e.startsWith("create:") || e === "speak")).toEqual([
      `create:${conversationsCreated()[0]}`,
      "speak",
    ]);
  });

  it("keeps only the final visible answer — no reasoning, no tool payloads", async () => {
    askModel(
      "<think>The user wants a capital. Rhode Island's is Providence.</think>Providence is the capital.",
    );
    const { turn } = await pauseAtResponse("what is the capital of rhode island");

    const [, assistant] = savedMessages();
    expect(assistant.content).toBe("Providence is the capital.");
    expect(assistant.content).not.toMatch(/think|user wants/i);
    for (const message of savedMessages()) {
      expect(message.toolCall).toBeUndefined();
      expect(message.toolResult).toBeUndefined();
    }
    await runToCompletion(turn);
  });
});

describe("a clarification is whichever path it ends on", () => {
  it("resolved locally, it does not persist unless Open Chat is chosen", async () => {
    mockProcess.mockResolvedValueOnce({
      type: "text",
      content: "Do you mean 4 AM or 4 PM?",
    });
    jest.useFakeTimers();
    await state().handle("set an alarm tomorrow at four");
    expect(state().phase).toBe("clarify");
    expect(mockCreate).not.toHaveBeenCalled();

    mockProcess.mockResolvedValueOnce(timerResult("Alarm set for 16:00 tomorrow"));
    silentEngine();
    const turn = state().handle("pm");
    await jest.advanceTimersByTimeAsync(0);

    // Answered by the parser, so nothing is written on its own...
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();

    // ...and Open Chat writes the COMPLETED request, not the fragment.
    const chatId = await state().openChat();
    expect(conversationsCreated()).toEqual([chatId]);
    expect(savedMessages().map((m) => m.content)).toEqual([
      "set an alarm tomorrow at four pm",
      "Alarm set for 16:00 tomorrow",
    ]);
    await runToCompletion(turn);
  });

  it("ending up on the model, it follows the model policy", async () => {
    mockProcess.mockResolvedValueOnce({ type: "text", content: "What time?" });
    jest.useFakeTimers();
    await state().handle("set an alarm");
    expect(mockCreate).not.toHaveBeenCalled();

    mockProcess
      .mockResolvedValueOnce({ type: "error", error: "No model loaded" })
      .mockResolvedValueOnce({ type: "text", content: "I can't tell when you mean." });
    const turn = state().handle("whenever, you decide");
    await runToCompletion(turn);

    // It became a model answer, so it is kept with no tap required.
    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
    expect(conversationsCreated()).toHaveLength(1);
    expect(savedMessages().map((m) => m.content)).toEqual([
      "set an alarm whenever, you decide",
      "I can't tell when you mean.",
    ]);
  });
});

describe("a gated action follows the deterministic policy", () => {
  it("confirming an alarm writes nothing until Open Chat is chosen", async () => {
    mockProcess.mockResolvedValue({
      type: "pending_tool_call",
      tool: "set_alarm",
      parameters: { time: "07:00" },
      message: "Set an alarm for 07:00?",
    });
    jest.useFakeTimers();
    await state().handle("wake me at seven");
    expect(state().phase).toBe("confirm");

    mockExecute.mockResolvedValue({ success: true, message: "Alarm set for 07:00" });
    silentEngine();
    const turn = state().confirm(true);
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreate).not.toHaveBeenCalled();

    const chatId = await state().openChat();
    expect(conversationsCreated()).toEqual([chatId]);
    expect(savedMessages().map((m) => m.content)).toEqual([
      "wake me at seven",
      "Alarm set for 07:00",
    ]);
    await runToCompletion(turn);
  });
});
