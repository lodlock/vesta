// The mapping from a resolved intent onto an existing tool call. What matters
// here is that the parameters match the tool schemas the dispatcher validates
// (HH:MM, YYYY-MM-DD, local ISO 8601) and that the confirmation text doesn't
// promise something Android won't do.

import { intentToToolCall, clarificationFor, formatDuration } from "../intent-to-tool";

// Wednesday 2026-09-16, 10:00 local.
const NOW = new Date(2026, 8, 16, 10, 0, 0);

describe("intentToToolCall", () => {
  it("maps a timer to set_timer in minutes, including sub-minute", () => {
    expect(intentToToolCall({ kind: "timer", durationSeconds: 300 }, NOW, "en")).toEqual({
      tool: "set_timer",
      parameters: { minutes: 5 },
      message: "Timer set for 5 minutes",
    });
    const short = intentToToolCall({ kind: "timer", durationSeconds: 30 }, NOW, "en");
    expect(short.parameters).toEqual({ minutes: 0.5 });
    expect(short.message).toBe("Timer set for 30 seconds");
  });

  it("maps an alarm to set_alarm with an HH:MM time", () => {
    const call = intentToToolCall(
      { kind: "alarm", time: "07:15", date: "2026-09-17" },
      NOW,
      "en",
    );
    expect(call.tool).toBe("set_alarm");
    expect(call.parameters).toEqual({ time: "07:15", date: "2026-09-17" });
    expect(call.message).toBe("Alarm set for 07:15 tomorrow");
  });

  it("adds the Android caveat only when the date is NOT the next occurrence", () => {
    // 07:15 tomorrow IS the next 07:15 (it is 10:00 today) — no caveat.
    expect(
      intentToToolCall({ kind: "alarm", time: "07:15", date: "2026-09-17" }, NOW, "en")
        .message,
    ).not.toMatch(/next occurrence/);
    // Friday is two days out; Android will arm tomorrow's instead. Say so.
    expect(
      intentToToolCall({ kind: "alarm", time: "07:15", date: "2026-09-18" }, NOW, "en")
        .message,
    ).toMatch(/next occurrence of this time, not 2026-09-18/);
  });

  it("maps a reminder to set_reminder with a LOCAL ISO datetime", () => {
    const call = intentToToolCall(
      {
        kind: "reminder",
        dateTime: new Date(2026, 8, 16, 18, 5, 0),
        text: "call mum",
      },
      NOW,
      "en",
    );
    expect(call.tool).toBe("set_reminder");
    // Local, not UTC: a Z-suffixed or shifted value would fire at the wrong time.
    expect(call.parameters).toEqual({
      text: "call mum",
      datetime: "2026-09-16T18:05:00",
    });
    expect(call.message).toBe("Reminder today 18:05: call mum");
  });

  it("maps a calendar event to create_event", () => {
    const call = intentToToolCall(
      {
        kind: "calendarEvent",
        start: new Date(2026, 8, 17, 15, 0, 0),
        title: "dentist",
      },
      NOW,
      "en",
    );
    expect(call.tool).toBe("create_event");
    expect(call.parameters).toEqual({
      title: "dentist",
      start: "2026-09-17T15:00:00",
    });
  });

  it("confirms in Italian when the language is Italian", () => {
    expect(
      intentToToolCall({ kind: "timer", durationSeconds: 600 }, NOW, "it").message,
    ).toBe("Timer di 10 minuti");
  });
});

describe("formatDuration", () => {
  it("reads back the way a person would say it", () => {
    expect(formatDuration(30, "en")).toBe("30 seconds");
    expect(formatDuration(60, "en")).toBe("1 minute");
    expect(formatDuration(5400, "en")).toBe("1 hour 30 minutes");
    expect(formatDuration(90, "it")).toBe("1 minuto e 30 secondi");
  });
});

describe("clarificationFor", () => {
  it("asks a question for every reason, in both languages", () => {
    const reasons = [
      "missing-duration", "missing-time", "missing-subject",
      "ambiguous-meridiem", "compound-request", "out-of-range", "time-in-past",
    ] as const;
    for (const r of reasons) {
      expect(clarificationFor(r, "en").length).toBeGreaterThan(0);
      expect(clarificationFor(r, "it").length).toBeGreaterThan(0);
    }
  });
});
