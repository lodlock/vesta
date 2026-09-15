// One turn of "system assistant button → spoken command → answer or action".
//
// The shape of this path is a deliberate trade. Scheduling is answered locally
// by the deterministic parser — instantly, with the model never loaded. Anything
// else is a catch-all: the utterance goes to the local model automatically, and
// the cost of that (a cold load of multi-GB weights) is paid only once the
// parser has actually declined. Clarifications stay on the cheap side of that
// line: a half-specified alarm is finished by asking, not by waking the model.
//
// processMessage is reused as-is, not reimplemented: its scheduling fast path
// runs before the model-loaded check and before any generation, so calling it
// with no model returns either a resolved action, a clarification question, or
// "No model loaded" — which is exactly the three-way split this screen needs.

import { create } from "zustand";
import { processMessage, executeToolCall } from "../orchestrator/orchestrator";
import type { Language, ToolCallResult } from "../orchestrator/types";
import { startAssistCapture, finishAssistantActivity } from "../native/assist";
import { speak, stopSpeaking } from "../native/speech";
import { visibleAnswer, spokenAnswer } from "../assist/response-text";
import { getConfig } from "../storage/database";
import {
  emptySession,
  persistAssistSession,
  shouldPersistAutomatically,
  type AssistInteractionKind,
  type AssistSession,
} from "./assist-session";
import { useChatStore } from "./chat-store";

export type AssistPhase =
  | "idle"
  | "listening" // the recognizer is up; we are waiting for a transcript
  | "working" // parsing / dispatching
  | "thinking" // the model is loading or generating
  | "done" // an action ran
  | "confirm" // a destructive action is proposed and gated
  | "clarify" // the parser asked a question
  | "fallback" // not a scheduling command, and auto-fallback is off
  | "answer"; // the model replied

interface PendingAction {
  tool: string;
  parameters: Record<string, unknown>;
}

// How long to wait after the confirmation has been spoken before the overlay
// gets out of the way. Short enough to feel automatic, long enough not to clip
// the tail of the utterance on engines that report "done" eagerly.
const DISMISS_GRACE_MS = 400;
// Speech should never hold the overlay open: if an engine goes quiet without
// reporting, dismiss anyway.
const SPEECH_TIMEOUT_MS = 8000;
// A model answer stays up longer than a confirmation: it is worth reading, and
// the user may want Open Chat. Long enough to act, short enough that a spoken
// answer doesn't leave Vesta sitting in front of whatever they were doing.
const ANSWER_LINGER_MS = 6000;

interface AssistState {
  active: boolean;
  phase: AssistPhase;
  transcript: string;
  message: string;
  failed: boolean;
  pending: PendingAction | null;
  // The utterance a clarification was asked about. A follow-up is parsed as
  // "<original> <answer>" so "4 PM" can complete "alarm tomorrow at four"
  // deterministically, without a model and without the parser needing state.
  clarifying: string | null;
  // What this turn was and whether it has been written down. Everything the
  // persistence policy needs lives here rather than being re-derived from the
  // phase, which cannot distinguish a deterministic confirmation from a model
  // answer after the fact.
  session: AssistSession;
  /** True while a timeout is waiting to close the assistant. */
  autoFinishPending: boolean;

  handle: (transcript: string) => Promise<void>;
  confirm: (approved: boolean) => Promise<void>;
  listenAgain: () => Promise<void>;
  askModel: () => Promise<void>;
  /**
   * Hand over to the full app. Persists this turn if it isn't already, and
   * resolves the conversation to open — never the one that happened to be
   * active before the assistant was invoked.
   */
  openChat: () => Promise<string | null>;
  /** Leave the assistant and return to the previous app. */
  close: () => void;
  dismiss: () => void;
}

function language(): Language {
  return useChatStore.getState().language;
}

async function settingEnabled(key: string): Promise<boolean> {
  try {
    // Unset means on: both assistant settings default ON.
    return (await getConfig(key)) !== "false";
  } catch {
    return true;
  }
}

export const useAssistStore = create<AssistState>((set, get) => {
  // The pending auto-finish. Cancelled the moment the user does anything —
  // tapping Open Chat, answering a question, starting another turn — because
  // closing the screen under someone who is using it is worse than lingering.
  let autoFinish: ReturnType<typeof setTimeout> | null = null;

  const cancelAutoFinish = () => {
    if (autoFinish !== null) {
      clearTimeout(autoFinish);
      autoFinish = null;
    }
    set({ autoFinishPending: false });
  };

  // Leaves the screen entirely, returning the user to the app they came from.
  // The assistant is a visitor: once it has said its piece there is nothing to
  // look at, and making someone dismiss it by hand is the behaviour this
  // replaces.
  const leave = () => {
    cancelAutoFinish();
    get().dismiss();
    finishAssistantActivity();
  };

  const scheduleLeave = (afterMs: number) => {
    cancelAutoFinish();
    autoFinish = setTimeout(() => {
      autoFinish = null;
      set({ autoFinishPending: false });
      // Only if the turn is still where it was left — a new invocation or an
      // opened chat has taken over otherwise.
      const phase = get().phase;
      if (phase === "answer" || phase === "done") leave();
    }, afterMs);
    set({ autoFinishPending: true });
  };

  // One in-flight write at a time, shared by the automatic path and the Open
  // Chat tap. Without this a model answer that persists itself while the user
  // reaches for Open Chat would produce two conversations for one turn.
  let persistInFlight: Promise<string | null> | null = null;

  const persistSession = async (): Promise<string | null> => {
    const existing = get().session.persistedChatId;
    if (existing) return existing;
    if (persistInFlight) return persistInFlight;

    persistInFlight = persistAssistSession(get().session)
      .then((id) => {
        if (id) {
          set((state) => ({ session: { ...state.session, persistedChatId: id } }));
        }
        return id;
      })
      .catch((err) => {
        console.warn("[assist] could not persist the session:", err);
        return null;
      })
      .finally(() => {
        persistInFlight = null;
      });
    return persistInFlight;
  };

  // Records the outcome of a turn, and writes it now if the policy says so.
  // Called at every point a turn reaches its final response.
  const completeSession = async (
    kind: AssistInteractionKind,
    prompt: string,
    response: string,
  ) => {
    set((state) => ({
      session: { ...state.session, kind, prompt, response, complete: true },
    }));
    if (shouldPersistAutomatically(get().session)) {
      // Awaited deliberately: the answer must be on disk before TTS finishes
      // and the auto-finish window opens, so a timeout or a killed process
      // cannot lose something the user already has.
      await persistSession();
    }
  };

  // Speaks `text` and resolves when it has actually been heard (or the engine
  // gave up). Callers that dismiss afterwards get the tail of the sentence.
  const say = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    if (!(await settingEnabled("assist_speak"))) return;
    await Promise.race([
      speak(spokenAnswer(text), language()),
      new Promise((resolve) => setTimeout(resolve, SPEECH_TIMEOUT_MS)),
    ]);
  };

  // A completed device action: say it, then get out of the way. The overlay is
  // a means to an end — once the timer is set there is nothing to look at, and
  // the user should be back where they were.
  const finishAndDismiss = async (message: string) => {
    await say(message);
    await new Promise((resolve) => setTimeout(resolve, DISMISS_GRACE_MS));
    // Unless something arrived in the meantime (a new invocation, or the user
    // opened chat), in which case that turn owns the screen now.
    if (get().phase === "done" && !get().failed) leave();
  };

  // Hand the utterance to the model. Loads it if needed — this is the only
  // path that does, and it is only reached once the parser has declined.
  const runModel = async (text: string) => {
    set({ phase: "thinking", message: "" });
    try {
      await useChatStore.getState().ensureModelLoaded();
      const res = await processMessage(text, [], language(), undefined, undefined, undefined, {
        assistMode: true,
      });
      if (res.type === "text") {
        // Belt and braces over the runtime's own reasoning suppression: never
        // show, and never speak, a thinking block.
        const answer = visibleAnswer(res.content);
        if (!answer) {
          set({ phase: "answer", failed: true, message: "No answer." });
          return;
        }
        set({ phase: "answer", failed: false, message: answer });
        // Written BEFORE it is spoken: speech takes seconds and the
        // auto-finish follows it, so persisting afterwards would leave a
        // window where an answer exists on screen but nowhere else.
        await completeSession("model", text, answer);
        await say(answer);
        // Spoken and on screen. Give the user a window to read it or tap Open
        // Chat, then get out of the way on their behalf.
        scheduleLeave(ANSWER_LINGER_MS);
      } else if (res.type === "error") {
        set({ phase: "answer", failed: true, message: res.error });
      } else if (res.type === "pending_tool_call") {
        set({
          phase: "confirm",
          message: res.message,
          pending: { tool: res.tool, parameters: res.parameters },
        });
        await say(res.message);
      } else {
        const failed = !res.result.success;
        set({ phase: "done", failed, message: res.message });
        if (!failed) await completeSession("model", text, res.message);
        if (failed) await say(res.message);
        else await finishAndDismiss(res.message);
      }
    } catch (err) {
      set({
        phase: "answer",
        failed: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    active: false,
    phase: "idle",
    transcript: "",
    message: "",
    failed: false,
    pending: null,
    clarifying: null,
    session: { ...emptySession },
    autoFinishPending: false,

    handle: async (transcript: string) => {
      // A new invocation silences the previous answer rather than talking over
      // it, and takes ownership of the screen from any pending auto-finish.
      stopSpeaking();
      cancelAutoFinish();

      const previous = get().clarifying;
      // A follow-up completes the earlier utterance rather than replacing it.
      const text = previous ? `${previous} ${transcript}` : transcript;

      set((state) => ({
        active: true,
        phase: "working",
        transcript,
        message: "",
        failed: false,
        pending: null,
        clarifying: null,
        // A follow-up continues the same session (it is one interaction the
        // user is having); a fresh invocation starts a new one.
        session: previous ? state.session : { ...emptySession },
      }));

      try {
        const res = await processMessage(text, [], language());
        switch (res.type) {
          case "tool_call": {
            const failed = !res.result.success;
            set({ phase: "done", message: res.message, failed });
            if (!failed) {
              // Recorded, not written: the timer IS the outcome, and a
              // conversation only appears if the user asks for one.
              await completeSession(
                previous ? "clarification" : "deterministic",
                text,
                res.message,
              );
            }
            // A failure stays on screen to be read; a success speaks and goes.
            if (failed) await say(res.message);
            else await finishAndDismiss(res.message);
            return;
          }
          case "pending_tool_call":
            set((state) => ({
              phase: "confirm",
              message: res.message,
              pending: { tool: res.tool, parameters: res.parameters },
              // Remember the request now; confirm() supplies the outcome.
              session: {
                ...state.session,
                prompt: text,
                kind: previous ? "clarification" : "deterministic",
              },
            }));
            await say(res.message);
            return;
          case "text":
            // With no model loaded this can only be the parser's own question.
            set({ phase: "clarify", message: res.content, clarifying: text });
            await say(res.content);
            return;
          case "error":
            // "No model loaded" here means the fast path declined the
            // utterance, not that something broke. The assistant is a
            // catch-all, so unless the user turned it off, ask the model.
            if (await settingEnabled("assist_auto_model")) {
              await runModel(text);
            } else {
              set({ phase: "fallback", message: text });
            }
            return;
        }
      } catch (err) {
        set({
          phase: "done",
          failed: true,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    confirm: async (approved: boolean) => {
      const pending = get().pending;
      if (!pending) return;
      set({ pending: null, phase: "working" });
      if (!approved) {
        set({ phase: "done", message: "Cancelled.", failed: false });
        get().dismiss();
        return;
      }
      let result: ToolCallResult;
      try {
        result = await executeToolCall(pending.tool, pending.parameters, language());
      } catch (err) {
        result = {
          success: false,
          message: "Action failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const failed = !result.success;
      set({ phase: "done", message: result.message, failed });
      if (!failed) {
        const session = get().session;
        await completeSession(
          session.kind ?? "deterministic",
          session.prompt ?? get().transcript,
          result.message,
        );
      }
      if (failed) await say(result.message);
      else await finishAndDismiss(result.message);
    },

    // Re-opens the system recognizer for another turn. It comes back through
    // the same assistant bridge, so a follow-up is handled exactly like the
    // first — including staying off the model while the parser can still cope.
    listenAgain: async () => {
      stopSpeaking();
      cancelAutoFinish();
      set({ phase: "listening" });
      await startAssistCapture();
    },

    // Manual fallback, for when the automatic one is switched off.
    askModel: async () => {
      cancelAutoFinish();
      await runModel(get().message);
    },

    // The user is taking over. This turn gets written down if it hasn't been,
    // and the id that comes back is the conversation to open — THIS
    // interaction, never whatever chat happened to be active beforehand.
    openChat: async () => {
      cancelAutoFinish();
      stopSpeaking();
      const chatId = await persistSession();
      set({ active: false, phase: "idle" });
      return chatId;
    },

    /** Done — leave and hand the screen back to whatever came before. */
    close: () => leave(),

    dismiss: () => {
      cancelAutoFinish();
      stopSpeaking();
      set({
        active: false,
        phase: "idle",
        transcript: "",
        message: "",
        failed: false,
        pending: null,
        clarifying: null,
        // The session goes with it. A model answer that was written down stays
        // in history; a deterministic turn was never written and now never
        // will be, which is the point.
        session: { ...emptySession },
      });
    },
  };
});
