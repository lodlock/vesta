// A deterministic clarification stays an assistant interaction.
//
// The report: with "It's 14:00 in Norway" still on screen, the user asked
// "What time is it in the United States?" — and instead of being asked which
// city, the assistant closed and Vesta opened the chat that happened to be
// open before.
//
// The cause was not the resolver, which correctly called the US ambiguous. It
// was that a deterministic layer returns prose for two different reasons — here
// is your answer, and I need one more thing — and `{ type: "text" }` says
// nothing about which. So the FINISHED Norway answer was filed as a pending
// clarification: it left `clarifying` set, which meant the next invocation was
// really asked as "What time is it in Norway? What time is it in the United
// States?", inherited the previous turn's session, matched no deterministic
// pattern, and went to the model. Exactly the conflation that caused the
// earlier round of bugs, in a new place.
//
// `resume` is now the discriminator, and these tests are written against it:
// present means a question, absent means the turn is over.

import { useAssistStore } from "../assist-store";
import { tryDeterministicAnswer } from "../../orchestrator/orchestrator";
import { speak } from "../../native/speech";
import { startAssistCapture, finishAssistantActivity } from "../../native/assist";
import { getConfig, createConversation } from "../../storage/database";

jest.mock("../../native/assist", () => ({
  startAssistCapture: jest.fn(async () => {}),
  finishAssistantActivity: jest.fn(),
}));
jest.mock("../../native/speech", () => ({
  speak: jest.fn(async () => "done"),
  stopSpeaking: jest.fn(),
}));
jest.mock("../../llm/llm-engine", () => ({
  isLoaded: jest.fn(() => true),
  getLastCompletion: jest.fn(() => null),
  stopGeneration: jest.fn(async () => {}),
  generate: jest.fn(),
}));
jest.mock("../../orchestrator/session-warmer", () => ({
  getLastWarmMs: () => 0,
  schedulePrefixPersist: jest.fn(),
  warmSessionCache: jest.fn(),
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
// The orchestrator runs FOR REAL here — the whole point is that the real
// deterministic layers and the real store agree about what a text response is.
jest.mock("../../orchestrator/memory-manager", () => ({
  getMemoriesForPrompt: jest.fn(async () => null),
  extractMemories: jest.fn(async () => {}),
  shouldExtractMemory: jest.fn(() => false),
  cancelExtraction: jest.fn(),
}));
jest.mock("../../orchestrator/knowledge-manager", () => ({
  getKnowledgeForPrompt: jest.fn(async () => null),
}));
jest.mock("../../orchestrator/document-retriever", () => ({ queryDocuments: jest.fn() }));

const mockSpeak = speak as jest.MockedFunction<typeof speak>;
const mockCapture = startAssistCapture as jest.MockedFunction<typeof startAssistCapture>;
const mockFinish = finishAssistantActivity as jest.MockedFunction<
  typeof finishAssistantActivity
>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockCreate = createConversation as jest.MockedFunction<typeof createConversation>;

const state = () => useAssistStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().endSession();
  mockSpeak.mockResolvedValue("done");
  mockConfig.mockResolvedValue(null);
});

afterEach(() => {
  useAssistStore.getState().endSession();
});

// The deterministic layers, run for real against a fixed instant.
const NOW = new Date("2026-07-15T12:00:00Z");
const deterministic = (text: string) =>
  tryDeterministicAnswer(text, "en", NOW, false);

describe("the layer itself distinguishes an answer from a question", () => {
  it("marks a resolved world-time answer as FINISHED", async () => {
    const res = await deterministic("what time is it in Norway");

    expect(res?.response.type).toBe("text");
    // No resume: there is nothing the user still owes, and nothing may be
    // carried into the next invocation.
    expect(res?.resume).toBeUndefined();
  });

  it("marks an ambiguous country as a QUESTION, with the text to resume", async () => {
    const res = await deterministic("what time is it in the United States");

    expect(res?.response.type).toBe("text");
    if (res?.response.type !== "text") throw new Error("expected text");
    expect(res.response.content).toContain("several time zones");
    // The question minus the ambiguous place, so a one-word follow-up finishes
    // it rather than the user repeating themselves.
    expect(res.resume).toBe("what time is it in");
  });

  it("resumes correctly for the other ambiguous countries", async () => {
    for (const country of ["Canada", "Australia", "Russia", "Brazil", "Mexico"]) {
      const res = await deterministic(`what time is it in ${country}`);
      expect(res?.resume).toBe("what time is it in");
    }
  });

  it("builds a resume for the date form too", async () => {
    const res = await deterministic("what day is it in Australia");
    expect(res?.resume).toBe("what day is it in");
  });

  it("completes the resumed question deterministically", async () => {
    const resumed = await deterministic("what time is it in Chicago");
    expect(resumed?.resume).toBeUndefined();
    if (resumed?.response.type !== "text") throw new Error("expected text");
    expect(resumed.response.content).toContain("Chicago");
  });
});

describe("the assistant keeps an ambiguous world-time query on its own surface", () => {
  it("asks, stays open, and never touches the model or a chat", async () => {
    await state().handle("what time is it in the United States", 1);

    expect(state().phase).toBe("clarify");
    expect(state().active).toBe(true);
    // The surface is not going anywhere...
    expect(state().leaving).toBe(false);
    expect(mockFinish).not.toHaveBeenCalled();
    // ...no model was loaded merely because a deterministic tool needs a
    // detail...
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    // ...and nothing was written.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state().message).toContain("Which city");
  });

  it("remembers the stem so a one-word follow-up completes it", async () => {
    await state().handle("what time is it in the United States", 1);
    expect(state().clarifying).toBe("what time is it in");

    // The Answer button re-opens the recognizer, which comes back as a new
    // invocation carrying only the city.
    await state().listenAgain();
    expect(mockCapture).toHaveBeenCalled();

    mockSpeak.mockClear();
    await state().handle("Chicago", 2);

    // Resolved locally, from "what time is it in Chicago". The answer speaks
    // and the turn takes itself away, so the spoken text is what to assert on.
    expect(mockSpeak.mock.calls.map((c) => c[0]).join(" ")).toContain("Chicago");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("persists only if the user asks for the chat", async () => {
    await state().handle("what time is it in the United States", 1);
    expect(mockCreate).not.toHaveBeenCalled();

    // Held at the final response — the window in which Open Chat is reachable,
    // before the completed answer dismisses itself.
    mockSpeak.mockImplementation(() => new Promise<never>(() => {}));
    const turn = state().handle("Chicago", 2);
    await new Promise((r) => setTimeout(r, 0));

    // A deterministic answer is its own receipt: nothing written on its own.
    expect(mockCreate).not.toHaveBeenCalled();

    const chatId = await state().openChat();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(chatId).toBeTruthy();
    void turn;
  });
});

describe("a finished world-time answer is not a pending question", () => {
  it("leaves nothing for the next invocation to inherit", async () => {
    await state().handle("what time is it in Norway", 1);

    // The turn is over: it spoke and took itself away, like a timer
    // confirmation. Critically, `clarifying` is empty.
    expect(state().clarifying).toBeNull();
    expect(state().phase).toBe("idle");
    expect(state().active).toBe(false);
  });

  it("does not glue the previous answer onto the next invocation", async () => {
    await state().handle("what time is it in Norway", 1);
    const norway = mockSpeak.mock.calls.map((c) => c[0]).join(" ");
    expect(norway).toContain("Norway");
    mockSpeak.mockClear();

    // Invocation N+1, with N's answer still fresh. It must be asked as
    // ITSELF — the bug turned this into "…Norway? …United States?".
    await state().handle("what time is it in the United States", 2);

    expect(state().phase).toBe("clarify");
    expect(state().transcript).toBe("what time is it in the United States");
    expect(state().message).not.toContain("Norway");
    expect(mockEnsureModelLoaded).not.toHaveBeenCalled();
  });

  it("N+1 owns the surface completely", async () => {
    await state().handle("what time is it in Norway", 1);
    const first = state().sessionId;

    await state().handle("what time is it in the United States", 2);

    expect(state().sessionId).toBeGreaterThan(first);
    // A fresh record, so Open Chat can only ever resolve to THIS interaction.
    expect(state().session.sessionId).toBe(state().sessionId);
    expect(state().session.persistedChatId).toBeNull();
    expect(state().active).toBe(true);
  });
});
