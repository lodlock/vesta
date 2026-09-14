// The assistant surface: what the system assistant gesture actually shows.
//
// Deliberately not the chat screen. One turn, one outcome, and a way out —
// the gesture exists to set a timer in three seconds, not to start a
// conversation. Mounting this instead of the Stack is also what keeps the chat
// screen (and with it the model) out of the assistant path entirely.

import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useAssistStore } from "../lib/store/assist-store";
import { colors, spacing, radii, typography } from "../lib/theme";

export function AssistOverlay({ onOpenChat }: { onOpenChat: () => void }) {
  const phase = useAssistStore((s) => s.phase);
  const transcript = useAssistStore((s) => s.transcript);
  const message = useAssistStore((s) => s.message);
  const failed = useAssistStore((s) => s.failed);
  const confirm = useAssistStore((s) => s.confirm);
  const listenAgain = useAssistStore((s) => s.listenAgain);
  const askModel = useAssistStore((s) => s.askModel);
  const dismiss = useAssistStore((s) => s.dismiss);

  const close = () => dismiss();
  const openChat = () => {
    dismiss();
    onOpenChat();
  };

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.brand}>Vesta</Text>

        {transcript.length > 0 && (
          <Text style={styles.transcript}>“{transcript}”</Text>
        )}

        {(phase === "working" || phase === "listening") && (
          <View style={styles.busyRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.busyText}>
              {phase === "listening" ? "Listening…" : "Working…"}
            </Text>
          </View>
        )}

        {phase === "done" && (
          <Text style={[styles.message, failed && styles.failed]}>{message}</Text>
        )}

        {phase === "answer" && <Text style={styles.message}>{message}</Text>}

        {phase === "clarify" && (
          <>
            <Text style={styles.message}>{message}</Text>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={listenAgain}
              activeOpacity={0.8}
            >
              <Text style={styles.btnPrimaryText}>Answer</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === "confirm" && (
          <>
            <Text style={styles.message}>{message}</Text>
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
          </>
        )}

        {phase === "fallback" && (
          <>
            <Text style={styles.message}>
              That isn’t a timer, alarm, reminder or event. Vesta can ask the
              model instead — that loads it into memory first.
            </Text>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={askModel}
              activeOpacity={0.8}
            >
              <Text style={styles.btnPrimaryText}>Ask the model</Text>
            </TouchableOpacity>
          </>
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
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  brand: { ...typography.sectionTitle, color: colors.accent, marginBottom: spacing.sm },
  transcript: {
    ...typography.body,
    color: colors.textSecondary,
    fontStyle: "italic",
    marginBottom: spacing.md,
  },
  busyRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  busyText: { ...typography.body, color: colors.textMuted },
  message: { ...typography.body, color: colors.textPrimary, marginBottom: spacing.md },
  failed: { color: colors.error },
  row: { flexDirection: "row", gap: spacing.md },
  grow: { flex: 1 },
  btn: { borderRadius: radii.md, paddingVertical: spacing.md, alignItems: "center" },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { ...typography.button, color: colors.userText },
  btnOutline: { borderWidth: 1, borderColor: colors.border },
  btnOutlineText: { ...typography.button, color: colors.textPrimary },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.lg,
  },
  link: { ...typography.body, color: colors.accent, fontWeight: "600" },
});
