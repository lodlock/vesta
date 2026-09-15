import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useModelStore, type NpuStatus } from "../lib/store/model-store";
import { CATALOG } from "../lib/models/catalog";
import { listGgufFiles, type HfFile } from "../lib/models/hf-client";
import {
  pullIdentifier,
  type NpuCatalogModel,
} from "../lib/models/npu-catalog";
import {
  breakDownHubModels,
  hubAvailability,
  hubModelLabel,
  type HubState,
  type HubAvailability,
  type CompatibleHubModel,
} from "../lib/models/npu-hub";
import type { RuntimeChipset } from "../lib/models/chipset-identity";
import { isNpuModel } from "../lib/models/npu-compat";
import type { CatalogModel, InstalledModel, ModelTrust } from "../lib/models/types";
import { formatBytes, formatDuration, percent, fitLabel, type FitLabel } from "../lib/models/format";
import { canActivate, canVerify } from "../lib/models/activation";
import { colors, spacing, radii, typography } from "../lib/theme";

export default function ModelsScreen() {
  const installed = useModelStore((s) => s.installed);
  const progress = useModelStore((s) => s.progress);
  const freeBytes = useModelStore((s) => s.freeBytes);
  const caps = useModelStore((s) => s.caps);
  const error = useModelStore((s) => s.error);
  const busy = useModelStore((s) => s.busy);
  const refresh = useModelStore((s) => s.refresh);
  const downloadFromCatalog = useModelStore((s) => s.downloadFromCatalog);
  const downloadFromRepo = useModelStore((s) => s.downloadFromRepo);
  const activate = useModelStore((s) => s.activate);
  const remove = useModelStore((s) => s.remove);
  const cancel = useModelStore((s) => s.cancel);
  const importLocalModel = useModelStore((s) => s.importLocalModel);
  const verifyIntegrity = useModelStore((s) => s.verifyIntegrity);
  const clearError = useModelStore((s) => s.clearError);
  const npu = useModelStore((s) => s.npu);
  const npuCatalog = useModelStore((s) => s.npuCatalog);
  const installNpuModel = useModelStore((s) => s.installNpuModel);
  const importNpuBundle = useModelStore((s) => s.importNpuBundle);
  const npuHub = useModelStore((s) => s.npuHub);
  const loadNpuHub = useModelStore((s) => s.loadNpuHub);
  const installHubModel = useModelStore((s) => s.installHubModel);
  const npuInstallErrors = useModelStore((s) => s.npuInstallErrors);
  const verifyNpuBundle = useModelStore((s) => s.verifyNpuBundle);
  // Optional: a SHA-256 the user has for the file they are about to import.
  // Left empty, the import still works — see importLocalModel's policy.
  const [importChecksum, setImportChecksum] = useState("");

  useEffect(() => {
    refresh();
  }, [refresh]);

  const installedByRepo = useCallback(
    (repo: string): InstalledModel | undefined =>
      installed.find((m) => m.hfRepo === repo),
    [installed],
  );

  // A bundle and a GGUF are verified against different things, so the row's
  // Verify button dispatches on the artifact rather than the two sharing one
  // handler that would have to re-derive it.
  const verify = useCallback(
    (m: InstalledModel) =>
      isNpuModel(m) ? verifyNpuBundle(m.id) : verifyIntegrity(m.id),
    [verifyIntegrity, verifyNpuBundle],
  );

  const installedNpu = useCallback(
    (modelName: string): InstalledModel | undefined =>
      installed.find((m) => m.runtimeModelName === modelName),
    [installed],
  );

  const confirmRemove = (m: InstalledModel) => {
    Alert.alert("Delete model", `Remove "${m.displayName}" and free ${formatBytes(m.sizeBytes)}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove(m.id) },
    ]);
  };

  const handleImport = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const name = asset.name ?? "";
    if (!name.endsWith(".gguf")) {
      Alert.alert("Invalid file", "Please select a .gguf model file.");
      return;
    }
    await importLocalModel(asset.uri, name, importChecksum.trim() || null);
    setImportChecksum("");
  };

  // Where Vesta's preferred model stands against the last hub answer. One
  // curated entry today, so the first is the one the card describes.
  const preferred = npuCatalog[0];
  const qwenAvailability = useMemo(
    () =>
      preferred
        ? hubAvailability(npuHub, preferred.modelName, npu.soc, npu.chipsets)
        : ({ status: "unchecked" } as HubAvailability),
    [npuHub, preferred, npu.soc, npu.chipsets],
  );

  // Always a fresh query when the user asks for one: the whole point of the
  // button is that Qualcomm's answer can have changed since last time.
  const refreshHub = useCallback(() => {
    void loadNpuHub(true);
  }, [loadNpuHub]);

  // An AI Hub bundle the user exported themselves. A .zip because that is one
  // of the three layouts the runtime accepts and the only one a file picker can
  // return — Android's picker hands back a single document, not a directory.
  const pickNpuBundle = useCallback(
    async (m: NpuCatalogModel) => {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/zip", "application/octet-stream", "*/*"],
        copyToCacheDirectory: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      await importNpuBundle(m, asset.uri);
    },
    [importNpuBundle],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.notice}>
        Browsing or downloading a model is the only time Vesta uses the network, and only when you tap. Everything else stays on your device.
      </Text>
      <View style={styles.deviceRow}>
        <Text style={styles.deviceText}>
          {caps?.deviceName ?? "Your device"}
          {caps?.totalRamMb ? ` · ${(caps.totalRamMb / 1024).toFixed(0)} GB RAM` : ""}
          {freeBytes != null ? ` · ${formatBytes(freeBytes)} free` : ""}
        </Text>
      </View>

      {error && (
        <TouchableOpacity style={styles.errorBanner} onPress={clearError} activeOpacity={0.8}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorDismiss}>Tap to dismiss</Text>
        </TouchableOpacity>
      )}

      {/* Recommended catalog */}
      <Text style={styles.sectionTitle}>Recommended</Text>
      {CATALOG.map((m) => (
        <CatalogRow
          key={m.id}
          model={m}
          installed={installedByRepo(m.hfRepo)}
          progress={progress}
          fit={fitLabel(m.minRamMb, caps?.totalRamMb ?? null, m.sizeBytesApprox, freeBytes)}
          onDownload={() => downloadFromCatalog(m)}
          onActivate={activate}
          onCancel={cancel}
          onRemove={confirmRemove}
          onVerify={verify}
        />
      ))}

      {/* Qualcomm NPU.
          A whole separate section rather than another row in Recommended, and
          the reason is not cosmetic: the two Qwen3 4B entries are the same
          model in two incompatible artifacts, and a user who cannot tell them
          apart will delete the wrong one. This section states the backend, the
          chipset and the quantization on every card, and appears at all only
          on hardware that can run it. */}
      <NpuSection
        npu={npu}
        hub={npuHub}
        availability={qwenAvailability}
        errors={npuInstallErrors}
        onCheckHub={refreshHub}
        onImport={pickNpuBundle}
        catalog={npuCatalog}
        installedFor={installedNpu}
        progress={progress}
        onInstall={installNpuModel}
        onActivate={activate}
        onCancel={cancel}
        onRemove={confirmRemove}
        onVerify={verify}
      />

      {/* Qualcomm's own catalogue. Rendered only where the runtime works,
          because a list of NPU bundles is meaningless on a device that cannot
          load one. */}
      {npu.inBuild && npu.available && (
        <HubCatalogSection
          hub={npuHub}
          soc={npu.soc}
          chipsets={npu.chipsets}
          installed={installedNpu}
          progress={progress}
          errors={npuInstallErrors}
          onRefresh={refreshHub}
          onInstall={installHubModel}
          onActivate={activate}
          onCancel={cancel}
          onRemove={confirmRemove}
        />
      )}

      {/* Installed (non-catalog, e.g. imported or ad-hoc HF) */}
      {installed.filter((m) => !CATALOG.some((c) => c.hfRepo === m.hfRepo) && !isNpuModel(m)).length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Installed</Text>
          {installed
            .filter((m) => !CATALOG.some((c) => c.hfRepo === m.hfRepo) && !isNpuModel(m))
            .map((m) => (
              <InstalledRow
                key={m.id}
                model={m}
                progress={progress[m.id]}
                onActivate={activate}
                onCancel={cancel}
                onRemove={confirmRemove}
                onVerify={verify}
              />
            ))}
        </>
      )}

      {/* Add from HuggingFace */}
      <Text style={styles.sectionTitle}>Add from HuggingFace</Text>
      <AddFromHuggingFace onDownload={downloadFromRepo} />

      {/* Import local file */}
      <Text style={styles.sectionTitle}>Import local file</Text>
      <View style={styles.card}>
        <Text style={styles.rowDesc}>
          Already have a .gguf file on your device? Import it directly — any valid
          GGUF works, including one you built or merged yourself.
        </Text>
        <TextInput
          style={[styles.hfInput, { marginTop: spacing.md }]}
          value={importChecksum}
          onChangeText={setImportChecksum}
          placeholder="Expected SHA-256 (optional)"
          placeholderTextColor={colors.textPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.rowHint}>
          Given one, the file must match it or nothing is imported. Left empty,
          Vesta hashes the file at import and remembers it, so a later change is
          detectable. A `.sha256` next to the file is picked up automatically.
        </Text>
        <TouchableOpacity
          style={[styles.btn, styles.btnOutline, { marginTop: spacing.md, alignSelf: "flex-start" }]}
          onPress={handleImport}
          disabled={busy}
          activeOpacity={0.7}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={styles.btnOutlineText}>Choose .gguf file</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function fitStyle(level: FitLabel["level"]) {
  switch (level) {
    case "ok":
      return styles.fitOk;
    case "tight":
      return styles.fitTight;
    case "insufficient":
      return styles.fitBad;
    default:
      return styles.fitUnknown;
  }
}

function ProgressBar({ written, total, etaSeconds }: { written: number; total: number; etaSeconds: number | null }) {
  const pct = percent(written, total);
  return (
    <View style={styles.progressContainer}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.progressText}>
        {formatBytes(written)} / {formatBytes(total)} · {Math.round(pct)}%
        {etaSeconds != null && etaSeconds > 0 ? ` · ${formatDuration(etaSeconds)} left` : ""}
      </Text>
    </View>
  );
}

function CatalogRow({
  model,
  installed,
  progress,
  fit,
  onDownload,
  onActivate,
  onCancel,
  onRemove,
  onVerify,
}: {
  model: CatalogModel;
  installed: InstalledModel | undefined;
  progress: Record<string, { bytesWritten: number; bytesTotal: number; etaSeconds: number | null; status: string }>;
  fit: FitLabel;
  onDownload: () => void;
  onActivate: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (m: InstalledModel) => void;
  onVerify: (m: InstalledModel) => void;
}) {
  const prog = installed ? progress[installed.id] : undefined;
  const downloading = prog?.status === "downloading";
  const activation = installed ? canActivate(installed) : null;

  return (
    <View style={[styles.card, installed?.isActive && styles.cardActive]}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>{model.displayName}</Text>
        <Text style={styles.rowMeta}>
          {model.quant} · {formatBytes(model.sizeBytesApprox)}
        </Text>
      </View>
      <Text style={styles.rowDesc}>{model.description}</Text>
      <View style={styles.fitRow}>
        {fit.text !== "" && (
          <Text style={[styles.fitBadge, fitStyle(fit.level)]}>{fit.text}</Text>
        )}
        <Text style={styles.rowHint}>
          ~{Math.round(model.minRamMb / 1024)} GB RAM · {model.license}
        </Text>
      </View>

      {installed && !downloading && (
        <Text style={styles.rowHint}>{TRUST_LABEL[installed.trust]}</Text>
      )}
      {/* Why a downloaded model can't be selected. Without this the row simply
          lost its button and the only visible difference was a trust label —
          which is not the reason, and looked like it was. */}
      {installed && !downloading && activation && !activation.ok && (
        <Text style={styles.rowError}>{activation.message}</Text>
      )}

      {downloading && prog && (
        <ProgressBar written={prog.bytesWritten} total={prog.bytesTotal} etaSeconds={prog.etaSeconds} />
      )}

      <View style={styles.btnRow}>
        {!installed && (
          <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={onDownload} activeOpacity={0.7}>
            <Text style={styles.btnPrimaryText}>Download</Text>
          </TouchableOpacity>
        )}
        {downloading && installed && (
          <TouchableOpacity style={[styles.btn, styles.btnOutline]} onPress={() => onCancel(installed.id)} activeOpacity={0.7}>
            <Text style={styles.btnOutlineText}>Cancel</Text>
          </TouchableOpacity>
        )}
        {installed && activation?.ok && !installed.isActive && (
          <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => onActivate(installed.id)} activeOpacity={0.7}>
            <Text style={styles.btnPrimaryText}>Use this model</Text>
          </TouchableOpacity>
        )}
        {installed && !downloading && canVerify(installed) && (
          <TouchableOpacity style={[styles.btn, styles.btnOutline]} onPress={() => onVerify(installed)} activeOpacity={0.7}>
            <Text style={styles.btnOutlineText}>Verify</Text>
          </TouchableOpacity>
        )}
        {installed?.isActive && (
          <View style={[styles.btn, styles.btnActive]}>
            <Text style={styles.btnActiveText}>● Active</Text>
          </View>
        )}
        {installed && !downloading && (
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => onRemove(installed)} activeOpacity={0.7}>
            <Text style={styles.btnGhostText}>Delete</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// What each trust level means, in one line, for the model card. Deliberately
// four distinct statements: "verified" against an upstream digest, "verified"
// against the user's own digest, and "this is the file you imported" are three
// different claims, and flattening them would overstate the weakest one.
const TRUST_LABEL: Record<ModelTrust, string> = {
  verified_upstream: "✓ Verified against the repository's SHA-256",
  verified_user_checksum: "✓ Verified against your SHA-256",
  user_supplied_baseline: "• Imported by you — hashed at import, not verified against a source",
  unverified: "• No checksum on record",
};

function InstalledRow({
  model,
  progress,
  onActivate,
  onCancel,
  onRemove,
  onVerify,
}: {
  model: InstalledModel;
  progress?: { bytesWritten: number; bytesTotal: number; etaSeconds: number | null; status: string };
  onActivate: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (m: InstalledModel) => void;
  onVerify: (m: InstalledModel) => void;
}) {
  const downloading = progress?.status === "downloading";
  const activation = canActivate(model);
  return (
    <View style={[styles.card, model.isActive && styles.cardActive]}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>{model.displayName}</Text>
        <Text style={styles.rowMeta}>{formatBytes(model.sizeBytes)}</Text>
      </View>
      {model.hfRepo && <Text style={styles.rowHint}>{model.hfRepo}</Text>}
      {!downloading && <Text style={styles.rowHint}>{TRUST_LABEL[model.trust]}</Text>}
      {!downloading && !activation.ok && (
        <Text style={styles.rowError}>{activation.message}</Text>
      )}

      {downloading && progress && (
        <ProgressBar written={progress.bytesWritten} total={progress.bytesTotal} etaSeconds={progress.etaSeconds} />
      )}

      <View style={styles.btnRow}>
        {downloading && (
          <TouchableOpacity style={[styles.btn, styles.btnOutline]} onPress={() => onCancel(model.id)} activeOpacity={0.7}>
            <Text style={styles.btnOutlineText}>Cancel</Text>
          </TouchableOpacity>
        )}
        {activation.ok && !model.isActive && (
          <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => onActivate(model.id)} activeOpacity={0.7}>
            <Text style={styles.btnPrimaryText}>Use this model</Text>
          </TouchableOpacity>
        )}
        {model.isActive && (
          <View style={[styles.btn, styles.btnActive]}>
            <Text style={styles.btnActiveText}>● Active</Text>
          </View>
        )}
        {!downloading && canVerify(model) && (
          <TouchableOpacity style={[styles.btn, styles.btnOutline]} onPress={() => onVerify(model)} activeOpacity={0.7}>
            <Text style={styles.btnOutlineText}>Verify</Text>
          </TouchableOpacity>
        )}
        {!downloading && (
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => onRemove(model)} activeOpacity={0.7}>
            <Text style={styles.btnGhostText}>Delete</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

/**
 * The Qualcomm NPU section.
 *
 * Shows one of three things, never a blank space:
 *   - nothing at all, on a build with no NPU bridge in it. There is no point
 *     telling a user about hardware this APK cannot reach.
 *   - a plain explanation, when the bridge is present but the runtime did not
 *     start here — including the runtime's OWN words for why, because
 *     "unavailable" is not a thing anyone can act on.
 *   - the curated entries for this exact chipset.
 */
function NpuSection({
  npu,
  hub,
  availability,
  errors,
  catalog,
  installedFor,
  progress,
  onCheckHub,
  onImport,
  onInstall,
  onActivate,
  onCancel,
  onRemove,
  onVerify,
}: {
  npu: NpuStatus;
  hub: HubState;
  availability: HubAvailability;
  errors: Record<string, string>;
  catalog: NpuCatalogModel[];
  installedFor: (modelName: string) => InstalledModel | undefined;
  progress: Record<string, { bytesWritten: number; bytesTotal: number; etaSeconds: number | null; status: string }>;
  onCheckHub: () => void;
  onImport: (m: NpuCatalogModel) => void;
  onInstall: (m: NpuCatalogModel) => void;
  onActivate: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (m: InstalledModel) => void;
  onVerify: (m: InstalledModel) => void;
}) {
  if (!npu.inBuild) return null;

  return (
    <>
      <Text style={styles.sectionTitle}>Qualcomm NPU</Text>
      {!npu.available ? (
        <View style={styles.card}>
          <Text style={styles.rowDesc}>
            This build can use the Hexagon NPU, but the runtime did not start on
            this device.
          </Text>
          {npu.reason && <Text style={styles.rowError}>{npu.reason}</Text>}
          <Text style={styles.rowHint}>
            Everything still runs on llama.cpp, exactly as before.
          </Text>
        </View>
      ) : catalog.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.rowDesc}>
            The Hexagon runtime is ready
            {npu.runtimeVersion ? ` (QAIRT ${npu.runtimeVersion})` : ""}, but
            Vesta has no NPU model compiled for{" "}
            {npu.soc ?? "this device's chipset"} yet.
          </Text>
          <Text style={styles.rowHint}>
            An NPU model is compiled ahead of time for one chipset. It is not
            slower on another — it does not run at all, which is why one is
            never offered speculatively.
          </Text>
        </View>
      ) : (
        <>
          {/* Vesta's preferred model keeps its card whatever the hub says —
              it is a recommendation, not an offer, and the hub answer only
              decides which actions on it can possibly work. */}
          {catalog.map((m) => {
          // By the PULL identifier: the registry row records whatever the
          // model manager was asked for, which is not always what the
          // catalogue lists. See npu-catalog.pullIdentifier.
          const row = installedFor(pullIdentifier(m));
          const prog = row ? progress[row.id] : undefined;
          const downloading = prog?.status === "downloading" || row?.state === "downloading";
          const activation = row ? canActivate(row) : null;
          return (
            <View key={m.id} style={[styles.card, row?.isActive && styles.cardActive]}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowTitle}>{m.displayName}</Text>
                <Text style={styles.rowMeta}>
                  {formatBytes(row && row.sizeBytes > 0 ? row.sizeBytes : m.sizeBytesApprox)}
                  {row && row.sizeBytes > 0 ? "" : " approx."}
                </Text>
              </View>
              {/* The three facts that distinguish this from the GGUF entry of
                  the same model. Spelled out on the card rather than hidden
                  behind a badge, because mixing them up is the expensive
                  mistake here. */}
              <Text style={styles.rowHint}>Backend: Qualcomm Hexagon NPU</Text>
              <Text style={styles.rowHint}>
                Target: {m.targetSoc} ({m.socName})
              </Text>
              <Text style={styles.rowHint}>
                Quantization: {m.precision ?? "as published"}
              </Text>
              <Text style={styles.rowDesc}>{m.description}</Text>
              <Text style={styles.rowHint}>
                ~{Math.round(m.minRamMb / 1024)} GB RAM · {m.license}
              </Text>

              {/* Vesta's recommendation, stated as one. It stays on the card
                  whether or not Qualcomm currently ships it. */}
              <Text style={styles.rowHint}>Vesta&rsquo;s preferred NPU model</Text>

              {row && !downloading && (
                <Text style={styles.rowHint}>{TRUST_LABEL[row.trust]}</Text>
              )}
              {row && !downloading && activation && !activation.ok && (
                <Text style={styles.rowError}>{activation.message}</Text>
              )}

              {/* The hub's verdict on THIS model, in words. `absent` carries a
                  timestamp because it is a claim about a moment, never about
                  the future — Qualcomm can publish at any time. */}
              {!row && availability.status === "absent" && (
                <Text style={styles.rowError}>
                  Not currently available from Qualcomm Hub
                  {availability.cached ? " (as of a cached check" : " (checked"}{" "}
                  {new Date(availability.checkedAt).toLocaleString()})
                </Text>
              )}
              {!row && availability.status === "unchecked" && (
                <Text style={styles.rowHint}>
                  Check the hub to see whether Qualcomm is publishing this model
                  for {m.targetSoc} right now.
                </Text>
              )}
              {errors[m.id] && <Text style={styles.rowError}>{errors[m.id]}</Text>}

              {downloading && prog && (
                <ProgressBar
                  written={prog.bytesWritten}
                  total={prog.bytesTotal}
                  etaSeconds={prog.etaSeconds}
                />
              )}
              {downloading && !prog && (
                <Text style={styles.rowHint}>Starting download…</Text>
              )}

              <View style={styles.btnRow}>
                {/* Install appears only when the hub has SAID it can work.
                    Leaving a known-doomed button active after a successful
                    check is how a user spends a progress bar to learn what the
                    app already knew. */}
                {!row && availability.status === "listed" && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={() => onInstall(m)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnPrimaryText}>Install</Text>
                  </TouchableOpacity>
                )}
                {/* Before any answer exists, checking IS the primary action. */}
                {!row && availability.status === "unchecked" && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={onCheckHub}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnPrimaryText}>Check hub</Text>
                  </TouchableOpacity>
                )}
                {!row && availability.status === "absent" && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnOutline]}
                    onPress={onCheckHub}
                    disabled={hub.checking}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnOutlineText}>Check again</Text>
                  </TouchableOpacity>
                )}
                {/* Always offered. Whether Qualcomm has published this asset is
                    not something the user should have to discover by waiting
                    for a 404, and an exported bundle needs no hub at all. */}
                {!row && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnOutline]}
                    onPress={() => onImport(m)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnOutlineText}>Import bundle</Text>
                  </TouchableOpacity>
                )}
                {row && downloading && (

                  <TouchableOpacity
                    style={[styles.btn, styles.btnOutline]}
                    onPress={() => onCancel(row.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnOutlineText}>Cancel</Text>
                  </TouchableOpacity>
                )}
                {row && activation?.ok && !row.isActive && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={() => onActivate(row.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnPrimaryText}>Use this model</Text>
                  </TouchableOpacity>
                )}
                {row?.isActive && (
                  <View style={[styles.btn, styles.btnActive]}>
                    <Text style={styles.btnActiveText}>● Active</Text>
                  </View>
                )}
                {row && !downloading && canVerify(row) && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnOutline]}
                    onPress={() => onVerify(row)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnOutlineText}>Verify</Text>
                  </TouchableOpacity>
                )}
                {row && !downloading && (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnGhost]}
                    onPress={() => onRemove(row)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnGhostText}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
          })}
        </>
      )}
    </>
  );
}

/**
 * Qualcomm's own catalogue, rendered.
 *
 * The list is NOT hard-coded and must never become so: it is whatever
 * `listHubModels()` returned, filtered to this device through the same
 * canonical chipset machinery the load-time guard uses. Qualcomm publishes and
 * unpublishes; a copy of their list kept here would be wrong on a schedule we
 * do not control, which is exactly how the Qwen card ended up promising a
 * download that could only 404.
 *
 * Only facts the PUBLIC GenieX API actually returns are shown. `HubModel`
 * carries a name, a model type and a chipset list — so there is no size and no
 * precision on these cards, because inventing either would be worse than the
 * blank space.
 */
function HubCatalogSection({
  hub,
  soc,
  chipsets,
  installed,
  progress,
  errors,
  onRefresh,
  onInstall,
  onActivate,
  onCancel,
  onRemove,
}: {
  hub: HubState;
  soc: string | null;
  chipsets: RuntimeChipset[] | undefined;
  installed: (modelName: string) => InstalledModel | undefined;
  progress: Record<string, { bytesWritten: number; bytesTotal: number; etaSeconds: number | null; status: string }>;
  errors: Record<string, string>;
  onRefresh: () => void;
  onInstall: (m: CompatibleHubModel) => void;
  onActivate: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (m: InstalledModel) => void;
}) {
  const snapshot = hub.snapshot;
  const breakdown = useMemo(
    () => (snapshot ? breakDownHubModels(snapshot.models, soc, chipsets) : null),
    [snapshot, soc, chipsets],
  );

  return (
    <>
      <View style={styles.card}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle}>Qualcomm Hub</Text>
          <Text style={styles.rowMeta}>
            {hub.checking
              ? "checking…"
              : snapshot
                ? `${snapshot.models.length} models`
                : "not checked"}
          </Text>
        </View>

        {snapshot && breakdown && (
          <Text style={styles.rowHint}>
            {breakdown.compatible.length} compatible with {soc ?? "this chipset"}
            {breakdown.otherChipsets > 0
              ? ` · ${breakdown.otherChipsets} for other chipsets`
              : ""}
            {breakdown.unsupportedType > 0
              ? ` · ${breakdown.unsupportedType} unsupported type`
              : ""}
          </Text>
        )}

        {/* The age of the answer, always. "Not listed" is a claim about a
            moment, never about the future — Qualcomm can publish at any time
            and the refresh below is how that gets noticed. */}
        {snapshot && (
          <Text style={styles.rowHint}>
            {snapshot.cached ? "Cached from " : "Checked "}
            {new Date(snapshot.checkedAt).toLocaleString()}
          </Text>
        )}

        {/* Kept beside the catalogue, not instead of it: a failed refresh must
            not cost the user the answer they already had. */}
        {hub.error && <Text style={styles.rowError}>{hub.error}</Text>}

        <TouchableOpacity
          style={[styles.btn, styles.btnOutline, { marginTop: spacing.sm }]}
          onPress={onRefresh}
          disabled={hub.checking}
          activeOpacity={0.7}
        >
          <Text style={styles.btnOutlineText}>
            {snapshot ? "Refresh hub" : "Check hub"}
          </Text>
        </TouchableOpacity>
      </View>

      {breakdown && breakdown.compatible.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.rowDesc}>
            Qualcomm&rsquo;s hub lists nothing for {soc ?? "this chipset"} right now.
          </Text>
          <Text style={styles.rowHint}>
            This changes as Qualcomm publishes. You can also import a bundle you
            exported yourself.
          </Text>
        </View>
      )}

      {breakdown?.compatible.map((m) => {
        const row = installed(m.entry.name);
        const prog = row ? progress[row.id] : undefined;
        const downloading =
          prog?.status === "downloading" || row?.state === "downloading";
        const activation = row ? canActivate(row) : null;
        const error = errors[m.entry.name];
        return (
          <View
            key={m.entry.name}
            style={[styles.card, row?.isActive && styles.cardActive]}
          >
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle}>{hubModelLabel(m.entry.name)}</Text>
              <Text style={styles.rowMeta}>
                {row && row.sizeBytes > 0 ? formatBytes(row.sizeBytes) : ""}
              </Text>
            </View>
            {/* The identifier that actually gets pulled, verbatim. The pretty
                name above is for reading; this is the fact. */}
            <Text style={styles.rowHint}>{m.entry.name}</Text>
            <Text style={styles.rowHint}>
              {m.entry.modelType} · Qualcomm Hexagon NPU
            </Text>
            {/* Both vocabularies, labelled, because they are not the same
                thing: the SoC id is what the pull and the compatibility guard
                use, the catalogue key is AI Hub's manifest metadata. */}
            <Text style={styles.rowHint}>Target: {m.canonicalSoc}</Text>
            <Text style={styles.rowHint}>
              Hub catalog key: {m.hubChipsetKey}
            </Text>
            {/* No quality ranking is offered or implied. Availability is the
                only claim the hub makes, so availability is the only claim
                repeated here. */}
            <Text style={styles.rowHint}>Available from Qualcomm Hub</Text>

            {error && <Text style={styles.rowError}>{error}</Text>}
            {row && !downloading && activation && !activation.ok && (
              <Text style={styles.rowError}>{activation.message}</Text>
            )}

            {downloading && prog && (
              <ProgressBar
                written={prog.bytesWritten}
                total={prog.bytesTotal}
                etaSeconds={prog.etaSeconds}
              />
            )}
            {downloading && !prog && (
              <Text style={styles.rowHint}>Starting download…</Text>
            )}

            <View style={styles.btnRow}>
              {!row && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary]}
                  onPress={() => onInstall(m)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.btnPrimaryText}>Install</Text>
                </TouchableOpacity>
              )}
              {row && downloading && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnOutline]}
                  onPress={() => onCancel(row.id)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.btnOutlineText}>Cancel</Text>
                </TouchableOpacity>
              )}
              {/* Activation is always the user's explicit choice. Nothing here
                  promotes a hub model over the one they are already using. */}
              {row && activation?.ok && !row.isActive && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary]}
                  onPress={() => onActivate(row.id)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.btnPrimaryText}>Use this model</Text>
                </TouchableOpacity>
              )}
              {row?.isActive && (
                <View style={[styles.btn, styles.btnActive]}>
                  <Text style={styles.btnActiveText}>● Active</Text>
                </View>
              )}
              {row && !downloading && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost]}
                  onPress={() => onRemove(row)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.btnGhostText}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })}
    </>
  );
}

function AddFromHuggingFace({
  onDownload,
}: {
  onDownload: (repo: string, file: HfFile, displayName: string) => void;
}) {
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const browse = async () => {
    const trimmed = repo.trim();
    if (!trimmed.includes("/")) {
      setErr("Enter a repo id like 'Qwen/Qwen3-4B-GGUF'.");
      return;
    }
    setLoading(true);
    setErr(null);
    setFiles(null);
    try {
      const found = await listGgufFiles(trimmed);
      if (found.length === 0) setErr("No .gguf files in this repo.");
      setFiles(found);
    } catch (e) {
      const ex = e as Error & { code?: string };
      setErr(ex.code === "GATED" ? "This repo is gated (login required) — not supported yet." : ex.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.rowDesc}>
        Paste any public HuggingFace GGUF repo to list its files and download the quant you want.
      </Text>
      <View style={styles.hfInputRow}>
        <TextInput
          style={styles.hfInput}
          value={repo}
          onChangeText={setRepo}
          placeholder="org/repo-GGUF"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={browse} disabled={loading} activeOpacity={0.7}>
          {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnPrimaryText}>Browse</Text>}
        </TouchableOpacity>
      </View>
      {err && <Text style={styles.rowError}>{err}</Text>}
      {files?.map((f) => (
        <View key={f.path} style={styles.fileRow}>
          <View style={{ flex: 1, marginRight: 10 }}>
            <Text style={styles.fileName} numberOfLines={1}>{f.path.split("/").pop()}</Text>
            <Text style={styles.fileSize}>{formatBytes(f.sizeBytes)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => onDownload(repo.trim(), f, repo.trim().split("/").pop() ?? "Model")}
            activeOpacity={0.7}
          >
            <Text style={styles.btnPrimaryText}>Download</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 48 },
  notice: { color: colors.textMuted, ...typography.caption, lineHeight: 18, marginBottom: 6 },
  deviceRow: { marginBottom: 8 },
  deviceText: { color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
  fitRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 },
  fitBadge: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.full,
    overflow: "hidden",
  },
  fitOk: { color: colors.success, backgroundColor: colors.successBg },
  fitTight: { color: colors.accent, backgroundColor: colors.accentMuted },
  fitBad: { color: colors.error, backgroundColor: colors.accentMuted },
  fitUnknown: { color: colors.textMuted },
  sectionTitle: { color: colors.textMuted, ...typography.sectionTitle, marginBottom: 10, marginTop: 20, marginLeft: 4 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: 12,
  },
  cardActive: { borderColor: colors.success, borderWidth: 1 },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "600", flex: 1, marginRight: 8 },
  rowMeta: { color: colors.textMuted, fontSize: 12 },
  rowDesc: { color: colors.textSecondary, ...typography.bodySmall, lineHeight: 19, marginTop: 6 },
  rowHint: { color: colors.textMuted, fontSize: 12, marginTop: 6 },
  rowError: { color: colors.error, fontSize: 13, marginTop: 8 },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 14, flexWrap: "wrap" },
  btn: { borderRadius: radii.sm, paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { color: "#fff", ...typography.button },
  btnOutline: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.accent },
  btnOutlineText: { color: colors.accent, ...typography.button },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.error },
  btnGhostText: { color: colors.error, ...typography.button },
  btnActive: { backgroundColor: colors.successBg },
  btnActiveText: { color: colors.success, ...typography.button },
  progressContainer: { marginTop: 14 },
  progressTrack: { height: 4, backgroundColor: colors.borderLight, borderRadius: 2, overflow: "hidden", marginBottom: 8 },
  progressFill: { height: "100%", backgroundColor: colors.accent, borderRadius: 2 },
  progressText: { color: colors.textMuted, fontSize: 12 },
  hfInputRow: { flexDirection: "row", gap: 10, marginTop: spacing.md, alignItems: "center" },
  hfInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 14,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    marginTop: 10,
  },
  fileName: { color: colors.textPrimary, fontSize: 13, fontWeight: "500" },
  fileSize: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  errorBanner: {
    backgroundColor: colors.accentMuted,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: 12,
  },
  errorText: { color: colors.error, fontSize: 13, fontWeight: "500" },
  errorDismiss: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
});
