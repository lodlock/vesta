// Two rules, both learned from one device transcript:
//
//   "How do you handle different tenses in Latin? Actually, cancel."
//   → "A reminder has been set to cancel the request about Latin tenses
//      at 11:30 AM."
//
// Nothing in that sentence is a time, and the request was explicitly withdrawn.
// Two independent failures, so two independent defences:
//
//   grounding      a scheduling action may only run when its temporal values
//                  came from the user. A required field is exactly where a
//                  sampled model confabulates — the schema says it must be
//                  present, so something plausible is produced.
//   cancellation   a retraction ends the turn before anything is parsed,
//                  routed or dispatched. Dictation has no backspace.
//
// Both are pure. No clock, no platform, no model.

import {
  abandonmentMarker,
  isAbandoned,
  abandonmentAcknowledgement,
} from "../cancellation";
import {
  ungroundedTemporalValue,
  hasTemporalEvidence,
  temporalFields,
  schedulesSomething,
  parserGrounding,
  apiGrounding,
} from "../grounding";

const THE_TRANSCRIPT = "How do you handle different tenses in Latin? Actually, cancel.";

describe("taking a request back", () => {
  it("recognises the transcript that set a reminder for nothing", () => {
    expect(isAbandoned(THE_TRANSCRIPT, "en")).toBe(true);
    expect(abandonmentMarker(THE_TRANSCRIPT, "en")).toBe("actually, cancel");
  });

  it.each([
    ["Set a 30 second timer, actually cancel.", "actually cancel"],
    ["Set a timer for five minutes — actually, cancel", "actually, cancel"],
    ["Set an alarm for seven — never mind.", "never mind"],
    ["Set an alarm for seven, nevermind", "nevermind"],
    ["Remind me to call John tomorrow at four... forget it.", "forget it"],
    ["Remind me to call John tomorrow at four. Scratch that.", "scratch that"],
    ["Schedule a meeting at nine, cancel that", "cancel that"],
    ["Wake me at six, ignore that", "ignore that"],
    ["Remind me at four, don't bother", "don't bother"],
    ["Set a timer for ten minutes, no wait, cancel it", "wait, cancel it"],
  ])("ends the turn: %s", (utterance, marker) => {
    expect(abandonmentMarker(utterance, "en")).toBe(marker);
  });

  it.each([
    "Set a timer per dieci minuti, anzi lascia stare",
    "Svegliami alle sette, lascia stare",
    "Ricordami di chiamare Mario domani alle quattro, non importa",
    "Metti una sveglia alle sei, anzi annulla",
  ])("ends the turn in Italian: %s", (utterance) => {
    expect(isAbandoned(utterance, "it")).toBe(true);
  });

  // The whole reason this is positional rather than lexical. "cancel" is an
  // ordinary word; the token alone means nothing.
  it.each([
    "Why was the TV show Cancelled?",
    "Why was my flight cancelled",
    "Remind me to cancel Netflix tomorrow at four.",
    "Set a reminder called cancel subscription for Friday at four.",
    "Remind me to cancel the gym membership",
    "What does cancel mean in Italian?",
    "Set a timer for five minutes",
    "Never mind the gap, remind me at four",
    "Forget it is a phrase I use too much, remind me at four",
  ])("leaves ordinary language alone: %s", (utterance) => {
    expect(abandonmentMarker(utterance, "en")).toBeNull();
  });

  it("recognises a marker whatever language the session is in", () => {
    // The recognizer's language is not always the app's.
    expect(isAbandoned("Set an alarm for seven, lascia stare", "en")).toBe(true);
    expect(isAbandoned("Metti una sveglia alle sette, never mind", "it")).toBe(true);
  });

  it("acknowledges in the session language", () => {
    expect(abandonmentAcknowledgement("en")).toBe("Okay, cancelled.");
    expect(abandonmentAcknowledgement("it")).toBe("Va bene, lascio stare.");
  });
});

describe("a scheduling action may never invent a time", () => {
  it("knows which tools arm something at a time", () => {
    expect(schedulesSomething("set_timer")).toBe(true);
    expect(schedulesSomething("set_alarm")).toBe(true);
    expect(schedulesSomething("set_reminder")).toBe(true);
    expect(schedulesSomething("create_event")).toBe(true);
    // Everything else has no temporal value to ground.
    expect(schedulesSomething("make_call")).toBe(false);
    expect(schedulesSomething("navigate_to")).toBe(false);
    expect(schedulesSomething("get_time")).toBe(false);
    expect(temporalFields("set_reminder")).toEqual(["datetime"]);
  });

  it("refuses the exact call that ran on device", () => {
    const refusal = ungroundedTemporalValue(
      "set_reminder",
      {
        text: "cancel the request about Latin tenses",
        datetime: "2026-09-15T11:30:00",
      },
      { source: "model", utterance: THE_TRANSCRIPT, lang: "en" },
    );

    expect(refusal).toBeTruthy();
    expect(refusal).toContain("no time, date or duration");
  });

  it.each([
    ["set_timer", { minutes: 5 }],
    ["set_alarm", { time: "11:30" }],
    ["set_reminder", { text: "something", datetime: "2026-09-15T11:30:00" }],
    ["create_event", { title: "something", start: "2026-09-15T11:30:00" }],
  ])("refuses %s when the utterance has no time in it", (tool, params) => {
    expect(
      ungroundedTemporalValue(tool, params, {
        source: "model",
        utterance: "tell me about the history of the dwarves",
        lang: "en",
      }),
    ).toBeTruthy();
  });

  it("refuses a caller that does not say where its values came from", () => {
    // Defence in depth means defaulting to refusal. A dispatch with no
    // provenance cannot be assumed to have any.
    expect(
      ungroundedTemporalValue("set_alarm", { time: "07:00" }, undefined),
    ).toContain("did not say where the value came from");
  });

  it("allows a model call when the user DID say something temporal", () => {
    expect(
      ungroundedTemporalValue(
        "set_reminder",
        { text: "call John", datetime: "2026-09-16T16:00:00" },
        { source: "model", utterance: "remind me to call John tomorrow at four", lang: "en" },
      ),
    ).toBeNull();
  });

  it("trusts the parser and an explicit API call", () => {
    const params = { time: "07:00" };
    // The parser returns `missing-time` rather than guessing, so anything it
    // resolved came from tokens the user said.
    expect(
      ungroundedTemporalValue("set_alarm", params, parserGrounding("wake me at seven", "en")),
    ).toBeNull();
    // An MCP client passing an ISO datetime IS the explicit input.
    expect(ungroundedTemporalValue("set_alarm", params, apiGrounding)).toBeNull();
  });

  it("leaves non-scheduling tools alone whatever the provenance", () => {
    expect(
      ungroundedTemporalValue("make_call", { contact: "John" }, undefined),
    ).toBeNull();
    expect(
      ungroundedTemporalValue("get_time", { place: "Oslo" }, undefined),
    ).toBeNull();
  });
});

describe("temporal evidence", () => {
  it.each([
    "remind me at 4",
    "remind me at 16:00",
    "wake me at 7pm",
    "set a timer for 30 seconds",
    "set a timer for five minutes",
    "remind me tomorrow",
    "remind me tonight",
    "remind me on Thursday",
    "remind me on 2026-09-16",
    "book something for the 16th",
    "in half an hour",
    "wake me at seven o'clock",
    "next week",
    "ricordami alle 16",
    "ricordami domani",
    "fra cinque minuti",
    "un timer di 30 secondi",
    "ricordami giovedì",
  ])("finds a time in: %s", (text) => {
    expect(hasTemporalEvidence(text, "en")).toBe(true);
  });

  it.each([
    "How do you handle different tenses in Latin? Actually, cancel.",
    "tell me about the history of the dwarves",
    "what is the capital of Rhode Island",
    "remind me to cancel Netflix",
    "set an alarm",
    "set a timer",
    "remind me to call John",
    "come si dice ciao in giapponese",
  ])("finds none in: %s", (text) => {
    expect(hasTemporalEvidence(text, "en")).toBe(false);
  });

  it("does not mistake a word that merely contains a number word", () => {
    // "tenses" must not read as "ten", "fortunate" as "forty", and so on.
    expect(hasTemporalEvidence("different tenses in Latin", "en")).toBe(false);
    expect(hasTemporalEvidence("a fortunate outcome", "en")).toBe(false);
    expect(hasTemporalEvidence("the second world war", "en")).toBe(false);
  });
});
