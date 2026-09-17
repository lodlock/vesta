// On-device diagnostics — the offline-first substitute for telemetry. Shows the
// model, the last turn's prefill cost (the JS-visible proxy for KV-cache reuse:
// a warm append evaluates few prompt tokens, a cold turn many), and the on-disk
// footprint (database + prefix session cache). Everything is read locally; the
// screen sends nothing anywhere.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from "react-native";
import {
  getModelInfo,
  getContextSize,
  getKvCacheType,
  getLastCompletion,
  loadedBackendId,
  type LastCompletionStats,
} from "../lib/llm/llm-engine";
import {
  getSessionCacheInfo,
  type SessionCacheInfo,
} from "../lib/llm/session-cache";
import { getLastRun, reportedOr, type RunRecord } from "../lib/llm/run-record";
import {
  accountGeneratedTokens,
  describeGeneratedTokens,
} from "../lib/llm/token-accounting";
import { backendDiagnostics, genieXLlamaCpp } from "../lib/llm/backends/registry";
import type { BackendDiagnostics } from "../lib/llm/backends/types";
import { getStartupTrace, type StartupTrace } from "../lib/dev/startup-trace";
import {
  getLastAssistTurn,
  getAssistModelTurns,
  type AssistTurnTrace,
} from "../lib/assist/assist-trace";
import * as FileSystem from "expo-file-system/legacy";
import { getDatabaseSizeBytes } from "../lib/storage/database";
import { getActiveModel } from "../lib/models/model-registry";
import type { InstalledModel, ModelBackendId } from "../lib/models/types";
import { useModelStore } from "../lib/store/model-store";
import { breakDownHubModels } from "../lib/models/npu-hub";
import {
  probeHubIdentity,
  formatProbe,
  formatChipsetIdentity,
  type HubIdentityProbe,
} from "../lib/models/npu-hub-probe";
import {
  npuResolveAlias,
  npuLogDiagnostic,
  npuHubCacheReport,
  npuHubListProbe,
  npuGenieXLogReport,
  npuInstalledReport,
  npuExternalImportDir,
  type GenieXComputeUnit,
} from "../lib/native/npu";
import {
  pickSpikeGguf,
  GENIEX_SPIKE_DIR,
} from "../lib/models/geniex-gguf-import";
import { formatPullTrace, lastPulledModelName } from "../lib/models/npu-pull-trace";
import {
  buildReports,
  type DiagnosticsReports,
  type DiagnosticsSection,
} from "../lib/diagnostics/report";
import { copySummary, shareFullReport } from "../lib/diagnostics/deliver";
// The summary/full pairing for every probe section lives out of this file, so a
// test can feed it a populated device and measure what the compact form weighs.
// That is the bug this module was extracted for — see its header.
import {
  probeSections,
  formatHubState,
  describeLoadedRuntime,
  type HubDiag,
} from "../lib/diagnostics/sections";
import { countPullability, pullabilityIndex } from "../lib/models/npu-pullability";
import { NPU_CATALOG } from "../lib/models/npu-catalog";
import { isNpuModel } from "../lib/models/npu-compat";
import { saveGenieXComputeUnit } from "../lib/models/geniex-compute";
import { formatBytes } from "../lib/models/format";
import { colors, spacing, typography, radii } from "../lib/theme";

interface Diag {
  modelLoaded: boolean;
  modelName: string | null;
  modelPath: string | null;
  /** Which runtime holds the live session, null when nothing is loaded. */
  runtimeOwner: ModelBackendId | null;
  /** Which runtime the active row is registered for. */
  declaredBackend: ModelBackendId | null;
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
  /** Hub state, or null on a build with no NPU bridge in it. */
  hub: HubDiag | null;
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
    runtimeOwner: loadedBackendId(),
    declaredBackend: active?.backend ?? null,
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
    hub: gatherHub(active),
  };
}

/**
 * Read straight off the store rather than re-queried.
 *
 * Diagnostics must not cause a network call: the point is to report what the
 * app currently believes, and a screen that went and fetched a fresh answer
 * would be describing a state the rest of the app was never in.
 */
function gatherHub(active: InstalledModel | null): HubDiag | null {
  const store = useModelStore.getState();
  if (!store.npu.inBuild) return null;
  const snapshot = store.npuHub.snapshot;
  const breakdown = snapshot
    ? breakDownHubModels(snapshot.models, store.npu.soc, store.npu.chipsets)
    : null;
  const pullIndex = pullabilityIndex(store.npuPullability);
  return {
    checkedAt: snapshot?.checkedAt ?? null,
    cached: snapshot?.cached ?? false,
    total: snapshot?.models.length ?? 0,
    compatible: breakdown?.compatible.length ?? 0,
    otherChipsets: breakdown?.otherChipsets ?? 0,
    unsupportedType: breakdown?.unsupportedType ?? 0,
    pullability: breakdown
      ? countPullability(
          breakdown.compatible.map((m) => m.entry.name),
          pullIndex,
        )
      : null,
    canonicalSoc: store.npu.canonicalSoc,
    error: store.npuHub.error,
    activeNpuModel: active && isNpuModel(active) ? active.displayName : null,
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

/**
 * Who this device is, what is loaded on it, and what last ran.
 *
 * First in both reports, because every other section is uninterpretable
 * without it: a pull failure means something different on a chipset the
 * runtime does not recognise than on one it does, and a cache report about a
 * model that is not the active one is a different question entirely.
 *
 * `detail` decides how much of each backend's `details` map is printed. The
 * summary prints the fields that identify the device and the ones carrying an
 * error; the full report prints every key the backend reported, because the
 * useful one is regularly the one nobody thought to select.
 */
function formatDeviceState(
  diag: Diag | null,
  at: Date,
  detail: "summary" | "full",
): string {
  const lines = ["Vesta diagnostics — device, runtime and active model"];
  lines.push(`captured: ${at.toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  lines.push(`platform: ${Platform.OS} ${String(Platform.Version)}`);
  if (!diag) {
    lines.push("device state: unavailable — the screen had not finished gathering");
    return lines.join("\n");
  }

  lines.push(`active model: ${diag.modelName ?? "<none>"}`);
  lines.push(`model file: ${diag.modelPath?.split("/").pop() ?? "<none>"}`);
  lines.push(
    `loaded: ${describeLoadedRuntime(diag.runtimeOwner, diag.declaredBackend)}`,
  );
  lines.push(`context: ${diag.contextSize} tokens, KV ${diag.kvType}`);

  const run = diag.run;
  lines.push(
    run
      ? `last run: ${run.backendLabel} · ${run.computeLabel} · ${run.modelName || "<none>"} · ${run.artifactLabel}`
      : "last run: none this session",
  );
  if (run?.soc) lines.push(`last run SoC: ${run.soc}`);
  if (run?.runtimeVersion) lines.push(`last run runtime: ${run.runtimeVersion}`);

  for (const backend of diag.backends) {
    const state = backend.loaded ? "loaded" : backend.available ? "available" : "unavailable";
    lines.push(`backend ${backend.id}: ${state}`);
    if (backend.unavailableReason) lines.push(`  reason: ${backend.unavailableReason}`);
    const keys =
      detail === "full"
        ? Object.keys(backend.details)
        : SUMMARY_BACKEND_KEYS.filter((k) => k in backend.details);
    for (const key of keys) {
      const value = String(backend.details[key]);
      // An empty lastError is the absence of an error, not a field worth a
      // line — but a non-empty one is among the most important lines here.
      if (value === "") continue;
      lines.push(`  ${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * The backend fields the summary carries.
 *
 * Identity and failure, nothing else: which silicon, which name the runtime
 * knows it by, which one compatibility is decided on, which plugin version,
 * and whatever went wrong last. The full report prints the whole map.
 */
const SUMMARY_BACKEND_KEYS = [
  "soc",
  "runtimeChipset",
  "canonicalChipset",
  "runtimeVersion",
  "requestedRuntime",
  "requestedComputeUnit",
  "pendingComputeUnit",
  "manifestRuntime",
  "lastError",
];

/**
 * Cache health in four lines rather than an inventory.
 *
 * The prefix session cache is the difference between a 13x cold start and a
 * warm one, so whether it exists and whether it was validated this session are
 * worth carrying. The FILES are not: a per-file listing is what made the old
 * report unsendable, and it answers nothing this does not.
 */
function formatCacheHealth(diag: Diag | null): string {
  if (!diag) return "";
  const c = diag.cache;
  return [
    "Cache health",
    `prefix session cache: ${c.exists ? "present" : "absent"}`,
    `size: ${formatBytes(c.sizeBytes)}`,
    `tokens: ${c.tokenCount ?? "<not recorded>"}`,
    `saved: ${c.savedAt ? new Date(c.savedAt).toISOString() : "never"}`,
    `primed this session: ${c.primed ? "yes" : "no"}`,
    `database: ${formatBytes(diag.dbBytes)}`,
  ].join("\n");
}

/**
 * The whole report, in the order a reader wants it.
 *
 * Identity first, then whatever the hub probe turned up (the open question on
 * an NPU build, and nothing at all on any other), then the state that explains
 * both. Everything before and after `probe` is available on EVERY build, which
 * is why Copy summary and Share full report are not inside the Qualcomm card:
 * a report of the model, the backends and the cache is worth having on a device
 * that has no NPU to ask about.
 */
function reportSections(
  diag: Diag | null,
  at: Date,
  probe: DiagnosticsSection[],
): DiagnosticsSection[] {
  return [
    {
      name: "device",
      summary: formatDeviceState(diag, at, "summary"),
      full: formatDeviceState(diag, at, "full"),
      essential: true,
    },
    ...probe,
    { name: "hub state", summary: formatHubState(diag?.hub ?? null), essential: true },
    { name: "cache health", summary: formatCacheHealth(diag), essential: true },
  ];
}

export default function DiagnosticsScreen() {
  const [probe, setProbe] = useState<HubIdentityProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // What the hub probe turned up, if it has been run. Empty on every build
  // without an NPU bridge, and until the button is pressed on one that has it.
  const [probeParts, setProbeParts] = useState<DiagnosticsSection[]>([]);

  // GenieX llama.cpp spike. Local to this screen because the lane has no other
  // entry point and is not meant to acquire one yet.
  const [spikeDir, setSpikeDir] = useState<string | null>(null);
  const [spikeBusy, setSpikeBusy] = useState(false);
  const [spikeNote, setSpikeNote] = useState<string | null>(null);
  const [spikeCompute, setSpikeCompute] = useState<GenieXComputeUnit>(
    genieXLlamaCpp().getComputeUnit(),
  );

  // Gathered state. It lives ABOVE runProbe because the report leads with the
  // device's identity, and a probe result with no device attached to it is
  // most of a page about a machine the reader cannot name.
  const [diag, setDiag] = useState<Diag | null>(null);

  const refresh = useCallback(() => {
    gather()
      .then(setDiag)
      .catch(() => setDiag(null));
  }, []);

  useEffect(refresh, [refresh]);

  // Where `adb push` should put the GGUF. Asked once: it is a property of the
  // install (package name and user id), not something this screen can compose.
  useEffect(() => {
    let live = true;
    npuExternalImportDir()
      .then((dir) => {
        if (live) setSpikeDir(dir);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /**
   * Imports the one GGUF sitting in the push directory.
   *
   * The directory is listed HERE, before the native side is called, so the two
   * refusals that matter arrive as sentences rather than as a manifest
   * inference failure several seconds later: nothing to import, and — the one
   * this spike exists to enforce — an artifact that is not Q4_0.
   */
  const importSpikeGguf = useCallback(async () => {
    if (!spikeDir) return;
    setSpikeBusy(true);
    setSpikeNote(null);
    const dir = `file://${spikeDir}/${GENIEX_SPIKE_DIR}`;
    try {
      let names: string[] = [];
      try {
        names = await FileSystem.readDirectoryAsync(dir);
      } catch {
        setSpikeNote(`Nothing at ${spikeDir}/${GENIEX_SPIKE_DIR}/ — create it and push a GGUF.`);
        return;
      }
      const pick = pickSpikeGguf(names);
      if (!pick.ok) {
        setSpikeNote(pick.reason);
        return;
      }
      // The DIRECTORY is what LOCALFS takes — a bare .gguf path is refused as
      // "a file but not a .zip". See lib/models/geniex-gguf-import.
      await useModelStore
        .getState()
        .importGenieXGguf(`${spikeDir}/${GENIEX_SPIKE_DIR}`, pick.displayName);
      const err = useModelStore.getState().error;
      setSpikeNote(err ?? `Imported ${pick.file}. Activate it from Models.`);
      refresh();
    } finally {
      setSpikeBusy(false);
    }
  }, [spikeDir, refresh]);

  // Stamped when the state was gathered, not when the button was pressed: the
  // report's "captured" line should name the moment the numbers are from.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capturedAt = useMemo(() => new Date(), [diag]);

  // Both artefacts, built together from one set of sections: the compact one
  // for the clipboard and the complete one for the file. See lib/diagnostics/
  // report.ts for why there are two and what separates them.
  const reports: DiagnosticsReports | null = useMemo(
    () => (diag ? buildReports(reportSections(diag, capturedAt, probeParts)) : null),
    [diag, capturedAt, probeParts],
  );

  // Explicitly triggered, never on render: this calls into the runtime, and a
  // diagnostics screen that fetched on its own would report a state the rest
  // of the app was never in.
  const runProbe = useCallback(async () => {
    const entry = NPU_CATALOG[0];
    if (!entry) return;
    setProbing(true);
    try {
      const hubName =
        useModelStore
          .getState()
          .npuHub.snapshot?.models.find((m) =>
            m.name.toLowerCase().endsWith(
              entry.modelName.slice(entry.modelName.lastIndexOf("/") + 1).toLowerCase(),
            ),
          )?.name ?? null;
      const result = await probeHubIdentity(
        entry.modelName,
        hubName,
        npuResolveAlias,
        hubName ?? entry.modelName,
        "AIHUB",
      );
      setProbe(result);

      // The cache the runtime actually read, gathered in the same action.
      // listHubModels() finds this model and pull() reports it missing; both
      // cannot be true of one manifest, and the manifests are files in our own
      // data directory. Read-only, and it triggers no fetch — the point is to
      // report what the app already acted on.
      // The model the LAST PULL asked for, when there was one — otherwise the
      // catalogue entry. Interrogating the manifest about Qwen3 while the
      // failing install is a Falcon3 hub row answers a question nobody asked.
      const subject = lastPulledModelName() ?? entry.modelName;
      const repo = subject.slice(subject.lastIndexOf("/") + 1);

      // The three questions, asked of the manifest rather than of a 311 KB
      // dump: is there an exact display_name, an exact id, and what does the
      // manifest hold for anything Qwen3-shaped at all.
      const cache = await npuHubCacheReport({
        needle: repo,
        displayName: repo,
        id: repo.toLowerCase().replace(/-/g, "_"),
      });

      // And the listing, ONCE, unfiltered — which is the SDK's own default
      // and the same call production makes. This used to run twice, the second
      // time with the literal "SM8850", on the belief that the parameter's
      // meaning was unknown and worth measuring. It is not unknown:
      // geniex-android 0.4.0 declares `listHubModels(chipset: String? = null)`,
      // and a string that is not a key in the runtime's platform.json fails the
      // whole call (`chipset "…" not found in platform.json`). So the second
      // call could only ever return the catalogue or an error about our own
      // guess, and neither is evidence. What it was really asking — which
      // spelling of this chip the SDK accepts — is answered below from the
      // runtime's own table and the hub's own keys, with no extra call.
      //
      // The manifest is still stat-ed either side, which is the one thing this
      // has that the production call does not: if the listing rewrites the file
      // the pull then reads, the two stats differ.
      const listAll = await npuHubListProbe();

      // Read off the store, never re-queried: diagnostics must report what the
      // app already believes. See gatherHub for the same rule.
      const store = useModelStore.getState();
      const chipsetIdentity = formatChipsetIdentity({
        deviceSoc: store.npu.soc,
        table: store.npu.chipsets,
        models: store.npuHub.snapshot?.models ?? null,
      });

      // And what the SDK itself has been saying all along. Nothing is enabled
      // here: GenieX 0.4.0 logs at TRACE from its first instruction and its
      // own JNI_OnLoad routes every level, plus stdout and stderr, into
      // logcat under one tag. This capture is the only part that was missing.
      const genieXLog = await npuGenieXLogReport();

      // And whether the runtime still holds the bundle a pull just produced.
      // Read-only: list(), getPaths(), getType(), resolveAlias() and a stat.
      // Both spellings are asked for, because the answer to "is it filed under
      // the name we asked with?" is only available by asking for both.
      const installed = await npuInstalledReport([
        entry.modelName,
        ...(hubName && hubName !== entry.modelName ? [hubName] : []),
      ]);

      // Logged under the VestaNpu tag, not the JS one, so a single
      // `adb logcat -s VestaNpu` capture carries the probe, the cache, the
      // pull request and its failure together. Also to the JS console, which
      // is where a default build (no native bridge) can still see it.
      // TEMPORARY DIAGNOSTIC. rc=-100000 has no symbolic name in 0.4.0 and sits
      // at the base of the common-error block, so the number says nothing on
      // its own — the request that produced it and whether any byte moved are
      // the evidence. First after the device identity, because it is
      // currently the open question. See npu-pull-trace.ts.
      const pullTrace = formatPullTrace();

      // ONE list of sections, TWO artefacts, and the difference is not
      // cosmetic.
      //
      // Which form of each section goes where is decided in
      // lib/diagnostics/sections.ts, not here. That is not tidying: the rule a
      // section has to obey — a compact form that stays compact on a FULL
      // device — is only checkable against a populated fixture, and a rule
      // living inside a screen component is a rule nothing tests. It was got
      // wrong twice before it moved, both times invisibly until a real device
      // with a real bundle produced a summary that hit the 64 KiB guard.
      const gathered: DiagnosticsSection[] = probeSections({
        repo,
        pullTrace,
        identityProbe: formatProbe(result),
        chipsetIdentity,
        cache,
        listProbe: listAll,
        installed,
        genieXLog,
      });
      setProbeParts(gathered);

      // Still logged in full. `npuLogDiagnostic` splits on newlines and writes
      // one Log.i per line, so it has no Binder ceiling — and a report already
      // in logcat survives an app that dies before anyone shares it.
      const built = buildReports(reportSections(diag, new Date(), gathered));
      npuLogDiagnostic(built.full);
      console.log(`[Diagnostics] ${built.full}`);
    } finally {
      setProbing(false);
    }
  }, [diag]);

  // ── The two ways the report leaves the device ───────────────────────
  //
  // Both delegate to lib/diagnostics/deliver.ts, which owns the rule that
  // separates them: the clipboard carries the summary and nothing else, and
  // the full report never goes near it. These handlers only turn an outcome
  // into a button label.

  const copySummaryAction = useCallback(() => {
    if (!reports) return;
    const outcome = copySummary(reports.summary);
    const kb = Math.max(1, Math.round(outcome.bytes / 1024));
    if (!outcome.copied) {
      setCopied(outcome.error ? `Copy failed: ${outcome.error}` : "Copy failed");
    } else if (outcome.truncated) {
      // Should be unreachable: the summary carries no per-file inventory and
      // so does not grow with the cache. If it ever shows, a section has
      // started dumping and the fix is in the section, not in the cap.
      setCopied(`Copied ${kb} KB (trimmed — report a bug)`);
    } else {
      setCopied(`Copied summary · ${kb} KB`);
    }
    setTimeout(() => setCopied(null), 4000);
  }, [reports]);

  const shareFullAction = useCallback(async () => {
    if (!reports) return;
    setSharing(true);
    try {
      const outcome = await shareFullReport(reports.full);
      const kb = Math.max(1, Math.round(outcome.bytes / 1024));
      setSharedNote(
        outcome.shared
          ? `Shared ${outcome.fileName} · ${kb} KB`
          : `Share failed: ${outcome.error ?? "unknown error"}`,
      );
    } finally {
      setSharing(false);
      setTimeout(() => setSharedNote(null), 6000);
    }
  }, [reports]);

  const fileName = diag?.modelPath?.split("/").pop() ?? "—";
  const last = diag?.last;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Two actions, named for what they actually deliver, and first on the
          screen because they are what a diagnostics screen is FOR.

          The clipboard one says "summary" because it IS one — a button
          labelled "Copy" beside a deliberately abbreviated payload is how
          someone ends up pasting half a report into a bug tracker and
          believing it is the whole thing.

          Outside the Qualcomm card, deliberately: the report leads with the
          model, the backends and the cache, and all of that is worth sending
          from a device that has no NPU to ask about. Running the hub probe
          adds its sections to the same report. */}
      {reports && (
        <>
          <Text style={styles.sectionTitle}>Report</Text>
          <View style={styles.card}>
            <View style={styles.probeActions}>
              <TouchableOpacity
                style={styles.probeBtn}
                onPress={copySummaryAction}
                activeOpacity={0.7}
              >
                <Text style={styles.probeBtnText}>{copied ?? "Copy summary"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.probeBtn}
                onPress={shareFullAction}
                disabled={sharing}
                activeOpacity={0.7}
              >
                <Text style={styles.probeBtnText}>
                  {sharing ? "Preparing…" : (sharedNote ?? "Share full report")}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              &ldquo;Copy summary&rdquo; puts{" "}
              {Math.max(1, Math.round(reports.summaryBytes / 1024))} KB on the
              clipboard — identity, state and errors, no file inventories.
              &ldquo;Share full report&rdquo; sends all{" "}
              {Math.max(1, Math.round(reports.fullBytes / 1024))} KB as a .txt
              file through the share sheet; the clipboard cannot carry that much
              and the attempt used to crash the app.
            </Text>
          </View>
        </>
      )}

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
              {/* The runtime's own count, shown as such — and shown with its
                  contradiction attached when the text it produced proves the
                  count cannot be right. See lib/llm/token-accounting. */}
              <Row
                label="Generated"
                value={describeGeneratedTokens(
                  accountGeneratedTokens(
                    diag.run.generatedTokens,
                    diag.run.generatedChars ?? 0,
                  ),
                )}
              />
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

        {/* Qualcomm's catalogue, as state rather than as a list. The models
            themselves live on the Models screen; what belongs here is whether
            the query worked, when, and how much of the answer this device can
            actually use — the four numbers that explain an empty list. */}
        {diag.hub && (
          <>
            <Text style={styles.sectionTitle}>Qualcomm Hub</Text>
            <View style={styles.card}>
              <Row
                label="Last check"
                value={
                  diag.hub.checkedAt === null
                    ? "never"
                    : `${new Date(diag.hub.checkedAt).toLocaleString()}${diag.hub.cached ? " (cached)" : ""}`
                }
              />
              <Row label="Models returned" value={String(diag.hub.total)} />
              <Row
                label="Compatible here"
                value={String(diag.hub.compatible)}
              />
              <Row
                label="Filtering on"
                value={diag.hub.canonicalSoc ?? "unknown chipset"}
              />
              <Row
                label="Active NPU model"
                value={diag.hub.activeNpuModel ?? "none"}
              />
              {diag.hub.error && (
                <Text style={styles.hint}>
                  Last hub error: {diag.hub.error}
                </Text>
              )}
              <Text style={styles.hint}>
                &ldquo;Compatible here&rdquo; counts models the hub offers for this
                device&rsquo;s canonical chipset class AND in a model type this
                app has a runtime for. A model absent from the list is absent as
                of the check above, not permanently — Qualcomm publishes on its
                own schedule.
              </Text>
            </View>

            {/* An identity probe, on demand.
                Three -100010s have now come from three different wrong strings,
                so the useful question is no longer "what should we send" but
                "what does the SDK say about each thing we could send".
                resolveAlias() is the only public call that answers it. This
                asks once per candidate spelling and prints every answer —
                it decides nothing and changes nothing about what is pulled. */}
            <View style={styles.card}>
              <Text style={styles.probeTitle}>Hub identity probe</Text>
              {probe ? (
                <>
                  {/* The four values that must stay distinguishable. Each on
                      its own line, at full length: the first rendering of this
                      put candidate and result in aligned columns and the screen
                      truncated exactly the prefix that distinguishes
                      qualcomm/… from ai-hub-models/…. */}
                  <Text style={styles.probeKey}>Pull model name:</Text>
                  <Text style={styles.probeVal} selectable>
                    {probe.pullName}
                  </Text>
                  <Text style={styles.probeKey}>HubSource:</Text>
                  <Text style={styles.probeVal} selectable>
                    {probe.hub}
                  </Text>
                  {reports && (
                    <Text style={styles.probeSource}>
                      {reports.full.split("\n").length} lines captured,
                      including the cached hub manifests.
                      &ldquo;Copy summary&rdquo; puts{" "}
                      {Math.max(1, Math.round(reports.summaryBytes / 1024))} KB on
                      the clipboard; &ldquo;Share full report&rdquo; sends all{" "}
                      {Math.max(1, Math.round(reports.fullBytes / 1024))} KB as a
                      .txt file.
                    </Text>
                  )}
                  {probe.rows.map((r) => (
                    <View key={r.candidate} style={styles.probeEntry}>
                      <Text style={styles.probeKey}>Candidate:</Text>
                      <Text style={styles.probeVal} selectable>
                        {r.candidate}
                      </Text>
                      <Text style={styles.probeKey}>resolveAlias:</Text>
                      {/* <null> rather than a blank: "the runtime said
                          nothing" is a different answer from "it echoed the
                          string back", and a blank reads as neither. */}
                      <Text style={styles.probeVal} selectable>
                        {r.resolved ?? "<null>"}
                      </Text>
                      <Text style={styles.probeSource}>source: {r.source}</Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={styles.hint}>
                  Asks the runtime what it makes of each spelling of the model
                  name, and reads the hub manifests it cached under this app&rsquo;s
                  own data directory. Afterwards, &ldquo;Copy summary&rdquo; puts a
                  few KB on the clipboard and &ldquo;Share full report&rdquo; sends
                  the complete text as a file — the clipboard cannot carry it.
                </Text>
              )}
              <View style={styles.probeActions}>
                <TouchableOpacity
                  style={styles.probeBtn}
                  onPress={runProbe}
                  disabled={probing}
                  activeOpacity={0.7}
                >
                  <Text style={styles.probeBtnText}>
                    {probing ? "Probing…" : probe ? "Run again" : "Run hub diagnostics"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* ── GenieX llama.cpp lane (SPIKE) ──────────────────────────
                A test harness, not a feature. It exists so the second GenieX
                runtime can be driven on a real device; there is no catalog
                behind it and nothing on the Models screen offers it. The
                compute-unit buttons are here and ONLY here for the same
                reason — `npu` is the alias that makes GenieX log the explicit
                "Found device: HTP0" sentence, so it is the one that proves
                binding, while `hybrid` is the one that should be fast. */}
            <Text style={styles.sectionTitle}>GenieX llama.cpp (spike)</Text>
            <View style={styles.card}>
              <Text style={styles.probeKey}>Push a Q4_0 GGUF here:</Text>
              <Text style={styles.probeVal} selectable>
                {spikeDir ? `${spikeDir}/${GENIEX_SPIKE_DIR}/` : "…"}
              </Text>
              <Row label="Compute unit" value={spikeCompute} />
              {spikeNote && <Text style={styles.hint}>{spikeNote}</Text>}
              <View style={styles.probeActions}>
                {(["hybrid", "npu"] as const).map((unit) => (
                  <TouchableOpacity
                    key={unit}
                    style={styles.probeBtn}
                    onPress={() => {
                      setSpikeCompute(unit);
                      genieXLlamaCpp().setComputeUnit(unit);
                      // Remembered, so the next launch restores the session
                      // with the unit that was chosen rather than the default.
                      saveGenieXComputeUnit(unit).catch(() => {});
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.probeBtnText}>
                      {spikeCompute === unit ? `• ${unit}` : unit}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={styles.probeBtn}
                  onPress={importSpikeGguf}
                  disabled={spikeBusy || !spikeDir}
                  activeOpacity={0.7}
                >
                  <Text style={styles.probeBtnText}>
                    {spikeBusy ? "Importing…" : "Import GGUF"}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.hint}>
                Registers the directory with the GenieX model manager
                (HubSource.LOCALFS) and adds it as a geniex_llama_cpp row —
                then activate it from Models like any other. The compute unit
                applies to the NEXT load, so switch it before activating.
                &ldquo;hybrid&rdquo; is HTP + CPU by design and logs no device
                list; &ldquo;npu&rdquo; pins HTP0 and says so in the log.
                {"\n\n"}
                Q4_0 is required — it is the only quantization the Hexagon
                backend has kernels for. That is checked against the FILE NAME
                only, which is a spike shortcut and not verification: the
                weights themselves are never inspected.
              </Text>
            </View>
          </>
        )}

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
              {backend.id === "geniex_llama_cpp" && (
                <>
                  <Row
                    label="Requested runtime"
                    value={String(backend.details.requestedRuntime)}
                  />
                  {/* The LOADED session's compute unit, and separately the one
                      the next load would use. One field used to serve both, so
                      moving the selector silently rewrote the description of a
                      running session. They are two facts and they can disagree;
                      when they do, the next load is a real reload. */}
                  <Row
                    label="Session compute"
                    value={String(backend.details.requestedComputeUnit)}
                  />
                  <Row
                    label="Next load compute"
                    value={String(backend.details.pendingComputeUnit)}
                  />
                  {backend.details.computeUnitStale === true && (
                    <Text style={styles.hint}>
                      The loaded session was built with{" "}
                      {String(backend.details.requestedComputeUnit)}. Activating
                      this model again will rebuild it as{" "}
                      {String(backend.details.pendingComputeUnit)} — the session
                      is not reused when the compute unit changes.
                    </Text>
                  )}
                  <Row
                    label="Manifest runtime"
                    value={String(backend.details.manifestRuntime)}
                  />
                  <Row
                    label="Context"
                    value={reportedOr(
                      Number(backend.details.contextSize),
                      "tokens",
                    )}
                  />
                  {/* The device-binding evidence. Read the caveat below before
                      reading a false here as a negative. */}
                  <Row
                    label="Saw HTPn device"
                    value={backend.details.sawHtpDevice ? "yes" : "no"}
                  />
                  <Row
                    label="Saw ggml-hexagon"
                    value={backend.details.sawHexagonBackend ? "yes" : "no"}
                  />
                  {backend.details.sawNoValidDevices === true && (
                    <Text style={styles.hint}>
                      GenieX resolved a device list and found none of it. This
                      session is NOT on the Hexagon DSP.
                    </Text>
                  )}
                  {String(backend.details.deviceLines) !== "" && (
                    <>
                      <Text style={styles.probeKey}>
                        Device lines{" "}
                        {backend.details.deviceEvidenceScoped
                          ? "(this load)"
                          : "(UNSCOPED — may predate this load)"}
                        :
                      </Text>
                      <Text style={styles.probeVal} selectable>
                        {String(backend.details.deviceLines)}
                      </Text>
                    </>
                  )}
                  {String(backend.details.lastError) !== "" && (
                    <Text style={styles.hint}>
                      Last error: {String(backend.details.lastError)}
                    </Text>
                  )}
                  <Text style={styles.hint}>
                    This lane is not an NPU claim. With compute_unit = hybrid
                    GenieX passes an EMPTY device id and llama.cpp schedules per
                    tensor across the Hexagon DSP and the CPU — so some of the
                    work is on the CPU by design, and `resolve_devices()`
                    returns before logging a device list at all. An absent
                    &ldquo;HTPn&rdquo; under hybrid is silence, not a negative;
                    load once with compute_unit = npu for the explicit
                    &ldquo;Found device: HTP0&rdquo; line.
                  </Text>
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
        <Row
          label="Status"
          value={
            diag
              ? describeLoadedRuntime(diag.runtimeOwner, diag.declaredBackend)
              : "no"
          }
        />
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
  probeBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignSelf: "flex-start",
  },
  probeBtnText: { ...typography.bodySmall, color: colors.textPrimary },
  probeTitle: { ...typography.body, color: colors.textPrimary },
  probeActions: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  probeEntry: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  probeKey: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  // Monospaced and free to wrap. No numberOfLines, no ellipsis: a truncated
  // identifier is the bug this screen exists to avoid.
  probeVal: {
    fontFamily: Platform.select({ android: "monospace", default: "Menlo" }),
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary,
  },
  probeSource: { ...typography.caption, color: colors.textMuted },
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
