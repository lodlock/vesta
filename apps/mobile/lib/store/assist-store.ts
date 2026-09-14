// One turn of "system assistant button → spoken command → Android action".
//
// The whole point of this path is what it does NOT do: no chat screen, no
// conversation, and no GGUF. A spoken "set a 30 second timer" is resolved by
// the deterministic scheduling parser and dispatched to the same Android intent
// the chat would use, with the model never loaded. Weights are only loaded if
// the user explicitly asks for the fallback, because by then the request has
// turned out not to be a scheduling command at all.
//
// processMessage is reused as-is, not reimplemented: its scheduling fast path
// runs before the model-loaded check and before any generation, so calling it
// with no model returns either a resolved action, a clarification question, or
// "No model loaded" — which is exactly the three-way split this screen needs.

import { create } from "zustand";
import { processMessage, executeToolCall } from "../orchestrator/orchestrator";
import type { Language, ToolCallResult } from "../orchestrator/types";
import { startAssistCapture } from "../native/assist";
import { useChatStore } from "./chat-store";

export type AssistPhase =
  | "idle"
  | "listening" // the recognizer is up; we are waiting for a transcript
  | "working" // parsing / dispatching
  | "done" // an action ran
  | "confirm" // a destructive action is proposed and gated
  | "clarify" // the parser asked a question
  | "fallback" // not a scheduling command — the model would be needed
  | "answer"; // the model replied

interface PendingAction {
  tool: string;
  parameters: Record<string, unknown>;
}

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

  handle: (transcript: string) => Promise<void>;
  confirm: (approved: boolean) => Promise<void>;
  listenAgain: () => Promise<void>;
  askModel: () => Promise<void>;
  dismiss: () => void;
}

function language(): Language {
  return useChatStore.getState().language;
}

export const useAssistStore = create<AssistState>((set, get) => ({
  active: false,
  phase: "idle",
  transcript: "",
  message: "",
  failed: false,
  pending: null,
  clarifying: null,

  handle: async (transcript: string) => {
    const previous = get().clarifying;
    // A follow-up completes the earlier utterance rather than replacing it.
    const text = previous ? `${previous} ${transcript}` : transcript;

    set({
      active: true,
      phase: "working",
      transcript,
      message: "",
      failed: false,
      pending: null,
      clarifying: null,
    });

    try {
      const res = await processMessage(text, [], language());
      switch (res.type) {
        case "tool_call":
          set({
            phase: "done",
            message: res.message,
            failed: !res.result.success,
          });
          return;
        case "pending_tool_call":
          set({
            phase: "confirm",
            message: res.message,
            pending: { tool: res.tool, parameters: res.parameters },
          });
          return;
        case "text":
          // With no model loaded this can only be the parser's own question.
          set({ phase: "clarify", message: res.content, clarifying: text });
          return;
        case "error":
          // "No model loaded" here means the fast path declined the utterance,
          // not that something broke.
          set({ phase: "fallback", message: text });
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
    set({ phase: "done", message: result.message, failed: !result.success });
  },

  // Re-opens the system recognizer for another turn. It comes back through the
  // same assistant bridge, so a follow-up is handled exactly like the first.
  listenAgain: async () => {
    set({ phase: "listening" });
    await startAssistCapture();
  },

  // The only path that loads the model, and only when the user taps it: by
  // here the parser has already declined the utterance.
  askModel: async () => {
    const text = get().message; // the original transcript, kept by "fallback"
    set({ phase: "working" });
    try {
      await useChatStore.getState().ensureModelLoaded();
      const res = await processMessage(text, [], language());
      if (res.type === "text") {
        set({ phase: "answer", message: res.content });
      } else if (res.type === "error") {
        set({ phase: "answer", message: res.error, failed: true });
      } else if (res.type === "pending_tool_call") {
        set({
          phase: "confirm",
          message: res.message,
          pending: { tool: res.tool, parameters: res.parameters },
        });
      } else {
        set({ phase: "done", message: res.message, failed: !res.result.success });
      }
    } catch (err) {
      set({
        phase: "answer",
        failed: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  dismiss: () => {
    set({
      active: false,
      phase: "idle",
      transcript: "",
      message: "",
      failed: false,
      pending: null,
      clarifying: null,
    });
  },
}));
