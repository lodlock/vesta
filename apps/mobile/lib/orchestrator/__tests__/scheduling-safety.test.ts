// The safety rules, end to end through the real routing layer.
//
// The unit tests in lib/scheduling/__tests__/safety.test.ts pin the two pure
// modules. These pin what the user actually experiences: the utterances below
// go through the real parser, the real deterministic layers and the real
// dispatch guard, with only the device actions and the model mocked. If any of
// these regress, something got scheduled that nobody asked for.

import { tryDeterministicAnswer, processMessage } from "../orchestrator";
import { dispatchToolCall } from "../tool-dispatcher";
import { generate, isLoaded } from "../../llm/llm-engine";

jest.mock("../../llm/llm-engine", () => ({
  generate: jest.fn(),
  isLoaded: jest.fn(() => false),
}));
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
jest.mock("../../storage/database", () => ({ getConfig: jest.fn(async () => "false") }));
// The device actions. Reaching these at all is the failure these tests catch.
jest.mock("../../native/system-actions", () => ({
  setAlarm: jest.fn(async () => ({ success: true, message: "alarm set" })),
  setTimer: jest.fn(async () => ({ success: true, message: "timer set" })),
  createEvent: jest.fn(async () => ({ success: true, message: "event created" })),
  navigateTo: jest.fn(),
}));
jest.mock("../../native/reminders", () => ({
  scheduleReminder: jest.fn(async () => ({ success: true, message: "reminder set" })),
}));
jest.mock("../../native/contacts", () => ({ searchContacts: jest.fn() }));
jest.mock("../../native/communication", () => ({ makeCall: jest.fn(), sendSms: jest.fn() }));
jest.mock("../../native/calendar", () => ({ getCalendarEvents: jest.fn() }));
jest.mock("../document-retriever", () => ({ queryDocuments: jest.fn() }));

import { setAlarm, setTimer, createEvent } from "../../native/system-actions";
import { scheduleReminder } from "../../native/reminders";

const mockGenerate = generate as jest.MockedFunction<typeof generate>;
const mockIsLoaded = isLoaded as jest.MockedFunction<typeof isLoaded>;
const mockAlarm = setAlarm as jest.MockedFunction<typeof setAlarm>;
const mockTimer = setTimer as jest.MockedFunction<typeof setTimer>;
const mockEvent = createEvent as jest.MockedFunction<typeof createEvent>;
const mockReminder = scheduleReminder as jest.MockedFunction<typeof scheduleReminder>;

// A fixed instant so every resolution below is reproducible.
const NOW = new Date(2026, 8, 15, 10, 0, 0); // Tuesday 15 September 2026, 10:00

/** True when anything at all was armed on the device. */
const somethingWasScheduled = () =>
  mockAlarm.mock.calls.length +
  mockTimer.mock.calls.length +
  mockEvent.mock.calls.length +
  mockReminder.mock.calls.length >
  0;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLoaded.mockReturnValue(false);
});

describe("a withdrawn request schedules nothing", () => {
  it.each([
    "How do you handle different tenses in Latin? Actually, cancel.",
    "Set a 30 second timer, actually cancel.",
    "Set an alarm for seven — never mind.",
    "Remind me to call John tomorrow at four... forget it.",
    "Schedule a meeting with Anna tomorrow at nine, scratch that",
  ])("does nothing for: %s", async (utterance) => {
    const res = await tryDeterministicAnswer(utterance, "en", NOW, false);

    // Answered, and answered as a retraction — not passed on to the model.
    expect(res).not.toBeNull();
    expect(res!.response.type).toBe("text");
    expect(somethingWasScheduled()).toBe(false);
  });

  it("never loads the model for a withdrawn request", async () => {
    mockIsLoaded.mockReturnValue(true);

    const res = await processMessage(
      "How do you handle different tenses in Latin? Actually, cancel.",
      [],
      "en",
      undefined,
      undefined,
      NOW,
    );

    expect(res).toEqual({ type: "text", content: "Okay, cancelled." });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(somethingWasScheduled()).toBe(false);
  });
});

describe("a request that names a time still works", () => {
  it("sets a reminder whose SUBJECT is cancelling something", async () => {
    const res = await tryDeterministicAnswer(
      "Remind me to cancel Netflix tomorrow at 4 PM",
      "en",
      NOW,
      false,
    );

    expect(res?.response.type).toBe("tool_call");
    expect(mockReminder).toHaveBeenCalledTimes(1);
    const [text] = mockReminder.mock.calls[0];
    expect(text.toLowerCase()).toContain("cancel");
    expect(text.toLowerCase()).toContain("netflix");
  });

  it("sets a reminder whose LABEL contains the word cancel", async () => {
    const res = await tryDeterministicAnswer(
      "Remind me to cancel subscription on Friday at 4 PM",
      "en",
      NOW,
      false,
    );

    expect(res?.response.type).toBe("tool_call");
    expect(mockReminder).toHaveBeenCalledTimes(1);
    expect(mockReminder.mock.calls[0][0].toLowerCase()).toContain("cancel");
  });

  it("asks AM or PM for a bare hour rather than picking one", async () => {
    // Not a regression from the cancellation work — it is the same rule as
    // "never invent a time", applied to a value that IS present but is
    // genuinely two-way ambiguous. Asking is the whole policy.
    const res = await tryDeterministicAnswer(
      "Remind me to cancel Netflix tomorrow at four",
      "en",
      NOW,
      false,
    );

    expect(res?.response.type).toBe("text");
    expect(somethingWasScheduled()).toBe(false);
  });

  it("completes that clarification into a reminder that still says cancel", async () => {
    // The follow-up path: the assistant re-asks the parser with the rebuilt
    // sentence. "cancel" here is the SUBJECT, and must survive as one.
    const res = await tryDeterministicAnswer(
      "Remind me to cancel Netflix tomorrow at four pm",
      "en",
      NOW,
      false,
    );

    expect(res?.response.type).toBe("tool_call");
    expect(mockReminder.mock.calls[0][0].toLowerCase()).toContain("cancel");
  });

  it("still runs an ordinary timer", async () => {
    const res = await tryDeterministicAnswer("set a 30 second timer", "en", NOW, false);

    expect(res?.response.type).toBe("tool_call");
    expect(mockTimer).toHaveBeenCalledWith(0.5, undefined);
  });
});

describe("a missing time is asked about, never invented", () => {
  it.each([
    ["Remind me to call John", "missing-time"],
    ["Set an alarm", "missing-time"],
    ["Set a timer", "missing-duration"],
  ])("asks instead of scheduling: %s", async (utterance) => {
    const res = await tryDeterministicAnswer(utterance, "en", NOW, false);

    // A question, not an action, and nothing armed.
    expect(res?.response.type).toBe("text");
    expect(somethingWasScheduled()).toBe(false);
  });
});

describe("the dispatch guard is the last line", () => {
  // Even if routing, the prompt and confirmation all fail at once, nothing
  // gets armed at a time the user never gave.
  it("refuses the exact model call that ran on device", async () => {
    const result = await dispatchToolCall(
      "set_reminder",
      {
        text: "cancel the request about Latin tenses",
        datetime: "2026-09-15T11:30:00",
      },
      "en",
      {
        source: "model",
        utterance: "How do you handle different tenses in Latin? Actually, cancel.",
        lang: "en",
      },
    );

    expect(result.success).toBe(false);
    expect(mockReminder).not.toHaveBeenCalled();
    // And says so in words the user can act on.
    expect(result.message).toContain("didn't say when");
  });

  it("refuses a dispatch with no provenance at all", async () => {
    const result = await dispatchToolCall("set_alarm", { time: "07:00" }, "en");

    expect(result.success).toBe(false);
    expect(mockAlarm).not.toHaveBeenCalled();
  });

  it.each([
    ["set_timer", { minutes: 5 }],
    ["set_alarm", { time: "11:30" }],
    ["set_reminder", { text: "x", datetime: "2026-09-15T11:30:00" }],
    ["create_event", { title: "x", start: "2026-09-15T11:30:00" }],
  ])("refuses %s when the utterance has no temporal value", async (tool, params) => {
    const result = await dispatchToolCall(tool, params, "en", {
      source: "model",
      utterance: "tell me about the dwarves",
      lang: "en",
    });

    expect(result.success).toBe(false);
    expect(somethingWasScheduled()).toBe(false);
  });

  it("lets a grounded model call through", async () => {
    const result = await dispatchToolCall(
      "set_reminder",
      { text: "call John", datetime: "2026-09-16T16:00:00" },
      "en",
      {
        source: "model",
        utterance: "remind me to call John tomorrow at four",
        lang: "en",
      },
    );

    expect(result.success).toBe(true);
    expect(mockReminder).toHaveBeenCalledTimes(1);
  });
});
