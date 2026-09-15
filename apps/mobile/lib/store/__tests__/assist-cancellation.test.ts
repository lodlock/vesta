// Back and Done must land NOW, at any phase.
//
// The report: an accidental invocation ("Okay") fell through to the model, and
// while it was generating Back appeared to do nothing — pressed repeatedly,
// then Done, then eventually it closed. Two things were wrong, and only one of
// them was about state:
//
//   the surface    `leave()` did clear the session synchronously, so the
//                  overlay's own state was fine. But clearing `active` swapped
//                  it for the whole chat navigator, mounting a screen nobody
//                  asked for in the moments before the Activity finished.
//   the work       nothing stopped the generation. The session guard keeps an
//                  abandoned answer off the screen, but llama.cpp went on
//                  decoding to its token limit on every core — and the UI
//                  thread it starved belonged to the user pressing Back.
//
// So the rule these tests pin is "invalidate first, clean up second": the state
// write that cancels the turn happens before anything that talks to a native
// subsystem, nothing in the path awaits, and the work is signalled to stop.

import { useAssistStore } from "../assist-store";
import {
  processMessage,
  processDeterministic,
} from "../../orchestrator/orchestrator";
import { finishAssistantActivity } from "../../native/assist";
import { speak, stopSpeaking } from "../../native/speech";
import { stopGeneration } from "../../llm/llm-engine";
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
jest.mock("../../llm/llm-engine", () => ({
  isLoaded: jest.fn(() => true),
  getLastCompletion: jest.fn(() => null),
  stopGeneration: jest.fn(async () => {}),
}));
jest.mock("../../orchestrator/session-warmer", () => ({ getLastWarmMs: () => 0 }));
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
const mockDeterministic = processDeterministic as jest.MockedFunction<
  typeof processDeterministic
>;
const mockFinish = finishAssistantActivity as jest.MockedFunction<
  typeof finishAssistantActivity
>;
const mockSpeak = speak as jest.MockedFunction<typeof speak>;
const mockStopSpeaking = stopSpeaking as jest.MockedFunction<typeof stopSpeaking>;
const mockStopGeneration = stopGeneration as jest.MockedFunction<typeof stopGeneration>;
const mockConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockCreate = createConversation as jest.MockedFunction<typeof createConversation>;

const state = () => useAssistStore.getState();
const spokenWords = () => mockSpeak.mock.calls.map((c) => c[0]);

/** A promise the test resolves by hand, standing in for a long generation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Starts a model-backed turn and stops it mid-generation.
 *
 * Returns the still-pending turn and the handle that finishes the generation,
 * so a test can cancel in between — the exact window the user was in.
 */
async function startGenerating(transcript = "Okay", invocationId = 1) {
  const generation = deferred<{ type: "text"; content: string }>();
  mockDeterministic.mockResolvedValue(null); // nothing deterministic; go to the model
  mockProcess.mockImplementation(() => generation.promise as never);
  const turn = state().handle(transcript, invocationId);
  await flush();
  return { turn, generation };
}

beforeEach(() => {
  jest.clearAllMocks();
  useAssistStore.getState().endSession();
  mockSpeak.mockResolvedValue("done");
  mockConfig.mockResolvedValue(null);
  mockDeterministic.mockResolvedValue(null);
});

afterEach(() => {
  useAssistStore.getState().endSession();
});

describe("Back and Done land immediately, mid-generation", () => {
  it.each([
    ["Back", () => state().back()],
    ["Done", () => state().close()],
  ])("%s invalidates the session synchronously", async (_name, press) => {
    const { turn, generation } = await startGenerating();
    expect(state().phase).toBe("thinking");

    // Synchronously — no await between the press and the assertions. Anything
    // that needed an await here is a frame the user spends looking at a
    // surface that has stopped being theirs.
    press();

    expect(state().sessionId).toBe(0);
    expect(state().active).toBe(false);
    expect(state().phase).toBe("idle");
    // The Activity is told to go in the same tick...
    expect(mockFinish).toHaveBeenCalled();
    // ...and the root renders nothing but the background until it does,
    // rather than mounting the whole chat navigator on a busy device.
    expect(state().leaving).toBe(true);

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
  });

  it.each([
    ["Back", () => state().back()],
    ["Done", () => state().close()],
  ])("%s tells the model to stop decoding", async (_name, press) => {
    const { turn, generation } = await startGenerating();

    press();

    // Signalled, not awaited. The guard keeps the answer off the screen; this
    // is what stops the work competing with the UI thread for the CPU.
    expect(mockStopGeneration).toHaveBeenCalledTimes(1);
    expect(mockStopSpeaking).toHaveBeenCalled();

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
  });

  it("stops speech and cancels the auto-finish when pressed on an answer", async () => {
    mockDeterministic.mockResolvedValue(null);
    mockProcess.mockResolvedValue({ type: "text", content: "Providence." });
    await state().handle("capital of rhode island", 1);
    expect(state().phase).toBe("answer");
    mockStopSpeaking.mockClear();

    state().back();

    expect(state().sessionId).toBe(0);
    expect(state().autoFinishPending).toBe(false);
    expect(mockStopSpeaking).toHaveBeenCalled();
  });

  it("does not stop a generation that was never running", async () => {
    mockDeterministic.mockResolvedValue(null);
    mockProcess.mockResolvedValue({ type: "text", content: "Providence." });
    await state().handle("capital of rhode island", 1);

    state().back();

    // Phase was "answer", not "thinking" — there is nothing to cancel, and
    // signalling anyway would cut off an unrelated chat generation.
    expect(mockStopGeneration).not.toHaveBeenCalled();
  });
});

describe("a cancelled turn's late result is inert", () => {
  it("cannot display", async () => {
    const { turn, generation } = await startGenerating();
    state().back();

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;

    expect(state().message).toBe("");
    expect(state().active).toBe(false);
    expect(state().phase).toBe("idle");
  });

  it("cannot persist", async () => {
    const { turn, generation } = await startGenerating();
    state().back();

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;

    // A generation that had not completed must leave nothing behind.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state().session.persistedChatId).toBeNull();
  });

  it("cannot speak", async () => {
    const { turn, generation } = await startGenerating();
    state().back();

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;

    expect(spokenWords()).not.toContain("an abandoned answer");
  });

  it("cannot dismiss or alter a NEWER invocation", async () => {
    const { turn, generation } = await startGenerating("Okay", 1);
    state().back();

    // The user invokes again and gets a real answer.
    mockProcess.mockResolvedValue({ type: "text", content: "the new answer" });
    await state().handle("what is the capital of rhode island", 2);
    const liveSession = state().sessionId;
    mockFinish.mockClear();

    // Only now does invocation 1's abandoned generation come back.
    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;

    expect(state().sessionId).toBe(liveSession);
    expect(state().message).toBe("the new answer");
    expect(state().active).toBe(true);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("keeps a model answer that HAD already completed and been written", async () => {
    mockDeterministic.mockResolvedValue(null);
    mockProcess.mockResolvedValue({ type: "text", content: "Providence." });
    await state().handle("capital of rhode island", 1);
    // The model path writes as soon as the answer is final.
    expect(mockCreate).toHaveBeenCalledTimes(1);

    state().back();

    // Leaving clears the transient record; the conversation stays on disk.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("a superseding invocation also stops the old work", () => {
  it("cancels the previous generation rather than queueing behind it", async () => {
    const { turn, generation } = await startGenerating("Okay", 1);

    mockProcess.mockResolvedValue({ type: "text", content: "the new answer" });
    const second = state().handle("what is the capital of rhode island", 2);

    expect(mockStopGeneration).toHaveBeenCalledTimes(1);

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
    await second;
    expect(state().message).toBe("the new answer");
  });

  it("clears the leaving flag so the new surface can render", async () => {
    const { turn, generation } = await startGenerating("Okay", 1);
    state().back();
    expect(state().leaving).toBe(true);

    mockProcess.mockResolvedValue({ type: "text", content: "the new answer" });
    await state().handle("what is the capital of rhode island", 2);

    expect(state().leaving).toBe(false);
    expect(state().active).toBe(true);

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
  });
});

describe("Open Chat also releases the model", () => {
  it("stops an in-flight generation on the way out", async () => {
    const { turn, generation } = await startGenerating();

    await state().openChat();

    expect(mockStopGeneration).toHaveBeenCalledTimes(1);
    // Open Chat stays inside Vesta, so the app must render — not a blank screen.
    expect(state().leaving).toBe(false);
    expect(state().active).toBe(false);

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("the blank-screen flag cannot outlive the leave", () => {
  it("is cleared by an ordinary launch, so a relaunch shows the app", async () => {
    const { turn, generation } = await startGenerating();
    state().back();
    expect(state().leaving).toBe(true);

    // The process survived; the user launches from the icon. This is the
    // launch-origin gate in _layout, and it must not leave the root rendering
    // a bare background forever.
    state().endSession();

    expect(state().leaving).toBe(false);
    expect(state().active).toBe(false);

    generation.resolve({ type: "text", content: "an abandoned answer" });
    await turn;
  });

  it("is cleared when the app comes back to the foreground", async () => {
    mockDeterministic.mockResolvedValue(null);
    mockProcess.mockResolvedValue({ type: "text", content: "Providence." });
    await state().handle("capital of rhode island", 1);
    state().close();
    expect(state().leaving).toBe(true);

    state().endIfSettled();

    expect(state().leaving).toBe(false);
  });
});
