// World time, answered from the device.
//
// Vesta used to tell the user it had no live data access and to check a world
// clock. It had the answer the whole time: the current instant, plus the IANA
// tz database that ships with Android and backs ICU. So these tests pin the
// thing that makes that true — a fixed instant in, a correct wall clock out,
// including the two cases a model gets wrong from memory: DST, and the day
// rolling over.
//
// Every instant here is explicit (UTC, so the test machine's own zone is
// irrelevant) and the home zone is injected. Nothing reads the wall clock.

import {
  parseTimeQuestion,
  answerTimeQuestion,
  answerIfTimeQuestion,
  offsetMinutes,
  partsIn,
} from "../world-time";
import { resolveZone } from "../zones";

// Wednesday 15 July 2026, 12:00 UTC — northern summer, so Europe is on DST.
const SUMMER = new Date("2026-07-15T12:00:00Z");
// Wednesday 14 January 2026, 12:00 UTC — northern winter, so it is not.
const WINTER = new Date("2026-01-14T12:00:00Z");
const HOME = "Europe/Rome";

const answer = (text: string, now = SUMMER, home = HOME) =>
  answerIfTimeQuestion(text, "en", now, home);

describe("recognising a time question", () => {
  it.each([
    ["what time is it", "time", null],
    ["What time is it?", "time", null],
    ["what's the time", "time", null],
    ["what time is it in Norway", "time", "Norway"],
    ["What time is it in Oslo?", "time", "Oslo"],
    ["what time is it in Tokyo", "time", "Tokyo"],
    ["current time in London", "time", "London"],
    ["what day is it", "date", null],
    ["What day is it in Sydney?", "date", "Sydney"],
    ["what's the date in Tokyo", "date", "Tokyo"],
  ])("reads %s", (text, kind, place) => {
    const q = parseTimeQuestion(text, "en");
    expect(q?.kind).toBe(kind);
    expect(q?.place).toBe(place);
  });

  it("reads the timezone and difference forms", () => {
    expect(parseTimeQuestion("what's my timezone", "en")?.kind).toBe("zone");
    expect(parseTimeQuestion("what timezone am I in?", "en")?.kind).toBe("zone");
    const diff = parseTimeQuestion(
      "what's the time difference between here and London",
      "en",
    );
    expect(diff?.kind).toBe("difference");
    expect(diff?.place).toBeNull(); // "here"
    expect(diff?.other).toBe("London");
  });

  it("reads Italian", () => {
    expect(parseTimeQuestion("che ore sono", "it")?.place).toBeNull();
    expect(parseTimeQuestion("che ore sono in Norvegia", "it")?.place).toBe("Norvegia");
    expect(parseTimeQuestion("che giorno è oggi", "it")?.kind).toBe("date");
  });

  // This runs before the model on every utterance, so a loose pattern would
  // answer real questions with a clock reading.
  it.each([
    "what time should I leave for the airport",
    "how do you handle different tenses in Latin",
    "set a timer for five minutes",
    "what time zone changes happened in 1970",
    "tell me about the history of time",
    "remind me what time the meeting is",
  ])("leaves alone: %s", (text) => {
    expect(parseTimeQuestion(text, "en")).toBeNull();
  });
});

describe("resolving a place to a zone", () => {
  it("maps a country with one obvious zone", () => {
    expect(resolveZone("Norway")).toEqual({
      status: "resolved",
      zone: "Europe/Oslo",
      label: "Norway",
    });
    expect(resolveZone("Japan")).toMatchObject({ zone: "Asia/Tokyo" });
    expect(resolveZone("italia")).toMatchObject({ zone: "Europe/Rome" });
  });

  it("maps cities, and prefers them over countries", () => {
    expect(resolveZone("Oslo")).toMatchObject({ zone: "Europe/Oslo" });
    expect(resolveZone("Tokyo")).toMatchObject({ zone: "Asia/Tokyo" });
    expect(resolveZone("New York")).toMatchObject({ zone: "America/New_York" });
    expect(resolveZone("the Hague")).toMatchObject({ status: "unknown" });
  });

  it("accepts an IANA id said outright", () => {
    expect(resolveZone("Europe/Oslo")).toMatchObject({ zone: "Europe/Oslo" });
  });

  it("asks rather than guessing for a genuinely multi-zone country", () => {
    const us = resolveZone("the United States");
    expect(us.status).toBe("ambiguous");
    if (us.status === "ambiguous") {
      expect(us.examples).toContain("New York");
      expect(us.examples).toContain("Los Angeles");
    }
    for (const place of ["USA", "Australia", "Russia", "Canada", "Brazil", "Mexico"]) {
      expect(resolveZone(place).status).toBe("ambiguous");
    }
  });
});

describe("answering with a fixed clock", () => {
  it("gives the local time", () => {
    // 12:00 UTC in July, Rome is UTC+2.
    expect(answer("what time is it")).toEqual({ status: "resolved", text: "It's 14:00." });
  });

  it("gives another country's time, with the offset", () => {
    const res = answer("what time is it in Norway");
    expect(res).toMatchObject({ status: "resolved" });
    // Oslo is the same zone as Rome, so no offset note.
    if (res?.status === "resolved") expect(res.text).toBe("It's 14:00 in Norway.");
  });

  it("gives a city's time across a big offset", () => {
    const res = answer("what time is it in Tokyo");
    if (res?.status !== "resolved") throw new Error("expected an answer");
    // 12:00 UTC → 21:00 JST, 7 hours ahead of Rome's CEST.
    expect(res.text).toContain("21:00");
    expect(res.text).toContain("Tokyo");
    expect(res.text).toContain("7 hours ahead");
  });

  it("says when it is already the next day there", () => {
    // 16:00 UTC on Wednesday the 15th: 18:00 here in Rome, but 01:00 on
    // Thursday the 16th in Tokyo. "It's 01:00 in Tokyo" alone would be
    // misleading while it is still Wednesday evening where the user is.
    const res = answer("what time is it in Tokyo", new Date("2026-07-15T16:00:00Z"));
    if (res?.status !== "resolved") throw new Error("expected an answer");
    expect(res.text).toContain("01:00");
    expect(res.text).toContain("next day");
    expect(res.text).toContain("Thursday");
  });

  it("says when it is still the previous day there", () => {
    // 01:00 UTC on the 15th is 18:00 on the 14th in Los Angeles.
    const res = answer(
      "what time is it in Los Angeles",
      new Date("2026-07-15T01:00:00Z"),
    );
    if (res?.status !== "resolved") throw new Error("expected an answer");
    expect(res.text).toContain("18:00");
    expect(res.text).toContain("previous day");
  });

  it("gives the date here and elsewhere", () => {
    const here = answer("what day is it");
    expect(here).toMatchObject({ status: "resolved" });
    if (here?.status === "resolved") expect(here.text).toContain("Wednesday");

    const there = answer("what day is it in Sydney", new Date("2026-07-15T22:00:00Z"));
    if (there?.status !== "resolved") throw new Error("expected an answer");
    // Already Thursday the 16th in Sydney while it is still Wednesday here.
    expect(there.text).toContain("Thursday");
    expect(there.text).toContain("16");
  });

  it("reports the device's own zone", () => {
    const res = answer("what's my timezone");
    if (res?.status !== "resolved") throw new Error("expected an answer");
    expect(res.text).toContain("Europe/Rome");
    expect(res.text).toContain("UTC+2");
  });

  it("gives a difference between two places", () => {
    const res = answer("what's the time difference between here and Tokyo");
    if (res?.status !== "resolved") throw new Error("expected an answer");
    expect(res.text).toContain("7 hours ahead");
  });

  it("asks which city for a multi-zone country", () => {
    const res = answer("what time is it in the United States");
    expect(res?.status).toBe("ambiguous");
    if (res?.status === "ambiguous") {
      expect(res.question).toContain("several time zones");
      expect(res.question).toContain("New York");
    }
  });

  it("asks rather than inventing a zone it doesn't know", () => {
    const res = answer("what time is it in Narnia");
    expect(res?.status).toBe("ambiguous");
    if (res?.status === "ambiguous") expect(res.question).toContain("Narnia");
  });

  it("answers in Italian", () => {
    const res = answerIfTimeQuestion("che ore sono in Giappone", "it", SUMMER, HOME);
    if (res?.status !== "resolved") throw new Error("expected an answer");
    expect(res.text).toContain("21:00");
    expect(res.text).toContain("Giappone");
  });
});

describe("DST, which is the reason not to ask a model", () => {
  it("shifts Europe by an hour between summer and winter", () => {
    expect(offsetMinutes(SUMMER, "Europe/Oslo")).toBe(120); // CEST
    expect(offsetMinutes(WINTER, "Europe/Oslo")).toBe(60); // CET
    expect(offsetMinutes(SUMMER, "America/New_York")).toBe(-240); // EDT
    expect(offsetMinutes(WINTER, "America/New_York")).toBe(-300); // EST
  });

  it("leaves zones without DST alone", () => {
    expect(offsetMinutes(SUMMER, "Asia/Tokyo")).toBe(540);
    expect(offsetMinutes(WINTER, "Asia/Tokyo")).toBe(540);
    // India's half-hour offset, which is the other thing models get wrong.
    expect(offsetMinutes(SUMMER, "Asia/Kolkata")).toBe(330);
  });

  it("inverts for the southern hemisphere", () => {
    // Sydney is on DST in the southern summer — the opposite months to Europe.
    expect(offsetMinutes(WINTER, "Australia/Sydney")).toBe(660); // AEDT
    expect(offsetMinutes(SUMMER, "Australia/Sydney")).toBe(600); // AEST
  });

  it("crosses a DST boundary at the right instant", () => {
    // EU clocks go forward at 01:00 UTC on the last Sunday of March 2026 (29th).
    const before = new Date("2026-03-29T00:59:00Z");
    const after = new Date("2026-03-29T01:01:00Z");
    expect(offsetMinutes(before, "Europe/Oslo")).toBe(60);
    expect(offsetMinutes(after, "Europe/Oslo")).toBe(120);
    expect(partsIn(before, "Europe/Oslo").hour).toBe(1);
    expect(partsIn(after, "Europe/Oslo").hour).toBe(3); // 02:00 never happens
  });

  it("gives the right wall clock either side of that boundary", () => {
    const before = answer("what time is it in Oslo", new Date("2026-03-29T00:30:00Z"));
    const after = answer("what time is it in Oslo", new Date("2026-03-29T01:30:00Z"));
    if (before?.status !== "resolved" || after?.status !== "resolved") {
      throw new Error("expected answers");
    }
    expect(before.text).toContain("01:30");
    expect(after.text).toContain("03:30");
  });
});

describe("answerTimeQuestion is pure", () => {
  it("returns the same answer for the same instant", () => {
    const q = { kind: "time" as const, place: "Tokyo" };
    expect(answerTimeQuestion(q, SUMMER, HOME, "en")).toEqual(
      answerTimeQuestion(q, SUMMER, HOME, "en"),
    );
  });
});
