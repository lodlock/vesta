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

/**
 * Finishes Vesta's activity so the user lands back where they were.
 *
 * Called after the assistant has said its piece. It is not a dismissal of the
 * overlay state — the store does that — it is leaving the screen entirely.
 */
export function finishAssistantActivity(): void {
  if (!available() || typeof SystemActionsModule.finishAssistantActivity !== "function") {
    return;
  }
  try {
    SystemActionsModule.finishAssistantActivity();
  } catch {
    // No activity to finish; the user has already moved on.
  }
}

/** When this process started, for the startup breakdown. Null when unknown. */
export async function getProcessStartMillis(): Promise<number | null> {
  if (!available() || typeof SystemActionsModule.getProcessStartMillis !== "function") {
    return null;
  }
  try {
    return (await SystemActionsModule.getProcessStartMillis()) ?? null;
  } catch {
    return null;
  }
}

export type AssistantRoleOutcome =
  | "held" // Vesta already holds the role
  | "requested" // the system role dialog is up
  | "settings" // no role dialog on this build; the settings screen is up
  | "no-activity" // Vesta has no foreground Activity to host the chooser
  | "unavailable"; // no assistant setting reachable at all

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
