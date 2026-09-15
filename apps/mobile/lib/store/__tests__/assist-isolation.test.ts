// Assistant invocations are STANDALONE. Three questions, three conversations,
// three prompts, and nothing carried between them.
//
// Everything here comes from one real defect with four faces. The assistant
// asked "is this a timer?" by calling processMessage and reading its
// "No model loaded" error as "no, it isn't" — a test that holds only while no
// model is resident. Once one was (any warm process, which is the normal case)
// that same call ran a full chat turn, and its plain-text answer arrived at a
// switch that could not tell it apart from the parser's own clarification
// question. So the answer was filed as a clarification, which meant:
//
//   • it was shown through the plain-text branch, asterisks and all;
//   • the utterance was stored as `clarifying` and PREPENDED to the next
//     invocation, so "what time is it" was really asked as
//     "<the last question> what time is it" and got both answers;
//   • and because a follow-up legitimately continues its session, the next
//     invocation inherited the previous turn's record — including its
//     persistedChatId, which Open Chat then handed back as the wrong chat.
//
// The parser is asked directly now, and null is the only way to decline. These
// tests are written against that boundary: `mockScheduling` is the parser,
// `mockProcess` is the model, and the model must never see one invocation's
// words inside another's.

import { useAssistStore } from "../assist-store";
import {
  processMessage,
  processDeterministic,
} from "../../orchestrator/orchestrator";
import { speak } from "../../native/speech";
import { getConfig, createConversation, saveMessage } from "../../storage/database";
import type { Message } from "../../orchestrator/types";

jest.mock("../../orchestrator/orchestrator", () => ({
  processMessage: jest.fn(),
  processDeterministic: jest.fn(),
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
jest.mock("uuid", () => {
  let n = 0;
  return { v4: () => `id-${++n}` };
});
const mockEnsureModelLoaded = jest.fn(async () => {});
jest.mock("../chat-store", () => ({
  useChatStore: {
    getState: () => ({ language: "en", ensureModelLoaded: mockEnsureModelLoaded }),
  },
}));

const mockProcess = processMessage as jest.MockedFunction<typeof processMessage>;
const mockScheduling = processDeterministic as jest.MockedFunction<
  typeof processDeterministic
>;
const mockSpeak = speak as jest.MockedFunction<typeof speak>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockCreate = createConversation as jest.MockedFunction<typeof createConversation>;
const mockSave = saveMessage as jest.MockedFunction<typeof saveMessage>;

// The deterministic layers return { response, resume }. `resume` present means
// "a question the user still owes an answer to"; absent means "finished". That
// distinction is the whole reason the type exists — see DeterministicResult.
const resolves = (response: unknown) =>
  mockScheduling.mockResolvedValue({ response } as never);
const resolvesOnce = (response: unknown) =>
  mockScheduling.mockResolvedValueOnce({ response } as never);
/** A clarification question, and the text a follow-up completes. */
const asks = (content: string, resume: string) =>
  mockScheduling.mockResolvedValueOnce({
    response: { type: "text", content },
    resume,
  } as never);

const state = () => useAssistStore.getState();
const conversationsCreated = () => mockCreate.mock.calls.map((c) => c[0] as string);
const savedMessages = () => mockSave.mock.calls.map((c) => c[0] as Message);
/** The user text each model call actually received. */
const modelPrompts = () => mockProcess.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().endSession();
  mockSpeak.mockResolvedValue("done");
  mockConfig.mockResolvedValue(null);
  // The parser declines everything unless a test says otherwise.
  mockScheduling.mockResolvedValue(null);
});

afterEach(() => {
  useAssistStore.getState().endSession();
});

/** One complete model-backed invocation, left on screen. */
async function ask(question: string, answer: string, invocationId: number) {
  mockProcess.mockResolvedValueOnce({ type: "text", content: answer });
  await state().handle(question, invocationId);
}

describe("three sequential model invocations stay separate", () => {
  const turns: [string, string][] = [
    ["what is a hearth", "A fireplace at the centre of a home."],
    ["how do dwarves differ across D&D editions", "In OD&D they were a class."],
    ["what time is it", "It is quarter past four."],
  ];

  it("gives each its own conversation, and Open Chat opens that one", async () => {
    const opened: (string | null)[] = [];
    for (const [i, [question, answer]] of turns.entries()) {
      await ask(question, answer, i + 1);
      opened.push(await state().openChat());
    }

    // Three invocations, three conversations, no reuse.
    expect(conversationsCreated()).toHaveLength(3);
    expect(new Set(opened).size).toBe(3);
    expect(opened).toEqual(conversationsCreated());

    // And each conversation holds ITS OWN question and answer, in order.
    expect(savedMessages().map((m) => m.content)).toEqual([
      turns[0][0], turns[0][1],
      turns[1][0], turns[1][1],
      turns[2][0], turns[2][1],
    ]);
    // The messages of each pair share a conversation, and pairs do not.
    const ids = savedMessages().map((m) => m.conversationId);
    expect([ids[0], ids[2], ids[4]]).toEqual(conversationsCreated());
    expect(ids[1]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[2]);
    expect(ids[5]).toBe(ids[4]);
  });

  it("starts each invocation with no chat id and no inherited record", async () => {
    await ask(turns[0][0], turns[0][1], 1);
    const first = state().session.persistedChatId;
    expect(first).toBeTruthy();

    // A fresh invocation, without any dismissal in between — the case that
    // used to inherit the previous record wholesale.
    mockProcess.mockResolvedValueOnce({ type: "text", content: turns[1][1] });
    const before = state().handle(turns[1][0], 2);
    expect(state().session.persistedChatId).toBeNull();
    expect(state().session.sessionId).toBe(state().sessionId);
    await before;

    expect(state().session.persistedChatId).not.toBe(first);
    expect(await state().openChat()).not.toBe(first);
  });

  it("never lets an earlier invocation's in-flight write answer a later Open Chat", async () => {
    // Invocation 1's write is held open past the point where invocation 2 has
    // taken over. Deduplicating by "is a write running?" alone handed that
    // promise — and so invocation 1's conversation — to invocation 2.
    let releaseFirstWrite!: () => void;
    mockCreate.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirstWrite = resolve; }),
    );

    mockProcess.mockResolvedValueOnce({ type: "text", content: turns[0][1] });
    const first = state().handle(turns[0][0], 1);
    await new Promise((r) => setTimeout(r, 0));

    // Invocation 2 arrives and finishes while invocation 1's write is stuck.
    await ask(turns[1][0], turns[1][1], 2);
    const opened = await state().openChat();

    releaseFirstWrite();
    await first;

    const [firstChat, secondChat] = conversationsCreated();
    expect(opened).toBe(secondChat);
    expect(opened).not.toBe(firstChat);
  });
});

describe("a new invocation inherits no conversational context", () => {
  it("sends the model only what THIS invocation asked", async () => {
    await ask("how do dwarves differ across D&D editions", "In OD&D they were a class.", 1);
    await ask("what time is it", "It is quarter past four.", 2);
    await ask("who wrote Dune", "Frank Herbert.", 3);

    expect(modelPrompts()).toEqual([
      "how do dwarves differ across D&D editions",
      "what time is it",
      "who wrote Dune",
    ]);
    for (const prompt of modelPrompts().slice(1)) {
      expect(prompt).not.toMatch(/dwarves|D&D/i);
    }
  });

  it("passes an empty history, so no earlier turn can be replayed", async () => {
    await ask("how do dwarves differ across D&D editions", "In OD&D they were a class.", 1);
    await ask("what time is it", "It is quarter past four.", 2);

    for (const call of mockProcess.mock.calls) {
      expect(call[1]).toEqual([]);
      // Assist mode: reasoning off, and — see the orchestrator — no memory
      // extraction and no prefix re-persist, so a spoken answer cannot end up
      // in the NEXT invocation's system prompt either.
      expect(call[6]).toEqual({ assistMode: true });
    }
  });

  it("does not carry a model answer forward as a pending clarification", async () => {
    await ask("how do dwarves differ across D&D editions", "In OD&D they were a class.", 1);

    // The model answered. That is an ANSWER, not a question the user still owes
    // Vesta a reply to — `clarifying` is what used to prepend it to the next
    // invocation's prompt.
    expect(state().phase).toBe("answer");
    expect(state().clarifying).toBeNull();
  });

  it("still completes a REAL clarification from the parser", async () => {
    // The one case where carrying the utterance forward is right, and the only
    // thing that can produce it now.
    asks("Do you mean 4 AM or 4 PM?", "set an alarm tomorrow at four");
    await state().handle("set an alarm tomorrow at four", 1);
    expect(state().phase).toBe("clarify");
    expect(state().clarifying).toBe("set an alarm tomorrow at four");

    resolvesOnce({
      type: "tool_call",
      tool: "set_alarm",
      parameters: { time: "16:00" },
      message: "Alarm set for 16:00 tomorrow",
      result: { success: true, message: "ok" },
    });
    await state().handle("pm", 2);

    expect(mockScheduling).toHaveBeenLastCalledWith(
      "set an alarm tomorrow at four pm",
      "en",
    );
    expect(mockProcess).not.toHaveBeenCalled();
  });
});

describe("the parser is asked directly", () => {
  it("never routes a scheduling check through the model path", async () => {
    resolves({
      type: "tool_call",
      tool: "set_timer",
      parameters: { minutes: 5 },
      message: "Timer set for 5 minutes",
      result: { success: true, message: "ok" },
    });

    await state().handle("five minute timer", 1);

    expect(mockScheduling).toHaveBeenCalledWith("five minute timer", "en");
    // Not once, not with a different shape — the model is simply not involved.
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("asks the model exactly when the parser declines", async () => {
    mockScheduling.mockResolvedValue(null);
    mockProcess.mockResolvedValueOnce({ type: "text", content: "Providence." });

    await state().handle("capital of rhode island", 1);

    expect(mockEnsureModelLoaded).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ phase: "answer", message: "Providence." });
  });
});

describe("a withdrawn spoken request ends the turn", () => {
  // Dictation has no backspace. Checked on the raw transcript before the
  // parser, before the model, and before a clarification follow-up can glue
  // the retraction onto the request it retracts.
  it.each([
    "How do you handle different tenses in Latin? Actually, cancel.",
    "Set a 30 second timer, actually cancel.",
    "Set an alarm for seven — never mind.",
    "Remind me to call John tomorrow at four... forget it.",
  ])("neither parses nor generates for: %s", async (utterance) => {
    await state().handle(utterance, 1);

    expect(mockScheduling).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    // Acknowledged out loud, then out of the way like any finished turn.
    expect(mockSpeak.mock.calls.map((c) => c[0])).toEqual(["Okay, cancelled."]);
    expect(state().active).toBe(false);
  });

  it("leaves nothing behind to be written or reopened", async () => {
    await state().handle("Set a timer for five minutes, actually cancel", 1);

    // Nothing was done, so there is nothing to keep.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state().session.kind).toBeNull();
    expect(state().clarifying).toBeNull();
  });

  it("does not retract a request that merely mentions cancelling", async () => {
    resolvesOnce({
      type: "tool_call",
      tool: "set_reminder",
      parameters: { text: "cancel Netflix", datetime: "2026-09-16T16:00:00" },
      message: "Reminder set",
      result: { success: true, message: "ok" },
    });

    await state().handle("Remind me to cancel Netflix tomorrow at 4 PM", 1);

    // It reached the parser and ran, rather than being read as a retraction.
    expect(mockScheduling).toHaveBeenCalledWith(
      "Remind me to cancel Netflix tomorrow at 4 PM",
      "en",
    );
    expect(mockSpeak.mock.calls.map((c) => c[0])).toEqual(["Reminder set"]);
  });
});
