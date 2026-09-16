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
  Platform,
  Clipboard,
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
import type { InstalledModel } from "../lib/models/types";
import { useModelStore } from "../lib/store/model-store";
import { breakDownHubModels } from "../lib/models/npu-hub";
import {
  probeHubIdentity,
  formatProbe,
  formatCacheReport,
  formatListProbe,
  formatChipsetIdentity,
  formatGenieXLog,
  formatInstalledReport,
  type HubIdentityProbe,
} from "../lib/models/npu-hub-probe";
import {
  npuResolveAlias,
  npuLogDiagnostic,
  npuHubCacheReport,
  npuHubListProbe,
  npuGenieXLogReport,
  npuInstalledReport,
} from "../lib/native/npu";
import { formatPullTrace, lastPulledModelName } from "../lib/models/npu-pull-trace";
import {
  assembleReport,
  clipboardSafe,
  type ReportSection,
} from "../lib/diagnostics/clipboard-safe";
import { NPU_CATALOG } from "../lib/models/npu-catalog";
import { isNpuModel } from "../lib/models/npu-compat";
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
  /** Hub state, or null on a build with no NPU bridge in it. */
  hub: HubDiag | null;
}

/**
 * What is worth knowing about the hub without reprinting it.
 *
 * Counts and a timestamp, not a model list: the list belongs on the Models
 * screen, and these values are what EXPLAIN it — in particular why a catalogue
 * of many models can show as none here.
 */
interface HubDiag {
  checkedAt: number | null;
  cached: boolean;
  total: number;
  compatible: number;
  canonicalSoc: string | null;
  error: string | null;
  activeNpuModel: string | null;
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
  return {
    checkedAt: snapshot?.checkedAt ?? null,
    cached: snapshot?.cached ?? false,
    total: snapshot?.models.length ?? 0,
    compatible: breakdown?.compatible.length ?? 0,
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

export default function DiagnosticsScreen() {
  const [probe, setProbe] = useState<HubIdentityProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // The whole diagnostic as text: what gets copied and what gets logged.
  // Kept beside the structured probe because the text is the artefact that
  // leaves the device, and it must never be the abbreviated one.
  const [report, setReport] = useState<string | null>(null);

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
      // the evidence. First in the report because it is currently the open
      // question. See npu-pull-trace.ts.
      const pullTrace = formatPullTrace();

      // TWO reports, and the difference is not cosmetic.
      //
      // What goes on screen and to the clipboard is a SUMMARY. What goes to
      // logcat is everything. Copy used to hand the full thing to
      // `Clipboard.setString`, which is a Binder call, and at 3.38 MB the
      // kernel refused the transaction and took the process with it:
      //
      //   android.os.TransactionTooLargeException: data parcel size 3377296
      //
      // `npuLogDiagnostic` has no such limit — it splits on newlines and writes
      // one Log.i per line — so the full dump keeps its home under
      // `adb logcat -s VestaNpu`, which is where a raw cache dump belonged all
      // along. Ordered most-wanted first, because that is the order the
      // clipboard-safe assembler drops things in.
      const sections: ReportSection[] = [
        { name: "pull trace", body: pullTrace, essential: true },
        { name: "identity probe", body: formatProbe(result), essential: true },
        { name: "chipset identity", body: chipsetIdentity, essential: true },
        {
          name: "hub cache",
          body: cache
            ? formatCacheReport(cache, repo, "summary")
            : "Hub cache report\nunavailable (no NPU bridge in this build)",
          essential: true,
        },
        { name: "hub listing", body: listAll ? formatListProbe(listAll, repo) : "" },
        { name: "installed", body: installed ? formatInstalledReport(installed) : "" },
        {
          name: "native log",
          body: genieXLog ? formatGenieXLog(genieXLog, "summary") : "",
        },
      ];

      const compact = assembleReport(sections);
      setReport(compact.text);

      const full = [
        pullTrace,
        formatProbe(result),
        chipsetIdentity,
        cache ? formatCacheReport(cache, repo, "full") : "",
        listAll ? formatListProbe(listAll, repo) : "",
        installed ? formatInstalledReport(installed) : "",
        genieXLog ? formatGenieXLog(genieXLog, "full") : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      npuLogDiagnostic(full);
      console.log(`[Diagnostics] ${full}`);
    } finally {
      setProbing(false);
    }
  }, []);

  // Clipboard comes from react-native core. Still present in 0.83 (with a
  // deprecation warning) and already linked — pulling in a new native
  // dependency mid-investigation would cost a rebuild to copy a string.
  // Reports failure honestly rather than claiming a copy that did not happen.
  const copyProbe = useCallback(() => {
    if (!report) return;
    // The last thing between any string and Binder. `report` is already the
    // compact form, so this should never trim — it is here so the Copy button
    // is structurally incapable of crashing the app if some future section
    // grows, rather than relying on nobody letting it.
    const safe = clipboardSafe(report);
    try {
      Clipboard.setString(safe.text);
      setCopied(
        safe.truncated
          ? `Copied ${Math.round(safe.bytes / 1024)} KB (trimmed)`
          : `Copied ${Math.round(safe.bytes / 1024)} KB`,
      );
    } catch (err) {
      // Says what went wrong rather than claiming a copy that did not happen.
      setCopied(err instanceof Error ? `Copy failed: ${err.message}` : "Copy failed");
    }
    setTimeout(() => setCopied(null), 4000);
  }, [report]);

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
                  {report && (
                    <Text style={styles.probeSource}>
                      {report.split("\n").length} lines captured, including the
                      cached hub manifests. Use Copy for the whole thing.
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
                  own data directory. Copy the result — it is the full text,
                  never the abbreviated one.
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
                {report && (
                  <TouchableOpacity
                    style={styles.probeBtn}
                    onPress={copyProbe}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.probeBtnText}>{copied ?? "Copy"}</Text>
                  </TouchableOpacity>
                )}
              </View>
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
