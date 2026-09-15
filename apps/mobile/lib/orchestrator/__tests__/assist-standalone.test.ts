// What an assist-mode turn is allowed to leave behind: nothing.
//
// A spoken assistant answer is a one-shot. It used to behave like a chat turn
// in two ways that both leaked into the NEXT invocation:
//
//   memories        a model answer was mined for facts, and memories are
//                   injected into the STABLE PREFIX of every later turn. Ask
//                   about D&D editions, then ask the time, and the second
//                   invocation's system prompt carried the first answer — which
//                   is exactly what the model then went on to recite.
//   prefix persist  that same changing prefix is the session cache's key, so
//                   every assistant turn invalidated the restored KV state and
//                   made the next one pay a full cold prefill (~30s) on top.
//
// Chat is unchanged: a conversation is where remembering belongs.

import { processMessage, processDeterministic } from "../orchestrator";
import { generate, isLoaded } from "../../llm/llm-engine";
import { extractMemories, shouldExtractMemory } from "../memory-manager";
import { schedulePrefixPersist } from "../session-warmer";
import { parseSchedulingCommand } from "../../scheduling/parse";

jest.mock("../../llm/llm-engine", () => ({
  generate: jest.fn(),
  isLoaded: jest.fn(() => true),
}));
jest.mock("../memory-manager", () => ({
  getMemoriesForPrompt: jest.fn(async () => null),
  extractMemories: jest.fn(async () => {}),
  shouldExtractMemory: jest.fn(() => true),
  cancelExtraction: jest.fn(),
}));
jest.mock("../knowledge-manager", () => ({
  getKnowledgeForPrompt: jest.fn(async () => null),
}));
jest.mock("../session-warmer", () => ({ schedulePrefixPersist: jest.fn() }));
jest.mock("../../storage/database", () => ({ getConfig: jest.fn(async () => null) }));
jest.mock("../tool-dispatcher", () => ({ dispatchToolCall: jest.fn() }));
jest.mock("../../scheduling/parse", () => ({ parseSchedulingCommand: jest.fn() }));

const mockGenerate = generate as jest.MockedFunction<typeof generate>;
const mockIsLoaded = isLoaded as jest.MockedFunction<typeof isLoaded>;
const mockExtract = extractMemories as jest.MockedFunction<typeof extractMemories>;
const mockShouldExtract = shouldExtractMemory as jest.MockedFunction<
  typeof shouldExtractMemory
>;
const mockPersistPrefix = schedulePrefixPersist as jest.MockedFunction<
  typeof schedulePrefixPersist
>;
const mockParse = parseSchedulingCommand as jest.MockedFunction<
  typeof parseSchedulingCommand
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLoaded.mockReturnValue(true);
  mockShouldExtract.mockReturnValue(true);
  // Not a scheduling command, so everything below reaches the model.
  mockParse.mockReturnValue({ status: "unrecognized" } as never);
  mockGenerate.mockResolvedValue({
    text: "In original D&D, dwarves were a class.",
    content: "In original D&D, dwarves were a class.",
    reasoningContent: "",
    tokensPredicted: 12,
    tokensEvaluated: 40,
    timings: { promptMs: 100, predictedMs: 800, predictedPerSecond: 15 },
    stoppedByLimit: false,
    stoppedByUser: false,
  });
});

describe("assist mode leaves no trace in the model's long-term state", () => {
  it("extracts no memories from a spoken answer", async () => {
    await processMessage("how do dwarves differ across D&D editions", [], "en",
      undefined, undefined, undefined, { assistMode: true });

    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("does not re-persist the prefix, so the session cache stays valid", async () => {
    await processMessage("how do dwarves differ across D&D editions", [], "en",
      undefined, undefined, undefined, { assistMode: true });

    expect(mockPersistPrefix).not.toHaveBeenCalled();
  });

  it("still does both for an ordinary chat turn", async () => {
    await processMessage("how do dwarves differ across D&D editions", [], "en");

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockPersistPrefix).toHaveBeenCalledTimes(1);
  });
});

describe("processDeterministic", () => {
  it("returns null when the parser declines, whatever the model is doing", async () => {
    mockIsLoaded.mockReturnValue(true);

    const result = await processDeterministic("what is the capital of rhode island", "en");

    // The decisive property: a resident model must not turn a scheduling
    // check into a chat answer. That conflation is what made an answer look
    // like a clarification question everywhere downstream.
    expect(result).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns the parser's clarification when it has one", async () => {
    mockParse.mockReturnValue({
      status: "ambiguous",
      reason: "missing_time",
    } as never);

    const result = await processDeterministic("set an alarm tomorrow", "en");

    expect(result?.response.type).toBe("text");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
