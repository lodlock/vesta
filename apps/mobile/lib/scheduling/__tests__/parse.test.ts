// The scheduling parser, driven by the fuzzy-speech cases it exists for.
// `now` is injected everywhere, so these tests are clock-independent.

import { parseSchedulingCommand, type ScheduleParse } from "../parse";
import { intentToToolCalls } from "../intent-to-tool";

// Wednesday 2026-09-16, 10:00 local.
const NOW = new Date(2026, 8, 16, 10, 0, 0);

function parse(text: string, lang: "en" | "it" = "en", now: Date = NOW): ScheduleParse {
  return parseSchedulingCommand(text, { now, lang });
}

function resolved(p: ScheduleParse) {
  if (p.status !== "resolved") throw new Error(`expected resolved, got ${p.status}`);
  return p.intent;
}

describe("timers — stammered and fuzzy", () => {
  it('"set a uh set a five five minute timer" → 5 minutes', () => {
    expect(resolved(parse("set a uh set a five five minute timer"))).toEqual({
      kind: "timer",
      durationSeconds: 300,
    });
  });

  it('"set a timer for, uh, thirty seconds" → 30 seconds', () => {
    expect(resolved(parse("set a timer for, uh, thirty seconds"))).toEqual({
      kind: "timer",
      durationSeconds: 30,
    });
  });

  it('"give me forty-five minutes" → 45 minutes (implicit timer)', () => {
    expect(resolved(parse("give me forty-five minutes"))).toEqual({
      kind: "timer",
      durationSeconds: 2700,
    });
  });

  it("sums mixed units", () => {
    expect(resolved(parse("set a timer for one hour and thirty minutes"))).toEqual({
      kind: "timer",
      durationSeconds: 5400,
    });
  });

  it("understands half an hour", () => {
    expect(resolved(parse("timer for half an hour"))).toEqual({
      kind: "timer",
      durationSeconds: 1800,
    });
  });

  it("keeps an explicit label", () => {
    expect(resolved(parse("set a ten minute timer for the pasta"))).toEqual({
      kind: "timer",
      durationSeconds: 600,
      label: "pasta",
    });
  });

  it("takes the corrected duration, not the first one", () => {
    expect(resolved(parse("timer for ten minutes no make it twenty minutes"))).toEqual({
      kind: "timer",
      durationSeconds: 1200,
    });
  });

  it("Italian: timer di cinque minuti", () => {
    expect(resolved(parse("metti un timer di cinque minuti", "it"))).toEqual({
      kind: "timer",
      durationSeconds: 300,
    });
  });
});

describe("alarms — self-correction and meridiem", () => {
  it('"alarm for eight… no, eight thirty tomorrow" → 08:30 tomorrow', () => {
    expect(resolved(parse("alarm for eight… no, eight thirty tomorrow"))).toMatchObject({
      kind: "alarm",
      time: "08:30",
      date: "2026-09-17",
    });
  });

  it('"wake me tomorrow at seven… actually seven fifteen" keeps tomorrow from the first segment', () => {
    expect(
      resolved(parse("wake me tomorrow at seven… actually seven fifteen")),
    ).toMatchObject({ kind: "alarm", time: "07:15", date: "2026-09-17" });
  });

  it("a wake-up trigger reads a bare hour as morning", () => {
    // 07:00 has already passed at 10:00 — a wake-up still means 7am, not 7pm.
    expect(resolved(parse("wake me at seven"))).toMatchObject({
      kind: "alarm",
      time: "07:00",
    });
  });

  it("an explicit pm wins", () => {
    expect(resolved(parse("set an alarm for 7 pm"))).toMatchObject({ time: "19:00" });
  });

  it("a 24-hour reading is taken as spoken", () => {
    expect(resolved(parse("set an alarm for 19:30"))).toMatchObject({ time: "19:30" });
  });

  // Rule 6: a bare hour resolves to the NEXT PLAUSIBLE OCCURRENCE — whichever
  // of {h, h+12} comes sooner, rolling into tomorrow when both have passed.
  describe("a bare hour resolves to the next plausible occurrence", () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 16, h, m, 0);
    const alarmAt = (text: string, now: Date) => resolved(parse(text, "en", now));

    it("just after midnight, 'four' is this morning", () => {
      expect(alarmAt("set an alarm for four", at(0, 30))).toMatchObject({
        time: "04:00",
        date: "2026-09-16",
      });
    });

    it("at 02:00, 'four' is two hours away, not fourteen", () => {
      expect(alarmAt("set an alarm for four", at(2))).toMatchObject({
        time: "04:00",
        date: "2026-09-16",
      });
    });

    it("in the early morning, 'nine' is this morning", () => {
      expect(alarmAt("set an alarm for nine", at(6))).toMatchObject({
        time: "09:00",
        date: "2026-09-16",
      });
    });

    it("in the late morning, 'nine' has passed and means tonight", () => {
      expect(alarmAt("set an alarm for nine", at(11))).toMatchObject({
        time: "21:00",
        date: "2026-09-16",
      });
    });

    it("in the afternoon, 'four' is this afternoon", () => {
      expect(alarmAt("set an alarm for four", at(13))).toMatchObject({
        time: "16:00",
        date: "2026-09-16",
      });
    });

    it("in the evening, 'four' is tomorrow morning — the nearer of the two", () => {
      expect(alarmAt("set an alarm for four", at(20))).toMatchObject({
        time: "04:00",
        date: "2026-09-17",
      });
    });

    it("crosses midnight: at 23:30, 'four' is 04:00 the next day", () => {
      expect(alarmAt("set an alarm for four", at(23, 30))).toMatchObject({
        time: "04:00",
        date: "2026-09-17",
      });
    });

    it("crosses midnight for an explicit 24-hour time too", () => {
      expect(alarmAt("set an alarm for 19:30", at(22))).toMatchObject({
        time: "19:30",
        date: "2026-09-17",
      });
    });

    it("a named day uses the daytime reading, where 'nearest' means nothing", () => {
      // "tomorrow at four" is 16:00 — the 04:00 reading is nearer but nobody
      // means it.
      expect(alarmAt("set an alarm tomorrow at four", at(13))).toMatchObject({
        time: "16:00",
        date: "2026-09-17",
      });
      expect(alarmAt("set an alarm tomorrow at nine", at(13))).toMatchObject({
        time: "09:00",
        date: "2026-09-17",
      });
    });
  });

  it("a part-of-day word overrides the daytime rule", () => {
    expect(resolved(parse("set an alarm for nine tonight"))).toMatchObject({
      time: "21:00",
    });
    expect(resolved(parse("set an alarm for four in the morning"))).toMatchObject({
      time: "04:00",
    });
  });

  it("handles half past / quarter to", () => {
    expect(resolved(parse("set an alarm for half past six"))).toMatchObject({
      time: "18:30",
    });
    expect(resolved(parse("set an alarm for quarter to eight am"))).toMatchObject({
      time: "07:45",
    });
  });

  it("Italian: sveglia alle sette e mezza", () => {
    expect(resolved(parse("metti la sveglia alle sette e mezza", "it"))).toMatchObject({
      kind: "alarm",
      time: "07:30",
    });
  });
});

describe("reminders", () => {
  it("resolves a subject and a clock time", () => {
    const intent = resolved(parse("remind me to call mum at six"));
    expect(intent).toMatchObject({ kind: "reminder", text: "call mum" });
    if (intent.kind === "reminder") {
      expect(intent.dateTime.getHours()).toBe(18);
    }
  });

  it("treats a duration as an offset from now", () => {
    const intent = resolved(parse("remind me to take the bread out in ten minutes"));
    if (intent.kind !== "reminder") throw new Error("expected a reminder");
    expect(intent.text).toBe("take the bread out");
    expect(intent.dateTime.getTime()).toBe(NOW.getTime() + 600_000);
  });

  it("keeps the subject from the first segment across a correction", () => {
    const intent = resolved(
      parse("remind me to call the dentist at four no actually at five"),
    );
    if (intent.kind !== "reminder") throw new Error("expected a reminder");
    expect(intent.text).toBe("call the dentist");
    expect(intent.dateTime.getHours()).toBe(17);
  });
});

describe("ambiguity — asks instead of guessing", () => {
  const ambiguous = (text: string, lang: "en" | "it" = "en") => {
    const p = parse(text, lang);
    if (p.status !== "ambiguous") throw new Error(`expected ambiguous, got ${p.status}`);
    return p.reason;
  };

  it("a timer with no duration asks for one", () => {
    expect(ambiguous("set a timer")).toBe("missing-duration");
  });

  it("a timer given a clock time (not a duration) asks rather than arming one", () => {
    expect(ambiguous("set a timer for seven")).toBe("missing-duration");
  });

  it("an alarm with no time asks for one", () => {
    expect(ambiguous("wake me")).toBe("missing-time");
    expect(ambiguous("set an alarm")).toBe("missing-time");
  });

  it("a bare twelve is genuinely two-way", () => {
    expect(ambiguous("set an alarm for twelve")).toBe("ambiguous-meridiem");
  });

  it("a reminder with no subject asks what about", () => {
    expect(ambiguous("remind me at five")).toBe("missing-subject");
  });

  it("an implausible timer length is refused", () => {
    expect(ambiguous("set a timer for fifty hours")).toBe("out-of-range");
  });

  it("two different actions are never silently reduced to one", () => {
    expect(ambiguous("set an alarm for seven and a timer for ten minutes")).toBe(
      "compound-request",
    );
  });
});

describe("declines — leaves the model alone", () => {
  const none = (text: string, lang: "en" | "it" = "en") =>
    expect(parse(text, lang).status).toBe("none");

  it("ignores plain conversation", () => {
    none("what's the weather like");
    none("tell me a story about a dragon");
    none("ciao come stai", "it");
  });

  it("ignores questions about the schedule", () => {
    none("what time is my alarm set for?");
    none("when is my dentist appointment");
    none("do I have any reminders");
  });

  it("does not claim 'give me' without a duration", () => {
    none("give me a hand with this");
  });

  it("does not claim a calendar event it cannot title", () => {
    none("schedule something at three");
  });

  it("ignores empty input", () => {
    none("   ");
  });
});

describe("calendar events", () => {
  it("resolves title + start when both are clear", () => {
    const intent = resolved(parse("schedule a dentist appointment tomorrow at three"));
    if (intent.kind !== "calendarEvent") throw new Error("expected an event");
    expect(intent.title).toBe("dentist");
    expect(intent.start.getHours()).toBe(15);
    expect(intent.start.getDate()).toBe(17);
  });
});

describe("timer with an earlier warning", () => {
  const pair = (text: string, lang: "en" | "it" = "en") => {
    const intent = resolved(parse(text, lang));
    if (intent.kind !== "timerWithWarning") {
      throw new Error(`expected timerWithWarning, got ${intent.kind}`);
    }
    return [intent.warningSeconds / 60, intent.durationSeconds / 60];
  };

  it("reads 'N before' as an offset back from the end", () => {
    expect(pair("give me forty-five minutes, but remind me five minutes before too"))
      .toEqual([40, 45]);
    expect(pair("give me an hour but warn me ten minutes before")).toEqual([50, 60]);
    expect(pair("set a thirty minute timer and another one five minutes before that"))
      .toEqual([25, 30]);
  });

  it("reads a bare warning as an offset too", () => {
    expect(pair("forty-five minutes, with a five-minute warning")).toEqual([40, 45]);
  });

  it("reads 'a warning at M' as the warning's own length", () => {
    expect(pair("timer for forty five, give me a warning at forty")).toEqual([40, 45]);
  });

  it("reads bare numbers as minutes in this shape", () => {
    // Not a unit word in sight — and "forty five ... forty" can only be minutes.
    expect(pair("timer for forty five, warning at forty")).toEqual([40, 45]);
  });

  it("survives fillers and a stammered repeat", () => {
    expect(pair("give me uh forty-five minutes but warn me five five minutes before"))
      .toEqual([40, 45]);
    expect(pair("timer for forty-five, warning at uh forty")).toEqual([40, 45]);
  });

  it("takes the corrected duration, even with no 'timer' word anywhere", () => {
    expect(pair("set thirty minutes no wait forty-five, and warn me five before"))
      .toEqual([40, 45]);
  });

  it("works in Italian", () => {
    expect(pair("dammi quarantacinque minuti ma avvisami cinque minuti prima", "it"))
      .toEqual([40, 45]);
  });

  it("still asks when the relationship is not stated", () => {
    const ask = (text: string) => {
      const p = parse(text);
      if (p.status !== "ambiguous") throw new Error(`expected ambiguous, got ${p.status}`);
      return p.reason;
    };
    expect(ask("set two timers before dinner")).toBe("missing-duration");
    expect(ask("warn me before the timer")).toBe("missing-duration");
    expect(ask("give me a warning sometime before forty-five minutes")).toBe(
      "missing-duration",
    );
  });

  it("refuses a warning that isn't before the end", () => {
    // A 50-minute warning on a 45-minute timer is not a warning.
    const p = parse("give me forty-five minutes but warn me fifty minutes before");
    expect(p.status).toBe("ambiguous");
  });

  it("does not drag a plain reminder into a timer pair", () => {
    const intent = resolved(parse("remind me to call mum at six"));
    expect(intent.kind).toBe("reminder");
  });

  it("dispatches as two timers, warning first", () => {
    const calls = intentToToolCalls(
      { kind: "timerWithWarning", durationSeconds: 2700, warningSeconds: 2400 },
      NOW,
      "en",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      tool: "set_timer",
      parameters: { minutes: 40, label: "Warning" },
    });
    expect(calls[1]).toMatchObject({
      tool: "set_timer",
      parameters: { minutes: 45 },
    });
    // The primary (last) call confirms the whole request.
    expect(calls[1].message).toBe("Timer set for 45 minutes, with a warning at 40 minutes");
  });
});
