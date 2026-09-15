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
//
// ── Session identity ────────────────────────────────────────────────────────
//
// Everything below is scoped to a `sessionId`: a number that identifies ONE
// assistant invocation, taken from the native bridge's invocation counter when
// there is one. `sessionId === 0` means no assistant session is live at all.
//
// This exists because the store outlives the screen. Zustand state is module
// state, the React root is recreated per Activity, and Android does not
// reliably kill the process when a task is swiped away — so a turn that was
// merely abandoned used to survive into the next launch and put its overlay
// back up. Worse, its still-pending async continuations (a TTS call queued
// behind an await, a scheduled auto-finish) could land inside a LATER turn and
// speak the previous answer over the new one.
//
// The rule, applied at every await boundary: a continuation may only touch the
// store, speak, persist or dismiss while its own session is still the live one.
// A session ends — exactly once, and for good, since ids only ever increase —
// on Done, Back, timeout, Open Chat, backgrounding, or a superseding
// invocation. Ending it is transient cleanup only: a model answer that was
// already written to the database stays there.

import { create } from "zustand";
import {
  processMessage,
  processDeterministic,
  executeToolCall,
} from "../orchestrator/orchestrator";
import type { Language, ToolCallResult } from "../orchestrator/types";
import { startAssistCapture, finishAssistantActivity } from "../native/assist";
import { speak, stopSpeaking } from "../native/speech";
import { visibleAnswer, spokenAnswer } from "../assist/response-text";
import { isAbandoned } from "../scheduling/cancellation";
import { parserGrounding, type Grounding } from "../scheduling/grounding";
import { recordAssistTurn } from "../assist/assist-trace";
import { isLoaded, getLastCompletion, stopGeneration } from "../llm/llm-engine";
import { getLastWarmMs } from "../orchestrator/session-warmer";
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
  // Where the proposed values came from. Confirming a proposal approves the
  // ACTION, not the provenance of its numbers: a model that invented a time
  // must not have that laundered into "the user said so" by a tap. Carried
  // through to the dispatch guard unchanged.
  grounding: Grounding;
}

// How long to wait after the confirmation has been spoken before the overlay
// gets out of the way. Short enough to feel automatic, long enough not to clip
// the tail of the utterance on engines that report "done" eagerly.
const DISMISS_GRACE_MS = 400;
// A last-resort ceiling on waiting for speech, in case an engine neither
// speaks nor reports. The native speaker now runs its own two-stage watchdog
// (see VestaSpeaker: a short one for "never started", then a length-derived one
// for an utterance in progress), so this only has to be longer than anything
// the engine could legitimately take — it is a backstop, not the policy. The
// old flat 8s here WAS the policy, and it cut long answers off mid-sentence.
const SPEECH_CEILING_BASE_MS = 20_000;
const SPEECH_CEILING_PER_CHAR_MS = 120;
// A short model answer behaves like a confirmation: read it, then get out of
// the way. Long enough to act, short enough that a spoken answer doesn't leave
// Vesta sitting in front of whatever the user was doing.
const ANSWER_LINGER_MS = 6000;
// An answer longer than this needs scrolling, so it cannot be read in the
// linger window — dismissing on a timer would take it away mid-paragraph. ~3
// short paragraphs; comfortably more than any confirmation, comfortably less
// than the D&D-history answers that prompted this.
const LONG_ANSWER_CHARS = 420;
// What a long answer gets instead: an INACTIVITY timer, restarted whenever the
// user scrolls the answer (see AssistOverlay). Long enough to read a page,
// short enough that a forgotten card doesn't camp on top of another app.
const LONG_ANSWER_IDLE_MS = 120_000;

/** True when an answer needs scrolling to read, so it must not auto-dismiss. */
export function isLongAnswer(text: string): boolean {
  return text.trim().length > LONG_ANSWER_CHARS;
}

/** How long an answer of this length may stay up unattended. */
export function lingerFor(text: string): number {
  return isLongAnswer(text) ? LONG_ANSWER_IDLE_MS : ANSWER_LINGER_MS;
}

/**
 * The longest we will wait for an utterance of this length to finish.
 *
 * Derived from the text, not a constant: the point is that a legitimate long
 * utterance is never cut off, while a dead engine still can't hold the surface
 * open forever.
 */
function speechCeilingFor(text: string): number {
  return SPEECH_CEILING_BASE_MS + text.length * SPEECH_CEILING_PER_CHAR_MS;
}

// The phases in which the assistant is waiting on something outside itself and
// legitimately loses the foreground: the system recognizer is a separate
// Activity, and a model load can take long enough that a glance elsewhere
// shouldn't throw the turn away. Every other phase is a settled turn, and a
// settled turn does not survive the app being backgrounded.
const BUSY_PHASES: ReadonlySet<AssistPhase> = new Set<AssistPhase>([
  "listening",
  "working",
  "thinking",
]);

// Session ids only ever increase, for the lifetime of the JS context. They are
// never reset by dismissal — reuse is exactly the bug this guards against,
// since a stale continuation holding id N would match a new session N.
let lastSessionId = 0;

function nextSessionId(invocationId?: number): number {
  lastSessionId = Math.max(lastSessionId + 1, invocationId ?? 0);
  return lastSessionId;
}

interface AssistState {
  active: boolean;
  /**
   * The live assistant invocation, or 0 when none is. Nothing may be shown,
   * spoken or written on behalf of a session that is no longer this one.
   */
  sessionId: number;
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
  /**
   * True between "the user pressed Back/Done" and the Activity actually going
   * away.
   *
   * Without it, clearing `active` swaps the overlay for the whole chat
   * navigator — mounting a screen nobody asked for, on a device whose cores
   * are still busy, in the moments before the Activity finishes. That mount is
   * what the user sees as a stutter, and if the finish is slow it is also a
   * flash of the wrong app. While this is set the root renders nothing but the
   * background.
   */
  leaving: boolean;

  handle: (transcript: string, invocationId?: number) => Promise<void>;
  /**
   * Restart the pending auto-finish. Called when the user scrolls a long
   * answer: reading is activity, and a timer that fires mid-paragraph is the
   * same bug as having no scroll region at all.
   */
  keepAlive: () => void;
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
  /** Back: end the interaction and hand the screen back. */
  back: () => void;
  /**
   * End the live session and clear the transient surface, WITHOUT leaving the
   * screen. The launch-origin gate and the backgrounding guard use this; Done
   * and Back go through `close`/`back`, which also finish the Activity.
   *
   * Transient state only. An already-persisted conversation is not touched.
   */
  endSession: () => void;
  /** Alias of {@link endSession}, kept for the call sites that read better. */
  dismiss: () => void;
  /**
   * End the session unless the turn is still waiting on something. Called when
   * the app leaves the foreground and when it returns, so an abandoned surface
   * cannot come back with the app.
   */
  endIfSettled: () => void;
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

  // Whether `id` is still the live session. Every continuation that resumes
  // after an await asks this before it does anything observable.
  const isCurrent = (id: number): boolean => id !== 0 && get().sessionId === id;

  // Tells llama.cpp to stop decoding, if this turn had it running.
  //
  // The session guard already stops an abandoned answer from being SHOWN, but
  // it does nothing about the work: the weights keep decoding to their token
  // limit on every core, and the UI thread it starves belongs to the user who
  // just pressed Back. Signalled, never awaited — waiting on the thing being
  // cancelled is the behaviour this removes.
  const abandonGeneration = () => {
    if (get().phase !== "thinking") return;
    stopGeneration().catch(() => {});
  };

  // Fallback for a finish that never lands (no foreground Activity to close).
  // Without it, `leaving` would hold a blank screen forever.
  let leavingFallback: ReturnType<typeof setTimeout> | null = null;
  const LEAVING_FALLBACK_MS = 1500;

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
  //
  // Order matters, and it is invalidate-first. The user pressing Back while a
  // model is generating must see the surface go NOW — not after 320 tokens
  // finish decoding. So the two synchronous, instant things happen first (the
  // session id is zeroed, which invalidates every continuation in flight, and
  // the Activity is told to finish), and everything that talks to a native
  // subsystem happens after. Nothing here awaits anything.
  const leave = () => {
    // Both writes are synchronous and land in one render: the session is
    // invalidated, and the root is told to show nothing until the Activity
    // goes. endSession() runs FIRST because it clears `leaving` — it is also
    // reached by the launch gate and the backgrounding guard, where a stale
    // flag would mean relaunching into a blank screen.
    get().endSession();
    set({ leaving: true });
    finishAssistantActivity();
    if (leavingFallback !== null) clearTimeout(leavingFallback);
    leavingFallback = setTimeout(() => {
      leavingFallback = null;
      // The Activity did not go. Show the app rather than a blank screen.
      set({ leaving: false });
    }, LEAVING_FALLBACK_MS);
  };

  const scheduleLeave = (id: number, afterMs: number) => {
    cancelAutoFinish();
    autoFinish = setTimeout(() => {
      autoFinish = null;
      set({ autoFinishPending: false });
      // Only if the turn is still where it was left — a new invocation, an
      // opened chat or a dismissal has taken over otherwise.
      if (!isCurrent(id)) return;
      const phase = get().phase;
      if (phase === "answer" || phase === "done") leave();
    }, afterMs);
    set({ autoFinishPending: true });
  };

  // One in-flight write at a time, shared by the automatic path and the Open
  // Chat tap. Without this a model answer that persists itself while the user
  // reaches for Open Chat would produce two conversations for one turn.
  //
  // It carries its OWNER. Deduplicating by "is a write running?" alone is only
  // correct within one invocation: a write still in flight from invocation N
  // was handed straight back to invocation N+1's Open Chat, which then opened
  // N's conversation and left N+1 unwritten. The promise is only ever reused by
  // the session that started it.
  let persistInFlight: { sessionId: number; promise: Promise<string | null> } | null =
    null;

  const persistSession = async (): Promise<string | null> => {
    // Captured now: the write must complete against the turn that asked for
    // it even if the surface is torn down while it is in flight. Clearing the
    // transient session never unwrites a conversation.
    const id = get().sessionId;
    const session = get().session;

    // A session record only speaks for the invocation that created it. If this
    // one belongs to an earlier turn, there is nothing of THIS turn to write.
    if (session.sessionId !== id) return null;

    if (session.persistedChatId) return session.persistedChatId;
    if (persistInFlight && persistInFlight.sessionId === id) {
      return persistInFlight.promise;
    }

    const promise = persistAssistSession(session)
      .then((chatId) => {
        // The id is only written back into a session that is still the same
        // one; a later turn must not inherit this turn's conversation.
        if (chatId && isCurrent(id) && get().session.sessionId === id) {
          set((state) => ({ session: { ...state.session, persistedChatId: chatId } }));
        }
        return chatId;
      })
      .catch((err) => {
        console.warn("[assist] could not persist the session:", err);
        return null;
      })
      .finally(() => {
        // Only retire our own entry: a later session may already have started
        // its own write while this one was settling.
        if (persistInFlight?.sessionId === id) persistInFlight = null;
      });
    persistInFlight = { sessionId: id, promise };
    return promise;
  };

  // Records the outcome of a turn, and writes it now if the policy says so.
  // Called at every point a turn reaches its final response.
  const completeSession = async (
    id: number,
    kind: AssistInteractionKind,
    prompt: string,
    response: string,
  ) => {
    if (!isCurrent(id)) return;
    set((state) => ({
      // Spread only a record that already belongs to this invocation.
      // Inheriting an earlier turn's record here is how a completed answer
      // ended up carrying the PREVIOUS turn's persistedChatId, which then came
      // back out of Open Chat as the wrong conversation.
      session:
        state.session.sessionId === id
          ? { ...state.session, kind, prompt, response, complete: true }
          : { ...emptySession, sessionId: id, kind, prompt, response, complete: true },
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
  //
  // Owned by a session. The check is repeated after the settings read because
  // that read is a round trip to SQLite: a superseding invocation can call
  // stopSpeaking() while it is in flight, and speaking afterwards is precisely
  // how the previous answer used to be heard over the new one.
  const say = async (id: number, text: string): Promise<void> => {
    if (!text.trim()) return;
    if (!isCurrent(id)) return;
    if (!(await settingEnabled("assist_speak"))) return;
    if (!isCurrent(id)) return;
    const spoken = spokenAnswer(text);
    await Promise.race([
      speak(spoken, language()),
      new Promise((resolve) => setTimeout(resolve, speechCeilingFor(spoken))),
    ]);
  };

  // A completed device action: say it, then get out of the way. The overlay is
  // a means to an end — once the timer is set there is nothing to look at, and
  // the user should be back where they were.
  const finishAndDismiss = async (id: number, message: string) => {
    await say(id, message);
    await new Promise((resolve) => setTimeout(resolve, DISMISS_GRACE_MS));
    // Unless something arrived in the meantime (a new invocation, or the user
    // opened chat), in which case that turn owns the screen now.
    if (isCurrent(id) && get().phase === "done" && !get().failed) leave();
  };

  // Hand the utterance to the model. Loads it if needed — this is the only
  // path that does, and it is only reached once the parser has declined.
  const runModel = async (id: number, text: string) => {
    if (!isCurrent(id)) return;
    set({ phase: "thinking", message: "" });
    // Measured, not assumed. "Every question reloads the model" can mean the
    // process was killed, or that a resident model had to re-evaluate its
    // prompt prefix; the numbers say which, and they are wanted before any
    // retention policy is bolted on. See lib/assist/assist-trace.
    const startedAt = Date.now();
    const loadedAtStart = isLoaded();
    try {
      await useChatStore.getState().ensureModelLoaded();
      const loadMs = Date.now() - startedAt;
      const generateStartedAt = Date.now();
      const res = await processMessage(text, [], language(), undefined, undefined, undefined, {
        assistMode: true,
      });
      const completion = getLastCompletion();
      recordAssistTurn({
        sessionId: id,
        loadedAtStart,
        loadMs,
        restoreMs: loadedAtStart ? 0 : Math.max(0, getLastWarmMs()),
        generateMs: Date.now() - generateStartedAt,
        promptTokens: completion?.promptTokens ?? null,
        cachedTokens: completion?.cachedTokens ?? null,
        totalMs: Date.now() - startedAt,
        at: Date.now(),
      });
      // A model load plus a generation is the longest wait in the app. The
      // user may well have given up and gone somewhere else by now; if they
      // have, this answer belongs to nothing and is dropped rather than shown.
      if (!isCurrent(id)) return;
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
        await completeSession(id, "model", text, answer);
        await say(id, answer);
        if (!isCurrent(id)) return;
        // Spoken and on screen. A short answer has been read by now, so the
        // assistant gets out of the way on the user's behalf. A long one has
        // NOT — it needs scrolling, and taking it away on a speech-length timer
        // is how a page of text vanished mid-paragraph. That one gets a long
        // inactivity window instead, restarted every time the user scrolls.
        scheduleLeave(id, lingerFor(answer));
      } else if (res.type === "error") {
        set({ phase: "answer", failed: true, message: res.error });
      } else if (res.type === "pending_tool_call") {
        set({
          phase: "confirm",
          message: res.message,
          pending: {
            tool: res.tool,
            parameters: res.parameters,
            grounding: { source: "model", utterance: text, lang: language() },
          },
        });
        await say(id, res.message);
      } else {
        const failed = !res.result.success;
        set({ phase: "done", failed, message: res.message });
        if (!failed) await completeSession(id, "model", text, res.message);
        if (failed) await say(id, res.message);
        else await finishAndDismiss(id, res.message);
      }
    } catch (err) {
      if (!isCurrent(id)) return;
      set({
        phase: "answer",
        failed: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    active: false,
    leaving: false,
    sessionId: 0,
    phase: "idle",
    transcript: "",
    message: "",
    failed: false,
    pending: null,
    clarifying: null,
    session: { ...emptySession },
    autoFinishPending: false,

    handle: async (transcript: string, invocationId?: number) => {
      // A new invocation silences the previous answer rather than talking over
      // it, and takes ownership of the screen from any pending auto-finish.
      // The id bump is what makes that stick: every continuation still in
      // flight for the previous session now fails its own liveness check, so
      // none of them can speak, persist, dismiss or write to the screen.
      stopSpeaking();
      cancelAutoFinish();
      // A superseding invocation owns the screen now. The previous turn's
      // generation is nobody's answer any more, and leaving it running would
      // make THIS turn queue behind it on the engine lock.
      abandonGeneration();
      if (leavingFallback !== null) {
        clearTimeout(leavingFallback);
        leavingFallback = null;
      }

      const previous = get().clarifying;
      // A follow-up completes the earlier utterance rather than replacing it.
      const text = previous ? `${previous} ${transcript}` : transcript;
      const id = nextSessionId(invocationId);
      // Dictation has no backspace, so a request is taken back by talking:
      // "…actually, cancel". Checked on the RAW transcript before anything is
      // combined, parsed or routed — a withdrawn request must reach neither
      // the parser nor the model, and a follow-up that retracts must not be
      // glued onto the utterance it is retracting.
      const abandoned = isAbandoned(transcript, language());

      set((state) => ({
        active: true,
        leaving: false,
        sessionId: id,
        phase: "working",
        transcript,
        message: "",
        failed: false,
        pending: null,
        clarifying: null,
        // A follow-up continues the same interaction for persistence purposes
        // (one thing the user is doing, one conversation if it is written);
        // a fresh invocation starts a new one. Either way the record is
        // re-stamped with THIS invocation's id, so every later check of
        // "does this record speak for the live turn?" has an answer.
        session: previous
          ? { ...state.session, sessionId: id }
          : { ...emptySession, sessionId: id },
      }));

      if (abandoned) {
        // Nothing parses, nothing dispatches, no model loads. Say so briefly
        // and get out of the way like any other completed turn — with no
        // session record, so it is never written to the chat history either.
        const acknowledgement =
          language() === "it" ? "Va bene, lascio stare." : "Okay, cancelled.";
        set({ phase: "done", failed: false, message: acknowledgement });
        await finishAndDismiss(id, acknowledgement);
        return;
      }

      try {
        // Deterministic layers ONLY. Never processMessage: that runs a full
        // chat generation the moment a model happens to be resident. Null
        // means none of them handled it.
        const result = await processDeterministic(text, language());
        if (!isCurrent(id)) return;
        if (!result) {
          // Not a scheduling command. The assistant is a catch-all, so unless
          // the user turned it off, ask the model.
          if (await settingEnabled("assist_auto_model")) {
            await runModel(id, text);
          } else if (isCurrent(id)) {
            set({ phase: "fallback", message: text });
          }
          return;
        }
        const res = result.response;
        switch (res.type) {
          case "tool_call": {
            const failed = !res.result.success;
            set({ phase: "done", message: res.message, failed });
            if (!failed) {
              // Recorded, not written: the timer IS the outcome, and a
              // conversation only appears if the user asks for one.
              await completeSession(
                id,
                previous ? "clarification" : "deterministic",
                text,
                res.message,
              );
            }
            // A failure stays on screen to be read; a success speaks and goes.
            if (failed) await say(id, res.message);
            else await finishAndDismiss(id, res.message);
            return;
          }
          case "pending_tool_call":
            set((state) => ({
              phase: "confirm",
              message: res.message,
              pending: {
                tool: res.tool,
                parameters: res.parameters,
                grounding: parserGrounding(text, language()),
              },
              // Remember the request now; confirm() supplies the outcome.
              session: {
                ...state.session,
                prompt: text,
                kind: previous ? "clarification" : "deterministic",
              },
            }));
            await say(id, res.message);
            return;
          case "text": {
            // Prose from a deterministic layer is one of two completely
            // different things, and `resume` is what says which. Getting this
            // wrong is what filed "It's 14:00 in Norway" as a pending
            // question, glued it onto the next invocation's utterance, and
            // sent the pair to the model.
            if (result.resume === undefined) {
              // A FINISHED answer — a world-clock reading, or an
              // acknowledgement. Behaves like any completed deterministic
              // turn: speak it, then get out of the way. Recorded but not
              // written; a conversation only appears if the user asks for one.
              set({ phase: "done", failed: false, message: res.content });
              await completeSession(
                id,
                previous ? "clarification" : "deterministic",
                text,
                res.content,
              );
              await finishAndDismiss(id, res.content);
              return;
            }
            // A QUESTION the user still owes an answer to. The surface stays
            // open with an Answer button, and `clarifying` holds the text a
            // follow-up completes — the original utterance for scheduling,
            // or the world-time question minus its ambiguous place, so
            // "Chicago" finishes it without repeating the question.
            set({ phase: "clarify", message: res.content, clarifying: result.resume });
            await say(id, res.content);
            return;
          }
          case "error":
            set({ phase: "done", failed: true, message: res.error });
            await say(id, res.error);
            return;
        }
      } catch (err) {
        if (!isCurrent(id)) return;
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
      const id = get().sessionId;
      set({ pending: null, phase: "working" });
      if (!approved) {
        set({ phase: "done", message: "Cancelled.", failed: false });
        get().dismiss();
        return;
      }
      let result: ToolCallResult;
      try {
        result = await executeToolCall(
          pending.tool,
          pending.parameters,
          language(),
          pending.grounding,
        );
      } catch (err) {
        result = {
          success: false,
          message: "Action failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!isCurrent(id)) return;
      const failed = !result.success;
      set({ phase: "done", message: result.message, failed });
      if (!failed) {
        const session = get().session;
        await completeSession(
          id,
          session.kind ?? "deterministic",
          session.prompt ?? get().transcript,
          result.message,
        );
      }
      if (failed) await say(id, result.message);
      else await finishAndDismiss(id, result.message);
    },

    // Re-opens the system recognizer for another turn. It comes back through
    // the same assistant bridge, so a follow-up is handled exactly like the
    // first — including staying off the model while the parser can still cope.
    listenAgain: async () => {
      stopSpeaking();
      cancelAutoFinish();
      // Set before the recognizer takes the foreground: `listening` is what
      // tells the backgrounding guard that this turn is still going.
      set({ phase: "listening" });
      await startAssistCapture();
    },

    // Manual fallback, for when the automatic one is switched off.
    askModel: async () => {
      cancelAutoFinish();
      await runModel(get().sessionId, get().message);
    },

    // The user is taking over. This turn gets written down if it hasn't been,
    // and the id that comes back is the conversation to open — THIS
    // interaction, never whatever chat happened to be active beforehand.
    openChat: async () => {
      cancelAutoFinish();
      stopSpeaking();
      // The user is taking over. Whatever the assistant was generating is not
      // the answer they are going to read, and the chat screen they are about
      // to see needs the CPU more than an abandoned decode does.
      abandonGeneration();
      const chatId = await persistSession();
      // The surface is done; the conversation is not. Ending the session stops
      // anything still in flight from speaking over the chat screen, and the
      // chat itself is already on disk. The transient record goes too — leaving
      // it behind is what let a later invocation find a previous turn's
      // persistedChatId and hand it back out of Open Chat.
      persistInFlight = null;
      set({
        active: false,
        // NOT `leaving`: Open Chat stays in Vesta, and the app is exactly what
        // should render next.
        leaving: false,
        sessionId: 0,
        phase: "idle",
        clarifying: null,
        session: { ...emptySession },
      });
      return chatId;
    },

    /** Done — leave and hand the screen back to whatever came before. */
    close: () => leave(),

    /**
     * Back — the same thing as Done. Back out of an assistant interaction and
     * the interaction is over: the auto-finish is cancelled, speech stops, the
     * transient state goes, and the Activity finishes so the user lands back in
     * whatever they came from rather than in Vesta's chat screen.
     */
    back: () => leave(),

    dismiss: () => get().endSession(),

    keepAlive: () => {
      const { sessionId, autoFinishPending, phase, message } = get();
      if (!autoFinishPending || sessionId === 0) return;
      if (phase !== "answer") return;
      scheduleLeave(sessionId, lingerFor(message));
    },

    endSession: () => {
      // ── Invalidate, synchronously, before anything else ────────────────
      //
      // This `set` is the cancellation. Zeroing sessionId makes every
      // continuation still in flight — a generation about to return, a TTS
      // callback, a scheduled auto-finish, a persist about to resolve — fail
      // its own liveness check, so none of them can draw, speak, write or
      // dismiss. It is a plain state write: it cannot block, and the surface
      // unmounts on the next render rather than after some await.
      //
      // Everything below is cleanup. It runs after the user has already got
      // their answer.
      const wasGenerating = get().phase === "thinking";
      set({
        active: false,
        // Not on the way out by default. `leave()` sets this again right
        // after; every other caller (the launch gate, backgrounding) wants the
        // ordinary app, not a blank screen.
        leaving: false,
        // No session is live. Nothing already in flight can match this, and
        // the next invocation gets a strictly higher id, so nothing from this
        // turn can ever speak or draw again.
        sessionId: 0,
        phase: "idle",
        transcript: "",
        message: "",
        failed: false,
        pending: null,
        clarifying: null,
        // The transient record goes with it. A model answer that was written
        // down stays in history — this clears the in-memory session, never the
        // conversation. A deterministic turn was never written and now never
        // will be, which is the point.
        session: { ...emptySession },
      });

      // ── Cleanup ────────────────────────────────────────────────────────
      cancelAutoFinish();
      stopSpeaking();
      // A write started by this session must not be handed to the next one.
      // The write itself still completes — clearing the surface never unwrites
      // a conversation — this only drops our claim on its promise.
      persistInFlight = null;
      // Stop the model. Without this the weights keep decoding to their token
      // limit after the user has left: the guard above already stops the
      // ANSWER from appearing, but llama.cpp saturating every core is what
      // made Back feel like it had done nothing — the UI thread was starved
      // for the seconds it took the abandoned generation to finish. Signals
      // the native decode loop; never awaited, because waiting for the thing
      // being cancelled is the bug.
      if (wasGenerating) stopGeneration().catch(() => {});
    },

    endIfSettled: () => {
      // Whatever else is true, the app changing foreground state means we are
      // no longer mid-leave. A stale flag here would hold the root on a bare
      // background — the blank screen this guards against is worse than the
      // navigator mount it exists to avoid.
      if (get().leaving) set({ leaving: false });
      if (!get().active) return;
      // Still waiting on the recognizer, the parser or the model: the turn is
      // alive even though the screen isn't.
      if (BUSY_PHASES.has(get().phase)) return;
      get().dismiss();
    },
  };
});
