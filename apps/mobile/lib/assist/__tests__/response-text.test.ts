// What the assistant may show and say. Pure functions, no model.

import { visibleAnswer, spokenAnswer } from "../response-text";

describe("visibleAnswer — reasoning never reaches the user", () => {
  it("removes a Qwen-style think block", () => {
    expect(
      visibleAnswer("<think>Let me work this out. 2+2=4.</think>The answer is 4."),
    ).toBe("The answer is 4.");
  });

  it("removes the other delimiters open models use", () => {
    for (const tag of ["thinking", "reasoning", "reflection", "analysis"]) {
      expect(visibleAnswer(`<${tag}>hidden</${tag}>Visible.`)).toBe("Visible.");
    }
  });

  it("is case-insensitive and handles several blocks", () => {
    expect(visibleAnswer("<THINK>a</THINK>One. <think>b</think>Two.")).toBe(
      "One. Two.",
    );
  });

  it("keeps only what follows an orphan closing tag", () => {
    // The opening tag was consumed before the text reached us.
    expect(visibleAnswer("I should check the capital.</think>Providence.")).toBe(
      "Providence.",
    );
  });

  it("drops everything after an orphan OPENING tag", () => {
    // Generation was cut off mid-thought: there is no answer, and the thought
    // must not be shown in its place.
    expect(visibleAnswer("Here goes.<think>Actually the user means…")).toBe("Here goes.");
  });

  it("never returns reasoning when that is all there was", () => {
    expect(visibleAnswer("<think>only thinking, no answer</think>")).toBe("");
  });

  it("leaves an ordinary answer untouched", () => {
    expect(visibleAnswer("Providence is the capital of Rhode Island.")).toBe(
      "Providence is the capital of Rhode Island.",
    );
  });

  it("handles empty input", () => {
    expect(visibleAnswer("")).toBe("");
  });
});

describe("visibleAnswer — tool JSON is never read out", () => {
  it("speaks the message from a leaked tool call, not the JSON", () => {
    expect(
      visibleAnswer('{"tool":"set_timer","parameters":{"minutes":5},"message":"Timer set"}'),
    ).toBe("Timer set");
  });

  it("handles a fenced tool call", () => {
    expect(
      visibleAnswer('```json\n{"tool":"set_alarm","message":"Alarm set"}\n```'),
    ).toBe("Alarm set");
  });

  it("returns nothing for a tool call with no human message", () => {
    expect(visibleAnswer('{"tool":"set_timer","parameters":{"minutes":5}}')).toBe("");
  });

  it("leaves ordinary text that merely contains a brace alone", () => {
    expect(visibleAnswer("Use {} for an empty set.")).toBe("Use {} for an empty set.");
  });
});

describe("spokenAnswer", () => {
  it("passes a short answer through unchanged", () => {
    expect(spokenAnswer("Timer set for 5 minutes")).toBe("Timer set for 5 minutes");
  });

  it("does not read markdown punctuation aloud", () => {
    expect(spokenAnswer("**Providence** is the `capital`.")).toBe(
      "Providence is the capital.",
    );
  });

  it("drops code blocks", () => {
    expect(spokenAnswer("Run this:\n```\nnpm install\n```\nThen restart.")).toBe(
      "Run this: Then restart.",
    );
  });

  it("stops on a sentence boundary rather than mid-clause", () => {
    const long = "One sentence here. " + "Another sentence follows. ".repeat(20);
    const spoken = spokenAnswer(long, 60);
    expect(spoken.length).toBeLessThanOrEqual(60);
    expect(spoken.endsWith(".")).toBe(true);
  });

  it("clips one enormous sentence on a word boundary", () => {
    const spoken = spokenAnswer("word ".repeat(200), 50);
    expect(spoken.length).toBeLessThanOrEqual(51); // + the ellipsis
    expect(spoken.endsWith("…")).toBe(true);
    expect(spoken).not.toMatch(/wor…$/); // not mid-word
  });

  it("collapses whitespace so pauses are natural", () => {
    expect(spokenAnswer("Providence.\n\n\nRhode Island.")).toBe(
      "Providence. Rhode Island.",
    );
  });
});
