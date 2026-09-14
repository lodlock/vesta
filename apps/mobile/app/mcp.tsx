import { useCallback, useEffect, useState } from "react";
import {
  ScrollView, View, Text, TextInput, TouchableOpacity, Switch, Alert, StyleSheet,
} from "react-native";
import {
  enableMcpServer, disableMcpServer, isMcpEnabled, isMcpLanBindEnabled,
  setMcpLanBind, MCP_PORT, MCP_LOOPBACK,
} from "../lib/mcp/mcp-lifecycle";
import {
  createClient, listClients, revokeClient, type McpClient,
} from "../lib/mcp/pairing-store";
import { colors, spacing, typography, radii } from "../lib/theme";

export default function McpScreen() {
  const [enabled, setEnabled] = useState(false);
  const [lanBind, setLanBind] = useState(false);
  const [ip, setIp] = useState<string | null>(null);
  const [clients, setClients] = useState<McpClient[]>([]);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(() => {
    (async () => {
      try {
        const [on, lan] = await Promise.all([isMcpEnabled(), isMcpLanBindEnabled()]);
        setEnabled(on);
        setLanBind(lan);
        if (on) {
          // Enabled in a previous session/visit: ensure the server is running
          // this session (enableMcpServer is idempotent) and capture the LAN IP
          // so the pairing command shows a real address, not the placeholder.
          const res = await enableMcpServer();
          setIp(res.ip);
        }
      } catch {
        // Leave the toggle in its last-known state; toggle() surfaces errors.
      }
    })();
    listClients().then(setClients).catch(() => setClients([]));
  }, []);
  useEffect(refresh, [refresh]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const res = await enableMcpServer();
        setIp(res.ip);
      } else {
        await disableMcpServer();
        setIp(null);
      }
      setEnabled(on);
    } catch (e) {
      Alert.alert("MCP", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // LAN exposure is a separate, explicit opt-in from the on/off switch: the
  // transport is plaintext and the exposed tools read calendar/contacts/docs,
  // so turning it on is confirmed, never a silent side effect of enabling MCP.
  const applyLanBind = async (on: boolean) => {
    setBusy(true);
    try {
      const res = await setMcpLanBind(on);
      setLanBind(on);
      if (res) setIp(res.ip);
      else if (!on) setIp(MCP_LOOPBACK);
    } catch (e) {
      Alert.alert("MCP", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLan = (on: boolean) => {
    if (!on) {
      applyLanBind(false);
      return;
    }
    Alert.alert(
      "Expose on Wi-Fi?",
      "Vesta will accept MCP requests from any device on this network. The connection is plain HTTP, so the client token travels unencrypted and the exposed tools return your calendar, contacts and document text." +
        "\n\nLeave this off to keep the server on the phone only (127.0.0.1) and connect over adb.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Expose", style: "destructive", onPress: () => applyLanBind(true) },
      ],
    );
  };

  const addClient = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const c = await createClient(name);
      setNewName("");
      setClients(await listClients());
      const host = lanBind ? (ip ?? "<phone-ip>") : MCP_LOOPBACK;
      const url = `http://${host}:${MCP_PORT}/mcp`;
      // Loopback binding is unreachable from the laptop until the port is
      // forwarded, so the pairing text leads with that step.
      const prefix = lanBind
        ? ""
        : `First forward the port to the phone:\n\nadb reverse tcp:${MCP_PORT} tcp:${MCP_PORT}\n\n`;
      Alert.alert(
        c.name,
        `${prefix}Add to your MCP client:\n\nclaude mcp add --transport http vesta ${url} --header "Authorization: Bearer ${c.token}"`,
      );
    } catch (e) {
      Alert.alert("MCP", e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = (c: McpClient) =>
    Alert.alert("Revoke", `Revoke "${c.name}"? Its token stops working immediately.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: async () => {
          try {
            await revokeClient(c.id);
            setClients(await listClients());
          } catch (e) {
            Alert.alert("MCP", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Server</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Enabled</Text>
          <Switch value={enabled} onValueChange={toggle} disabled={busy}
            trackColor={{ false: colors.disabled, true: colors.accent }} />
        </View>
        {enabled && (
          <Text style={styles.hint}>
            {`http://${lanBind ? (ip ?? "…") : MCP_LOOPBACK}:${MCP_PORT}/mcp`}
            {"\n"}
            {lanBind
              ? "Reachable from any device on this Wi-Fi over plain HTTP. Data stays on the phone."
              : `On-device only (loopback). Connect a laptop with: adb reverse tcp:${MCP_PORT} tcp:${MCP_PORT}`}
          </Text>
        )}
        <View style={styles.row}>
          <Text style={styles.label}>Allow access from Wi-Fi</Text>
          <Switch value={lanBind} onValueChange={toggleLan} disabled={busy}
            trackColor={{ false: colors.disabled, true: colors.accent }} />
        </View>
        <Text style={styles.hint}>
          Off = the server binds 127.0.0.1 and nothing on the network can reach it.
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Clients</Text>
      <View style={styles.card}>
        {clients.length === 0 && <Text style={styles.hint}>No clients yet.</Text>}
        {clients.map((c) => (
          <View key={c.id} style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>{c.name}</Text>
            <TouchableOpacity onPress={() => revoke(c)}>
              <Text style={styles.revoke}>Revoke</Text>
            </TouchableOpacity>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={newName}
          onChangeText={setNewName}
          placeholder="Name this client (e.g. MacBook — Claude Code)"
          placeholderTextColor={colors.textPlaceholder}
        />
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={addClient} activeOpacity={0.8} disabled={!newName.trim()}>
          <Text style={styles.btnPrimaryText}>Add client</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionTitle: { ...typography.sectionTitle, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: spacing.sm, gap: spacing.md },
  label: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  hint: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  revoke: { ...typography.body, color: colors.error, fontWeight: "600" },
  input: { ...typography.body, color: colors.textPrimary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginTop: spacing.md },
  btn: { borderRadius: radii.md, paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.md },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { ...typography.button, color: colors.userText },
});
