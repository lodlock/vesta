// The assistant surface: what the system assistant gesture actually shows.
//
// Deliberately not the chat screen. One turn, one outcome, and a way out —
// the gesture exists to set a timer in three seconds, not to start a
// conversation. Mounting this instead of the Stack is also what keeps the chat
// screen (and with it the model) out of the assistant path entirely.
//
// ── Layout contract ─────────────────────────────────────────────────────────
//
// The card is bounded by the viewport and NEVER grows with the response. A
// model answer is arbitrary text the user did not choose the length of, so it
// lives in a scrollable region between a fixed header and a fixed footer. Done
// and Open chat are laid out as siblings of that region, not after it, so no
// answer — however long, at any font scale — can push them off the bottom of
// the screen and trap the user on a surface whose whole purpose is to get out
// of the way.

import { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  BackHandler,
  Platform,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAssistStore } from "../lib/store/assist-store";
import { Markdown } from "./Markdown";
import { colors, spacing, radii, typography } from "../lib/theme";

export function AssistOverlay({
  onOpenChat,
}: {
  // Receives the conversation THIS turn was written to, so the app opens the
  // interaction the user was just having rather than the last chat they had.
  // Null when there was nothing worth writing.
  onOpenChat: (chatId: string | null) => void;
}) {
  const phase = useAssistStore((s) => s.phase);
  const transcript = useAssistStore((s) => s.transcript);
  const message = useAssistStore((s) => s.message);
  const failed = useAssistStore((s) => s.failed);
  const confirm = useAssistStore((s) => s.confirm);
  const listenAgain = useAssistStore((s) => s.listenAgain);
  const askModel = useAssistStore((s) => s.askModel);
  const closeAssist = useAssistStore((s) => s.close);
  const backAssist = useAssistStore((s) => s.back);
  const takeOver = useAssistStore((s) => s.openChat);
  const keepAlive = useAssistStore((s) => s.keepAlive);
  const insets = useSafeAreaInsets();
  // Two lines is the right default — the prompt is context, not the content —
  // but a long dictation has to be checkable, because the only way to know the
  // recognizer heard "eight" and not "late" is to read it back. Expanding moves
  // the full text INTO the scroll region rather than growing the fixed header,
  // so a paragraph of speech still cannot push the controls off screen.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  useEffect(() => setTranscriptOpen(false), [transcript]);

  // Back ends the interaction rather than navigating inside Vesta. The user
  // came here from another app; backing out of an assistant card should take
  // them there, and must not leave a session behind that reappears on the next
  // ordinary launch. `back()` cancels the auto-finish, stops speech, clears the
  // transient state and finishes the Activity.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      backAssist();
      return true;
    });
    return () => sub.remove();
  }, [backAssist]);

  // Done leaves entirely; Open Chat keeps Vesta up, stops the auto-finish and
  // persists the turn before handing over its conversation id.
  const close = () => closeAssist();
  const openChat = () => {
    takeOver().then(onOpenChat).catch(() => onOpenChat(null));
  };

  const busy = phase === "working" || phase === "listening" || phase === "thinking";

  return (
    <KeyboardAvoidingView
      // On Android the window is resized for the IME (adjustResize), so the
      // flex layout already shrinks; iOS needs the padding behaviour.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        styles.root,
        {
          paddingTop: insets.top + spacing.lg,
          paddingBottom: insets.bottom + spacing.lg,
        },
      ]}
    >
      <View style={styles.card}>
        {/* Fixed. The prompt is clipped rather than allowed to eat the card. */}
        <View style={styles.header}>
          <Text style={styles.brand}>Vesta</Text>
          {transcript.length > 0 && !transcriptOpen && (
            <TouchableOpacity
              onPress={() => setTranscriptOpen(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Show what Vesta heard in full"
            >
              <Text style={styles.transcript} numberOfLines={2}>
                “{transcript}”
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* The only part that grows with the response, and it scrolls. */}
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator
          keyboardShouldPersistTaps="handled"
          // Reading is activity. A long answer is on an inactivity timer
          // rather than a speech-length one, and scrolling restarts it — the
          // surface must not close itself mid-paragraph.
          onScrollBeginDrag={keepAlive}
          scrollEventThrottle={16}
        >
          {transcriptOpen && transcript.length > 0 && (
            <TouchableOpacity
              onPress={() => setTranscriptOpen(false)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Collapse what Vesta heard"
            >
              <Text style={styles.transcriptFull}>“{transcript}”</Text>
            </TouchableOpacity>
          )}

          {busy && (
            <View style={styles.busyRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.busyText}>
                {phase === "listening"
                  ? "Listening…"
                  : phase === "thinking"
                    ? "Asking the model…"
                    : "Working…"}
              </Text>
            </View>
          )}

          {/* The model's own words: rendered with the same safe, pure-RN
              renderer the chat bubbles use, because the model writes Markdown
              and showing it raw ("**like this**") is showing our plumbing. The
              canonical text is what gets persisted and spoken — this is a
              presentation of it, never a replacement for it. */}
          {phase === "answer" && (
            <Markdown
              content={message}
              color={failed ? colors.error : colors.textPrimary}
            />
          )}

          {/* Deterministic confirmations, questions and errors are short,
              literal strings we wrote. They stay plain: a timer labelled
              "2 * 3" is not emphasis. */}
          {(phase === "done" || phase === "clarify" || phase === "confirm") && (
            <Text style={[styles.message, failed && styles.failed]}>{message}</Text>
          )}

          {phase === "fallback" && (
            <Text style={styles.message}>
              That isn’t a timer, alarm, reminder or event. Automatic fallback is
              off, so the model is only loaded if you ask.
            </Text>
          )}
        </ScrollView>

        {/* Fixed. Everything the user can do stays on screen at every length. */}
        <View style={styles.controls}>
          {phase === "clarify" && (
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={listenAgain}
              activeOpacity={0.8}
            >
              <Text style={styles.btnPrimaryText}>Answer</Text>
            </TouchableOpacity>
          )}

          {phase === "confirm" && (
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, styles.grow]}
                onPress={() => confirm(true)}
                activeOpacity={0.8}
              >
                <Text style={styles.btnPrimaryText}>Confirm</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnOutline, styles.grow]}
                onPress={() => confirm(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.btnOutlineText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {phase === "fallback" && (
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={askModel}
              activeOpacity={0.8}
            >
              <Text style={styles.btnPrimaryText}>Ask the model</Text>
            </TouchableOpacity>
          )}

          <View style={styles.footer}>
            <TouchableOpacity onPress={close} activeOpacity={0.7}>
              <Text style={styles.link}>Done</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openChat} activeOpacity={0.7}>
              <Text style={styles.link}>Open chat</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    // The card may be smaller than the viewport, never larger: it shrinks to
    // fit and hands the overflow to the scroll region below.
    flexShrink: 1,
  },
  header: { flexShrink: 0 },
  brand: { ...typography.sectionTitle, color: colors.accent, marginBottom: spacing.sm },
  transcript: {
    ...typography.body,
    color: colors.textSecondary,
    fontStyle: "italic",
    marginBottom: spacing.md,
  },
  transcriptFull: {
    ...typography.body,
    color: colors.textSecondary,
    fontStyle: "italic",
    marginBottom: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  // flexGrow 0 so a one-line answer keeps the card compact; flexShrink 1 so a
  // long one is bounded by whatever space the header and controls leave.
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingBottom: spacing.sm },
  busyRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  busyText: { ...typography.body, color: colors.textMuted },
  message: { ...typography.body, color: colors.textPrimary },
  failed: { color: colors.error },
  controls: { flexShrink: 0 },
  row: { flexDirection: "row", gap: spacing.md },
  grow: { flex: 1 },
  btn: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { ...typography.button, color: colors.userText },
  btnOutline: { borderWidth: 1, borderColor: colors.border },
  btnOutlineText: { ...typography.button, color: colors.textPrimary },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  link: { ...typography.body, color: colors.accent, fontWeight: "600" },
});
