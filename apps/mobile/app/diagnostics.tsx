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
import {
  getLastAssistTurn,
  getAssistModelTurns,
  type AssistTurnTrace,
} from "../lib/assist/assist-trace";
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
  assist: AssistTurnTrace | null;
  assistTurns: number;
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
    assist: getLastAssistTurn(),
    assistTurns: getAssistModelTurns(),
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
              {/* Only rendered when the runtime named one. llama.cpp does not
                  report a stop reason in this shape, so an empty row here is
                  the absence of a fact, not a missing measurement. */}
              {diag.run.stopReason && (
                <Row label="Stop reason" value={diag.run.stopReason} />
              )}
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
                <>
                  {/* Raw, raw, then the id compatibility is decided on. All
                      three, because the raw pair is how a refusal gets
                      diagnosed and the canonical one is how it gets decided. */}
                  <Row label="SoC (device)" value={String(backend.details.soc)} />
                  <Row
                    label="Chipset (runtime)"
                    value={String(backend.details.runtimeChipset)}
                  />
                  <Row
                    label="Runtime aliases"
                    value={String(backend.details.runtimeChipsetAliases)}
                  />
                  <Row
                    label="Canonical target"
                    value={String(backend.details.canonicalChipset)}
                  />
                  {String(backend.details.runtimeChipset) === "not recognised" && (
                    <Row
                      label="Runtime knows"
                      value={String(backend.details.runtimeChipsetTable)}
                    />
                  )}
                  <Row
                    label="QAIRT plugin"
                    value={String(backend.details.runtimeVersion)}
                  />
                  <Row
                    label="Requested runtime"
                    value={String(backend.details.requestedRuntime)}
                  />
                  <Row
                    label="Requested compute"
                    value={String(backend.details.requestedComputeUnit)}
                  />
                  <Row
                    label="Manifest runtime"
                    value={String(backend.details.manifestRuntime)}
                  />
                  {String(backend.details.lastError) !== "" && (
                    <Text style={styles.hint}>
                      Last error: {String(backend.details.lastError)}
                    </Text>
                  )}
                  {/* The honesty note. It is here rather than in a doc comment
                      because the screen above it says "Hexagon HTP / NPU", and
                      a reader deserves to know exactly how strong that claim
                      is. GenieX exposes no post-hoc attestation — nothing in
                      its API reports which processor executed a generation —
                      so what is actually known is that the session was created
                      on the QAIRT plugin with compute_unit = npu and that this
                      backend produced the tokens. The plugin itself refuses
                      anything else ("qairt plugin only supports NPU
                      inference"), which makes that a strong inference, but an
                      inference is what it is. */}
                  {backend.details.computeAttested === false && (
                    <Text style={styles.hint}>
                      &ldquo;NPU&rdquo; here is inferred from a successful
                      QAIRT session created with compute_unit = npu, not
                      attested by the runtime after the fact — GenieX reports no
                      such thing. The QAIRT plugin runs on the Hexagon NPU only
                      and refuses any other compute unit, so a session that
                      exists at all is an NPU session.
                    </Text>
                  )}
                </>
              )}
            </View>
          ))}
        </View>

        {/* Where the launch wait went. Measured, so the unavoidable part is
            separated from the part that is ours. */}
        <Text style={styles.sectionTitle}>Startup</Text>
        <View style={styles.card}>
          <Row
            label="Process age at boot"
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
            &ldquo;Process age at boot&rdquo; is measured from PROCESS start
            (Process.getStartElapsedRealtime), so it only means &ldquo;Zygote, native
            libraries and bundle load&rdquo; on a genuinely cold start. On a warm
            launch — the process outlived the last Activity — it is the age of
            the process, not this launch&rsquo;s latency, and will read far larger
            than &ldquo;Total to ready&rdquo;. Compare the two: a huge value here beside a
            few ms there means nothing was reloaded.
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

      {/* Where a model-backed assistant turn's wait went. "It reloads every
          time" has three possible meanings and they need different fixes —
          these numbers say which one it is rather than leaving it to a
          stopwatch. See lib/assist/assist-trace. */}
      <Text style={styles.sectionTitle}>Last assistant turn</Text>
      <View style={styles.card}>
        {diag?.assist ? (
          <>
            <Row
              label="Model resident"
              value={diag.assist.loadedAtStart ? "yes" : "no — loaded for this turn"}
            />
            <Row label="Model load" value={`${diag.assist.loadMs} ms`} />
            <Row
              label="Prefix restore"
              value={diag.assist.restoreMs > 0 ? `${diag.assist.restoreMs} ms` : "—"}
            />
            <Row label="Generate" value={`${diag.assist.generateMs} ms`} />
            <Row
              label="Prompt evaluated"
              value={
                diag.assist.promptTokens === null
                  ? "—"
                  : `${diag.assist.promptTokens} tokens`
              }
            />
            <Row
              label="Prompt cached"
              value={
                diag.assist.cachedTokens === null
                  ? "—"
                  : `${diag.assist.cachedTokens} tokens`
              }
            />
            <Row label="Total" value={`${diag.assist.totalMs} ms`} />
            <Row label="Model turns this process" value={`${diag.assistTurns}`} />
            <Text style={styles.hint}>
              &ldquo;Model resident: no&rdquo; on a repeat question means the process was
              killed between invocations, not that Vesta unloaded anything. A
              resident model with a large &ldquo;prompt evaluated&rdquo; means the weights
              stayed but the prompt prefix changed and had to be re-evaluated.
            </Text>
          </>
        ) : (
          <Text style={styles.hint}>
            No model-backed assistant turn yet this session.
          </Text>
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
