// Android system text-to-speech, for the assistant surface only.
//
// The system engine — no cloud voice, no bundled voice, nothing leaving the
// device. Whatever the user has set as their TTS engine speaks.
//
// `speak` resolves when the utterance ENDS (finished, interrupted or failed),
// which is what lets the assistant wait for its confirmation to be heard before
// dismissing itself instead of guessing a delay. It never rejects on a missing
// engine: speech is an enhancement and the text is on screen regardless.

import { NativeModules, Platform } from "react-native";

const { SystemActionsModule } = NativeModules;

export type SpeechOutcome = "done" | "stopped" | "error" | "unavailable";

function available(): boolean {
  return (
    Platform.OS === "android" &&
    !!SystemActionsModule &&
    typeof SystemActionsModule.speak === "function"
  );
}

export function canSpeak(): boolean {
  return available();
}

export async function speak(text: string, language: string): Promise<SpeechOutcome> {
  if (!available() || !text.trim()) return "unavailable";
  try {
    return (await SystemActionsModule.speak(text, language)) as SpeechOutcome;
  } catch {
    return "error";
  }
}

/** Cuts speech off. Safe to call when nothing is playing. */
export function stopSpeaking(): void {
  if (!available() || typeof SystemActionsModule.stopSpeaking !== "function") return;
  try {
    SystemActionsModule.stopSpeaking();
  } catch {
    // Nothing to stop, or no engine — either way there is nothing to report.
  }
}
