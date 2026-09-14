// Speech normalization: fillers, stammers, and correction segmentation.
// Pure functions, no mocks.

import { normalizeUtterance } from "../normalize";

describe("normalizeUtterance — disfluencies", () => {
  it("drops standalone fillers", () => {
    expect(normalizeUtterance("set a uh timer", "en").text).toBe("set a timer");
    expect(normalizeUtterance("um, set an alarm please", "en").text).toBe(
      "set an alarm",
    );
  });

  it("does not eat fillers that are substrings of real words", () => {
    // "summer" contains "um", "author" contains "uh".
    expect(normalizeUtterance("remind me about the summer party", "en").text).toBe(
      "remind me about the summer party",
    );
  });

  it("collapses a stammered repeated word", () => {
    expect(normalizeUtterance("a five five minute timer", "en").text).toBe(
      "a five minute timer",
    );
  });

  it("collapses a stammered repeated phrase", () => {
    expect(normalizeUtterance("set a uh set a five five minute timer", "en").text).toBe(
      "set a five minute timer",
    );
  });

  it("leaves a genuinely different number pair alone", () => {
    expect(normalizeUtterance("wake me at seven fifteen", "en").text).toBe(
      "wake me at seven fifteen",
    );
  });
});

describe("normalizeUtterance — corrections", () => {
  it("splits at a correction marker and reports it", () => {
    const n = normalizeUtterance("alarm for eight… no, eight thirty tomorrow", "en");
    expect(n.corrected).toBe(true);
    expect(n.segments).toEqual(["alarm for eight", "eight thirty tomorrow"]);
  });

  it("splits at 'actually'", () => {
    const n = normalizeUtterance("wake me tomorrow at seven… actually seven fifteen", "en");
    expect(n.segments).toEqual(["wake me tomorrow at seven", "seven fifteen"]);
  });

  it("does not split on a trailing marker with nothing after it", () => {
    const n = normalizeUtterance("set a timer no", "en");
    expect(n.corrected).toBe(false);
    expect(n.segments).toEqual(["set a timer no"]);
  });

  it("handles Italian correction markers", () => {
    const n = normalizeUtterance("sveglia alle otto anzi alle otto e mezza", "it");
    expect(n.corrected).toBe(true);
    expect(n.segments).toEqual(["sveglia alle otto", "alle otto e mezza"]);
  });
});

describe("normalizeUtterance — edges", () => {
  it("returns an empty result for empty input", () => {
    expect(normalizeUtterance("", "en")).toEqual({
      text: "",
      segments: [],
      corrected: false,
    });
  });

  it("returns a single segment when there is no correction", () => {
    expect(normalizeUtterance("set a timer for ten minutes", "en").segments).toEqual([
      "set a timer for ten minutes",
    ]);
  });
});
