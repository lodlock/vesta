// On-device diagnostics — the offline-first substitute for telemetry. Shows the
// model, the last turn's prefill cost (the JS-visible proxy for KV-cache reuse:
// a warm append evaluates few prompt tokens, a cold turn many), and the on-disk
// footprint (database + prefix session cache). Everything is read locally; the
// screen sends nothing anywhere.

import { useCallback, useEffect, useState } from "react";
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import {
  getModelInfo,
  getContextSize,
  getKvCacheType,
  getLastCompletion,
  type LastCompletionStats,
} from "../lib/llm/llm-engine";
import {
  getSessionCacheInfo,
  type SessionCacheInfo,
} from "../lib/llm/session-cache";
import { getLastRun, reportedOr, type RunRecord } from "../lib/llm/run-record";
import { backendDiagnostics } from "../lib/llm/backends/registry";
import type { BackendDiagnostics } from "../lib/llm/backends/types";
import { getStartupTrace, type StartupTrace } from "../lib/dev/startup-trace";
import { getDatabaseSizeBytes } from "../lib/storage/database";
import { getActiveModel } from "../lib/models/model-registry";
import { formatBytes } from "../lib/models/format";
import { colors, spacing, typography, radii } from "../lib/theme";

interface Diag {
  modelLoaded: boolean;
  modelName: string | null;
  modelPath: string | null;
  contextSize: number;
  kvType: string;
  last: LastCompletionStats | null;
  dbBytes: number;
  cache: SessionCacheInfo;
  run: RunRecord | null;
  backends: BackendDiagnostics[];
  startup: StartupTrace;
}

async function gather(): Promise<Diag> {
  const [active, cache, dbBytes] = await Promise.all([
    getActiveModel(),
    getSessionCacheInfo(),
    getDatabaseSizeBytes(),
  ]);
  const info = getModelInfo();
  return {
    modelLoaded: info.loaded,
    modelName: active?.displayName ?? null,
    modelPath: info.path ?? null,
    contextSize: getContextSize(),
    kvType: getKvCacheType(),
    last: getLastCompletion(),
    dbBytes,
    cache,
    run: getLastRun(),
    backends: backendDiagnostics(),
    startup: getStartupTrace(),
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const [diag, setDiag] = useState<Diag | null>(null);

  const refresh = useCallback(() => {
    gather()
      .then(setDiag)
      .catch(() => setDiag(null));
  }, []);

  useEffect(refresh, [refresh]);

  const fileName = diag?.modelPath?.split("/").pop() ?? "—";
  const last = diag?.last;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {diag && (
        <>
        {/* Which backend produced the last answer. Written by the backend that
            actually ran it, so "Hexagon NPU" cannot appear over CPU work. */}
        <Text style={styles.sectionTitle}>Last run</Text>
        <View style={styles.card}>
          {diag.run ? (
            <>
              <Row label="Backend" value={diag.run.backendLabel} />
              <Row label="Compute" value={diag.run.computeLabel} />
              <Row label="Model" value={diag.run.modelName || "—"} />
              <Row label="Artifact" value={diag.run.artifactLabel} />
              {diag.run.soc && <Row label="SoC" value={diag.run.soc} />}
              {diag.run.runtimeVersion && (
                <Row label="Runtime" value={diag.run.runtimeVersion} />
              )}
              <Row
                label="Cold load"
                value={
                  diag.run.reusedSession
                    ? "reused session"
                    : reportedOr(diag.run.coldLoadMs, "ms")
                }
              />
              <Row label="Prompt tokens" value={reportedOr(diag.run.promptTokens)} />
              <Row label="TTFT" value={reportedOr(diag.run.ttftMs, "ms")} />
              <Row
                label="Prefill"
                value={reportedOr(diag.run.prefillTokensPerSecond, "tok/s")}
              />
              <Row label="Generated" value={reportedOr(diag.run.generatedTokens)} />
              <Row
                label="Decode"
                value={reportedOr(diag.run.decodeTokensPerSecond, "tok/s")}
              />
              <Row label="Total" value={reportedOr(diag.run.totalMs, "ms")} />
            </>
          ) : (
            <Text style={styles.hint}>
              No generation yet this session. Deterministic timers and alarms never
              reach a model, so they leave nothing here.
            </Text>
          )}
        </View>

        {/* Every backend, whether or not it is in use — so a device with an NPU
            is told WHY it isn't being used rather than left guessing. */}
        <Text style={styles.sectionTitle}>Backends</Text>
        <View style={styles.card}>
          {diag.backends.map((backend) => (
            <View key={backend.id} style={styles.backendBlock}>
              <Row
                label={backend.displayName}
                value={
                  backend.loaded
                    ? "loaded"
                    : backend.available
                      ? "available"
                      : "unavailable"
                }
              />
              {backend.unavailableReason && (
                <Text style={styles.hint}>{backend.unavailableReason}</Text>
              )}
              {backend.id === "qualcomm_npu" && (
                <Text style={styles.hint}>
                  SoC {String(backend.details.soc)} · runtime{" "}
                  {String(backend.details.runtimeVersion)} · compute{" "}
                  {String(backend.details.computeUnit)}
                </Text>
              )}
            </View>
          ))}
        </View>

        {/* Where the launch wait went. Measured, so the unavoidable part is
            separated from the part that is ours. */}
        <Text style={styles.sectionTitle}>Startup</Text>
        <View style={styles.card}>
          <Row
            label="Android → JS"
            value={reportedOr(diag.startup.phases.nativeToJs, "ms")}
          />
          <Row label="Database" value={reportedOr(diag.startup.phases.database, "ms")} />
          <Row label="Restore chat" value={reportedOr(diag.startup.phases.restore, "ms")} />
          <Row label="Service" value={reportedOr(diag.startup.phases.service, "ms")} />
          <Row
            label="Model load"
            value={
              diag.startup.skippedModel
                ? "skipped (assistant launch)"
                : reportedOr(diag.startup.phases.model, "ms")
            }
          />
          <Row label="Total to ready" value={reportedOr(diag.startup.phases.total, "ms")} />
          <Text style={styles.hint}>
            &ldquo;Android → JS&rdquo; is process start to the first line of JavaScript —
            Zygote, native libraries and the bundle. Vesta cannot shorten it.
          </Text>
        </View>
        </>
      )}

      <Text style={styles.sectionTitle}>Model</Text>
      <View style={styles.card}>
        <Row label="Status" value={diag?.modelLoaded ? "Loaded" : "Not loaded"} />
        <Row label="Name" value={diag?.modelName ?? "—"} />
        <Row label="File" value={fileName} />
        <Row label="Context" value={diag ? `${diag.contextSize} tokens` : "—"} />
        <Row label="KV cache" value={diag?.kvType ?? "—"} />
      </View>

      <Text style={styles.sectionTitle}>Last turn</Text>
      <View style={styles.card}>
        {last ? (
          <>
            <Row label="Prefill" value={`${Math.round(last.promptMs)} ms`} />
            <Row label="Prompt tokens" value={`${last.promptTokens}`} />
            <Row label="Generated" value={`${last.predictedTokens} tokens`} />
            <Row
              label="Decode speed"
              value={`${last.predictedPerSecond.toFixed(1)} tok/s`}
            />
            <Text style={styles.hint}>
              Fewer prompt tokens means the KV cache was reused (a warm append).
              A large count is a cold re-prefill.
            </Text>
          </>
        ) : (
          <Text style={styles.hint}>No completion yet this session.</Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>Storage</Text>
      <View style={styles.card}>
        <Row label="Database" value={diag ? formatBytes(diag.dbBytes) : "—"} />
        <Row
          label="Prefix cache"
          value={
            diag
              ? diag.cache.exists
                ? formatBytes(diag.cache.sizeBytes)
                : "none"
              : "—"
          }
        />
        <Row
          label="Cache tokens"
          value={diag?.cache.tokenCount != null ? `${diag.cache.tokenCount}` : "—"}
        />
        <Row
          label="Cache primed"
          value={diag ? (diag.cache.primed ? "Yes" : "No") : "—"}
        />
        <Text style={styles.hint}>
          The prefix cache stores the stable prompt&apos;s KV state so the first
          message after a cold start is fast. It is large by nature (full KV
          state).
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary]}
        onPress={refresh}
        activeOpacity={0.8}
      >
        <Text style={styles.btnPrimaryText}>Refresh</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  backendBlock: { paddingVertical: 4 },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  label: { ...typography.body, color: colors.textSecondary },
  value: { ...typography.body, color: colors.textPrimary, flexShrink: 1, textAlign: "right" },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  btn: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { ...typography.button, color: colors.userText },
});
