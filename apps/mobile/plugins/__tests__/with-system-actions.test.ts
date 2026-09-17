// The manifest half of with-system-actions, in particular the assistant entry.
//
// This is the exact thing that was wrong: without an ACTION_ASSIST activity
// (or a VoiceInteractionService) the package is not a ROLE_ASSISTANT candidate
// and never appears under Digital assistant app. It is also invisible — the
// build succeeds, the app runs, and only the absence in a Settings list tells
// you. So the filter is asserted here rather than trusted.

/* eslint-disable @typescript-eslint/no-require-imports */

type Mod = (config: { modResults: { manifest: Manifest } }) => {
  modResults: { manifest: Manifest };
};

interface Attrs {
  [key: string]: string | undefined;
}
interface Node {
  $: Attrs;
  "intent-filter"?: { action?: { $: Attrs }[]; category?: { $: Attrs }[] }[];
  "meta-data"?: { $: Attrs }[];
}
interface Manifest {
  $?: Attrs;
  application: {
    activity?: Node[];
    service?: Node[];
    receiver?: Node[];
    provider?: Node[];
  }[];
}

const manifestMods: Mod[] = [];

jest.mock("expo/config-plugins", () => ({
  withMainApplication: (config: unknown) => config,
  withDangerousMod: (config: unknown) => config,
  withAppBuildGradle: (config: unknown) => config,
  withGradleProperties: (config: unknown) => config,
  withAndroidManifest: (config: unknown, mod: Mod) => {
    manifestMods.push(mod);
    return config;
  },
}));

function runPlugin(manifest: Manifest): Manifest {
  manifestMods.length = 0;
  const withSystemActions = require("../with-system-actions");
  withSystemActions({});
  const config = { modResults: { manifest } };
  for (const mod of manifestMods) mod(config);
  return config.modResults.manifest;
}

const emptyManifest = (): Manifest => ({ application: [{}] });

function voiceActivity(manifest: Manifest): Node | undefined {
  return manifest.application[0].activity?.find(
    (a) => a.$["android:name"] === ".VestaVoiceActivity",
  );
}

describe("assistant eligibility", () => {
  it("declares VestaVoiceActivity as an ACTION_ASSIST handler", () => {
    const activity = voiceActivity(runPlugin(emptyManifest()));

    expect(activity).toBeDefined();
    // Exported, or the system cannot launch it for the assistant gesture.
    expect(activity!.$["android:exported"]).toBe("true");

    const filter = activity!["intent-filter"]?.[0];
    const actions = filter?.action?.map((a) => a.$["android:name"]);
    expect(actions).toContain("android.intent.action.ASSIST");
    expect(actions).toContain("android.intent.action.VOICE_COMMAND");
    // DEFAULT, or the bare `new Intent(ACTION_ASSIST)` the system fires will
    // not resolve here.
    expect(filter?.category?.map((c) => c.$["android:name"])).toContain(
      "android.intent.category.DEFAULT",
    );
  });

  it("REWRITES a pre-existing entry instead of leaving it alone", () => {
    // android/ is generated but not always regenerated from scratch. A
    // skip-if-present check would keep this stale shape, and the rebuilt APK
    // would quietly go on missing from the assistant list.
    const stale = emptyManifest();
    stale.application[0].activity = [
      {
        $: {
          "android:name": ".VestaVoiceActivity",
          "android:exported": "false",
        },
      },
    ];

    const activity = voiceActivity(runPlugin(stale));

    expect(activity!.$["android:exported"]).toBe("true");
    expect(activity!["intent-filter"]).toHaveLength(1);
    // And only one of it.
    expect(
      runPlugin(stale).application[0].activity!.filter(
        (a) => a.$["android:name"] === ".VestaVoiceActivity",
      ),
    ).toHaveLength(1);
  });

  it("leaves the other components alone", () => {
    const manifest = runPlugin(emptyManifest());
    const names = (manifest.application[0].activity ?? []).map(
      (a) => a.$["android:name"],
    );
    expect(names).toContain(".VestaQuickChatActivity");
    expect(manifest.application[0].service?.[0].$["android:name"]).toBe(".VestaService");
    expect(manifest.application[0].receiver?.[0].$["android:name"]).toBe(
      ".VestaWidgetProvider",
    );
  });

  it("adds no permissions — an ACTION_ASSIST assistant needs none, and neither does sharing", () => {
    // BIND_VOICE_INTERACTION would be required for a VoiceInteractionService;
    // this route needs nothing, which is what keeps a scheduling-only build
    // scheduling-only.
    const manifest = runPlugin(emptyManifest());
    expect((manifest as { "uses-permission"?: unknown[] })["uses-permission"]).toBeUndefined();
  });
});

// The diagnostics report leaves the device as a file through the share sheet,
// which needs a content:// URI, which needs a provider. Without this element
// the app builds, runs, and throws IllegalArgumentException the first time
// anyone taps Share full report — another failure that only shows up on device.
describe("the diagnostics FileProvider", () => {
  const AUTHORITY = "${applicationId}.fileprovider";

  function fileProvider(manifest: Manifest): Node | undefined {
    return manifest.application[0].provider?.find(
      (p) => p.$["android:authorities"] === AUTHORITY,
    );
  }

  it("is declared, with its own authority", () => {
    const provider = fileProvider(runPlugin(emptyManifest()));
    expect(provider).toBeDefined();
    expect(provider!.$["android:name"]).toBe("androidx.core.content.FileProvider");
  });

  // The required pairing. exported=true would let any app query the provider
  // directly; grantUriPermissions=false would make the read grant on the
  // ACTION_SEND intent a no-op and the recipient would get a
  // SecurityException instead of the report.
  it("is unexported and grants per-URI permission", () => {
    const provider = fileProvider(runPlugin(emptyManifest()))!;
    expect(provider.$["android:exported"]).toBe("false");
    expect(provider.$["android:grantUriPermissions"]).toBe("true");
  });

  // Vesta's own paths file, NOT expo-file-system's — that one declares
  // <files-path path="."> and <cache-path path=".">, i.e. the whole of private
  // storage, models and database included. Ours names one cache subdirectory.
  it("points at Vesta's own paths file", () => {
    const provider = fileProvider(runPlugin(emptyManifest()))!;
    const meta = provider["meta-data"]?.[0];
    expect(meta?.$["android:name"]).toBe("android.support.FILE_PROVIDER_PATHS");
    expect(meta?.$["android:resource"]).toBe("@xml/vesta_file_paths");
  });

  it("does not disturb expo-file-system's provider", () => {
    const existing = emptyManifest();
    existing.application[0].provider = [
      {
        $: {
          "android:name": ".FileSystemFileProvider",
          "android:authorities": "${applicationId}.FileSystemFileProvider",
        },
      },
    ];
    const manifest = runPlugin(existing);
    expect(manifest.application[0].provider).toHaveLength(2);
    expect(fileProvider(manifest)).toBeDefined();
  });

  it("REWRITES a stale entry rather than keeping it", () => {
    const stale = emptyManifest();
    stale.application[0].provider = [
      {
        $: {
          "android:name": "androidx.core.content.FileProvider",
          "android:authorities": AUTHORITY,
          "android:exported": "true",
          "android:grantUriPermissions": "false",
        },
      },
    ];
    const provider = fileProvider(runPlugin(stale))!;
    expect(provider.$["android:exported"]).toBe("false");
    expect(provider.$["android:grantUriPermissions"]).toBe("true");
    expect(runPlugin(stale).application[0].provider).toHaveLength(1);
  });
});
