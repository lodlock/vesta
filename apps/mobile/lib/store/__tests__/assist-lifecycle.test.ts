// The assistant SESSION: what a single invocation owns, and when it stops
// owning it.
//
// These lock down four things that went wrong on device, all of them the same
// bug wearing different clothes — the store outlives the screen, so work in
// flight for a turn the user has left behind kept landing in the next one:
//
//   • an abandoned turn reappeared as an overlay on an ordinary app launch,
//     because the process survived the task being swiped away;
//   • a new invocation showed its own answer while the ENGINE spoke the
//     previous one, because the TTS call sat behind an await that outlived the
//     stopSpeaking() meant to cancel it;
//   • a late continuation of the old turn could still dismiss, write to, or
//     schedule the disappearance of the new one;
//   • and none of that was allowed to cost the user a conversation that had
//     already been written to disk.
//
// The invariant under test throughout: everything a turn does is scoped to its
// session id, ids never repeat, and ending a session is transient cleanup only.

import { useAssistStore, isLongAnswer, lingerFor } from "../assist-store";
import {
  processMessage,
  processDeterministic,
} from "../../orchestrator/orchestrator";
import { finishAssistantActivity } from "../../native/assist";
import { speak, stopSpeaking } from "../../native/speech";
import { getConfig, createConversation } from "../../storage/database";

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
const mockStop = stopSpeaking as jest.MockedFunction<typeof stopSpeaking>;
const mockFinish = finishAssistantActivity as jest.MockedFunction<
  typeof finishAssistantActivity
>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockCreateConversation = createConversation as jest.MockedFunction<
  typeof createConversation
>;

const state = () => useAssistStore.getState();
const spokenWords = () => mockSpeak.mock.calls.map((c) => c[0]);

const answer = (content: string) => ({ type: "text" as const, content });

/**
 * The parser declines; the model answers `content`. One full model turn.
 *
 * The two are separate mocks because they are now separate calls. The store
 * asks the deterministic parser directly and reads null as "declined" — it
 * used to ask processMessage and read its "No model loaded" error the same
 * way, which quietly became a full chat generation as soon as a model was
 * resident, and that one conflation caused four of the bugs this file covers.
 */
function modelAnswers(content: string) {
  mockScheduling.mockResolvedValue(null);
  mockProcess.mockImplementation(async () => answer(content));
}

/** A device action the parser resolves on its own, with no model involved. */
const timerSet = {
  type: "tool_call" as const,
  tool: "set_timer",
  parameters: { minutes: 5 },
  message: "Timer set for 5 minutes",
  result: { success: true, message: "ok" },
};

/** A deferred promise, for holding a turn open at a chosen await boundary. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask queue so an in-flight turn reaches its next await. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().endSession();
  mockScheduling.mockResolvedValue(null);
  mockSpeak.mockResolvedValue("done");
  mockConfig.mockResolvedValue(null);
});

afterEach(() => {
  // The answer path arms a 6s auto-finish; left running it would fire inside a
  // later test (which is the production bug in miniature).
  useAssistStore.getState().endSession();
});

describe("session identity", () => {
  it("gives every invocation a new id, and never reuses one", async () => {
    modelAnswers("first");

    await state().handle("what is a hearth", 1);
    const first = state().sessionId;

    state().endSession();
    expect(state().sessionId).toBe(0);

    await state().handle("and again", 2);
    const second = state().sessionId;

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it("keeps ids increasing even when the native invocation id repeats", async () => {
    modelAnswers("hello");

    await state().handle("one", 7);
    const first = state().sessionId;
    state().endSession();
    // A process that restarted its counter, or a bridge that returned nothing.
    await state().handle("two", 1);

    expect(state().sessionId).toBeGreaterThan(first);
  });
});

describe("an abandoned turn does not come back", () => {
  it("shows no overlay after a normal launch ends the stale session", async () => {
    modelAnswers("a long answer");

    await state().handle("tell me about vesta", 1);
    expect(state().active).toBe(true);

    // The user swiped Vesta out of Recents; Android kept the process, so the
    // store still holds the turn. Launching from the icon reports no pending
    // invocation, which is the launch-origin gate in _layout.
    state().endSession();

    expect(state().active).toBe(false);
    expect(state().sessionId).toBe(0);
    expect(state().phase).toBe("idle");
    expect(state().message).toBe("");
  });

  it("ends a settled turn when the app leaves the foreground", async () => {
    modelAnswers("an answer");

    await state().handle("tell me about vesta", 1);
    expect(state().phase).toBe("answer");

    state().endIfSettled();

    expect(state().active).toBe(false);
  });

  it("leaves a turn alone while it is still waiting on something", async () => {
    // The system recognizer is a separate Activity: going to the background is
    // exactly what a clarification follow-up does, and must not end the turn.
    const held = deferred<ReturnType<typeof answer>>();
    mockScheduling.mockImplementation(() => held.promise as never);

    const turn = state().handle("tell me about vesta", 1);
    expect(state().phase).toBe("working");

    state().endIfSettled();
    expect(state().active).toBe(true);

    held.resolve(answer("done thinking"));
    await turn;
  });

  it("clears the transient state on dismiss and on Back", async () => {
    modelAnswers("an answer");

    await state().handle("first", 1);
    state().dismiss();
    expect(state()).toMatchObject({ active: false, sessionId: 0, phase: "idle" });

    await state().handle("second", 2);
    mockFinish.mockClear();
    state().back();

    expect(state()).toMatchObject({ active: false, sessionId: 0, phase: "idle" });
    // Back hands the screen back to whatever the user came from.
    expect(mockFinish).toHaveBeenCalled();
    // ...and silences the answer on the way out.
    expect(mockStop).toHaveBeenCalled();
  });
});

describe("speech belongs to one invocation", () => {
  it("cancels the previous invocation's speech when a new one arrives", async () => {
    modelAnswers("first answer");
    await state().handle("first question", 1);
    mockStop.mockClear();

    modelAnswers("second answer");
    await state().handle("second question", 2);

    expect(mockStop).toHaveBeenCalled();
    expect(spokenWords()).toEqual(["first answer", "second answer"]);
  });

  it("never speaks an answer whose invocation was superseded mid-flight", async () => {
    // The hole this closes: `say` reads the assist_speak setting from SQLite
    // before it calls the engine. A new invocation's stopSpeaking() lands in
    // that gap, and the old turn used to go on and speak anyway — which is
    // exactly "the UI showed the new answer, the phone read out the old one".
    modelAnswers("the long stale answer");
    // The assist_speak read that `say` makes, held open. Everything before it
    // (assist_auto_model, the model call) resolves normally.
    const setting = deferred<string | null>();
    mockConfig.mockImplementation(async (key: string) =>
      key === "assist_speak" ? setting.promise : null,
    );

    const stale = state().handle("the old question", 1);
    await flush();

    // A second invocation arrives while the first is stuck reading the setting.
    mockConfig.mockImplementation(async () => null);
    modelAnswers("the new short answer");
    await state().handle("the new question", 2);

    setting.resolve(null); // the setting finally comes back: speech is ON
    await stale;

    expect(spokenWords()).toEqual(["the new short answer"]);
    expect(spokenWords()).not.toContain("the long stale answer");
  });

  it("stops speech when the turn is dismissed", async () => {
    modelAnswers("an answer");
    await state().handle("a question", 1);
    mockStop.mockClear();

    state().endSession();

    expect(mockStop).toHaveBeenCalled();
  });

  it("stops speech when the user opens the chat", async () => {
    modelAnswers("an answer");
    await state().handle("a question", 1);
    mockStop.mockClear();

    await state().openChat();

    expect(mockStop).toHaveBeenCalled();
    expect(state().sessionId).toBe(0);
  });
});

describe("a late continuation cannot touch the next invocation", () => {
  it("drops an answer that arrives after its invocation was superseded", async () => {
    const slow = deferred<ReturnType<typeof answer>>();
    mockScheduling.mockResolvedValue(null);
    mockProcess.mockImplementation(() => slow.promise as never);

    const stale = state().handle("the slow question", 1);
    await flush();

    modelAnswers("the new answer");
    await state().handle("the quick question", 2);
    const liveSession = state().sessionId;

    // Invocation 1's model finally returns, long after invocation 2 took over.
    slow.resolve(answer("the stale answer"));
    await stale;

    expect(state().message).toBe("the new answer");
    expect(state().transcript).toBe("the quick question");
    expect(state().sessionId).toBe(liveSession);
    expect(spokenWords()).not.toContain("the stale answer");
  });

  it("does not let a superseded turn close the screen out from under the new one", async () => {
    // Invocation 1's confirmation is still being spoken when invocation 2
    // arrives; only that utterance is held open.
    const slowSpeech = deferred<"done">();
    mockSpeak.mockImplementation(async (text: string) =>
      text === timerSet.message ? slowSpeech.promise : "done",
    );
    mockScheduling.mockResolvedValue({ response: timerSet } as never);

    const stale = state().handle("five minute timer", 1);
    await flush();
    expect(mockSpeak).toHaveBeenCalledWith(timerSet.message, "en");

    // Invocation 2 takes the screen while invocation 1 is still speaking.
    modelAnswers("the new answer");
    await state().handle("a question", 2);
    mockFinish.mockClear();

    slowSpeech.resolve("done");
    await stale;

    // Invocation 1's finish-and-leave must not run: invocation 2 owns the
    // screen, and the user would have watched their answer vanish.
    expect(mockFinish).not.toHaveBeenCalled();
    expect(state().active).toBe(true);
    expect(state().message).toBe("the new answer");
  });
});

describe("cleanup is transient only", () => {
  it("keeps a model conversation that was already written", async () => {
    modelAnswers("something worth keeping");

    await state().handle("a real question", 1);
    // The model path writes immediately, before speech and the linger window.
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    const chatId = state().session.persistedChatId;
    expect(chatId).toBeTruthy();

    state().endSession();

    // The transient record is gone; the conversation is not — nothing deletes,
    // and nothing re-writes it either.
    expect(state().session.persistedChatId).toBeNull();
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
  });

  it("opens the conversation this turn produced, without making a second one", async () => {
    modelAnswers("something worth keeping");

    await state().handle("a real question", 1);
    const written = state().session.persistedChatId;

    const opened = await state().openChat();

    expect(opened).toBe(written);
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a deterministic turn that just ends", async () => {
    mockScheduling.mockResolvedValue({ response: timerSet } as never);

    await state().handle("five minute timer", 1);

    // Done/timeout already happened (the turn leaves on its own): no chat.
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(state().active).toBe(false);

    state().endSession();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

describe("a long answer is not taken away while it is being read", () => {
  // A page of text cannot be read in the seconds a spoken confirmation gets,
  // and dismissing on a speech-length timer took one away mid-paragraph.
  const SHORT = "It is quarter past four.";
  const LONG = "In original D&D, dwarves were a class rather than a race. ".repeat(12);

  it("classifies answers by whether they need scrolling", () => {
    expect(isLongAnswer(SHORT)).toBe(false);
    expect(isLongAnswer(LONG)).toBe(true);
    expect(lingerFor(LONG)).toBeGreaterThan(lingerFor(SHORT) * 10);
  });

  it("still dismisses a short answer on its own", async () => {
    modelAnswers(SHORT);
    jest.useFakeTimers();
    await state().handle("what time is it", 1);
    expect(state().phase).toBe("answer");

    await jest.advanceTimersByTimeAsync(lingerFor(SHORT) + 1_000);
    jest.useRealTimers();

    expect(state().active).toBe(false);
  });

  it("keeps a long answer up long past the short window", async () => {
    modelAnswers(LONG);
    jest.useFakeTimers();
    await state().handle("tell me about dwarves", 1);

    // Well past when a short answer would have taken itself away.
    await jest.advanceTimersByTimeAsync(lingerFor(SHORT) * 3);

    expect(state().active).toBe(true);
    expect(state().phase).toBe("answer");
    jest.useRealTimers();
  });

  it("restarts the window when the user scrolls", async () => {
    modelAnswers(LONG);
    jest.useFakeTimers();
    await state().handle("tell me about dwarves", 1);

    // Just short of the deadline, then read on.
    await jest.advanceTimersByTimeAsync(lingerFor(LONG) - 5_000);
    state().keepAlive();
    await jest.advanceTimersByTimeAsync(lingerFor(LONG) - 5_000);
    expect(state().active).toBe(true);

    // And it does eventually go, once reading has actually stopped.
    await jest.advanceTimersByTimeAsync(lingerFor(LONG));
    expect(state().active).toBe(false);
    jest.useRealTimers();
  });
});
