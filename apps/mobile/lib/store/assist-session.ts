// What an assistant turn was, and whether it is worth keeping.
//
// The policy this encodes, in one place so it cannot drift between the three
// callers that need it:
//
//   deterministic   "set a 30 second timer" → the timer IS the outcome. There
//                   is nothing to come back to, so nothing is written unless
//                   the user asks for it by opening the chat.
//   model-backed    an answer the user might want later, might want to follow
//                   up on, and paid a model load for. Written IMMEDIATELY on
//                   completion — before TTS finishes and before the
//                   auto-finish window can take the screen away — so a
//                   timeout, a backgrounding or a killed process cannot lose
//                   an answer that already exists.
//   clarification   whichever of the two it ended up being.
//
// Persistence is idempotent by construction: once a session has a chat id it
// keeps it, and every caller goes through the same guard, so an auto-persist
// racing an Open Chat tap produces one conversation rather than two.

import { v4 as uuid } from "uuid";
import {
  createConversation,
  saveMessage,
  touchConversation,
  updateConversationTitle,
} from "../storage/database";
import type { Message } from "../orchestrator/types";

export type AssistInteractionKind = "deterministic" | "clarification" | "model";

export interface AssistSession {
  /**
   * The invocation this record belongs to, or 0 for the empty one.
   *
   * A session record is not just data, it is a CLAIM about which turn produced
   * it — and acting on a claim from an earlier invocation is how Open Chat on
   * the second question opened the first question's conversation. Every reader
   * checks this against the live session before trusting `persistedChatId`.
   */
  sessionId: number;
  /** What the user asked, as the parser finally saw it. */
  prompt: string | null;
  /** The final VISIBLE response — a confirmation, or the model's answer. */
  response: string | null;
  kind: AssistInteractionKind | null;
  /** True once the turn has produced its final response. */
  complete: boolean;
  /** The conversation this turn was written to, if it has been. */
  persistedChatId: string | null;
}

export const emptySession: AssistSession = {
  sessionId: 0,
  prompt: null,
  response: null,
  kind: null,
  complete: false,
  persistedChatId: null,
};

/** A conversation title from the request, matching what the chat screen does. */
export function titleFor(prompt: string): string {
  return prompt.length > 50 ? `${prompt.substring(0, 47)}...` : prompt;
}

/**
 * Whether a completed session should be written without being asked.
 *
 * Only model-backed turns. A deterministic one has already done its job by
 * the time it finishes speaking; writing a conversation for every "set a
 * timer" would bury the chats that mean something under ones that don't.
 */
export function shouldPersistAutomatically(session: AssistSession): boolean {
  return session.complete && session.kind === "model";
}

/**
 * Writes the turn as a two-message conversation and returns its id.
 *
 * Only the visible text is stored — no reasoning, no tool-call JSON, no parser
 * or backend internals. What the user saw is what history holds, which is also
 * what a follow-up turn will replay to the model.
 *
 * Returns null when there is nothing worth writing.
 */
export async function persistAssistSession(
  session: AssistSession,
): Promise<string | null> {
  if (session.persistedChatId) return session.persistedChatId;
  if (!session.prompt || !session.response) return null;

  const conversationId = uuid();
  const now = Date.now();

  const userMessage: Message = {
    id: uuid(),
    conversationId,
    role: "user",
    content: session.prompt,
    createdAt: now,
  };
  const assistantMessage: Message = {
    id: uuid(),
    conversationId,
    role: "assistant",
    // The response as shown and spoken. Deliberately no toolCall/toolResult:
    // the confirmation text already says what happened, and raw tool data is
    // not something the user ever saw.
    content: session.response,
    createdAt: now + 1,
  };

  await createConversation(conversationId);
  await updateConversationTitle(conversationId, titleFor(session.prompt));
  await saveMessage(userMessage);
  await saveMessage(assistantMessage);
  await touchConversation(conversationId);

  return conversationId;
}
