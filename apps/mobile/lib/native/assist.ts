// The system-assistant bridge.
//
// Vesta is a ROLE_ASSISTANT candidate because it handles ACTION_ASSIST (see
// VestaVoiceActivity + plugins/with-system-actions.js). When the assistant
// gesture fires, the native side runs the system recognizer and leaves the
// transcript in an in-process holder; this module is how JS picks it up.
//
// The transcript never travels through an Intent extra or the `vesta://` deep
// link: those are reachable from outside the app, and an assistant turn is
// ACTED ON rather than pre-filled. `consumeAssistRequest` clears as it reads,
// so one invocation runs one action.

import { NativeModules, NativeEventEmitter, Platform } from "react-native";

const { SystemActionsModule } = NativeModules;

function available(): boolean {
  return (
    Platform.OS === "android" &&
    !!SystemActionsModule &&
    typeof SystemActionsModule.consumeAssistRequest === "function"
  );
}

/** The pending assistant transcript, or null. Reading it clears it. */
export async function consumeAssistRequest(): Promise<string | null> {
  if (!available()) return null;
  try {
    return (await SystemActionsModule.consumeAssistRequest()) ?? null;
  } catch {
    return null;
  }
}

/** Fires when the assistant hands over a transcript while the app is running. */
export function onAssistRequest(handler: () => void): () => void {
  if (!available()) return () => {};
  const emitter = new NativeEventEmitter(SystemActionsModule);
  const sub = emitter.addListener("vestaAssist", handler);
  return () => sub.remove();
}

/** Re-opens the recognizer for a follow-up turn, routed back through assist. */
export async function startAssistCapture(): Promise<void> {
  if (!available() || typeof SystemActionsModule.startAssistCapture !== "function") {
    return;
  }
  await SystemActionsModule.startAssistCapture();
}

export async function isDefaultAssistant(): Promise<boolean> {
  if (!available() || typeof SystemActionsModule.isDefaultAssistant !== "function") {
    return false;
  }
  try {
    return await SystemActionsModule.isDefaultAssistant();
  } catch {
    return false;
  }
}

export type AssistantRoleOutcome = "held" | "requested" | "settings" | "unavailable";

/**
 * Opens the system UI for picking the digital assistant. Never sets it —
 * the choice is the user's, made in a system screen.
 */
export async function requestAssistantRole(): Promise<AssistantRoleOutcome> {
  if (!available() || typeof SystemActionsModule.requestAssistantRole !== "function") {
    return "unavailable";
  }
  return (await SystemActionsModule.requestAssistantRole()) as AssistantRoleOutcome;
}
