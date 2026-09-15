// Expo config plugin for native modules: SystemActionsPackage + Vesta Widget.
// After `npx expo prebuild`, this plugin copies Kotlin files and Android resources
// into the android/ dir, registers packages, and adds the widget receiver to the manifest.

const {
  withMainApplication,
  withDangerousMod,
  withAndroidManifest,
  withAppBuildGradle,
  withGradleProperties,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Fase 6 (MCP): the native McpHttpServer uses NanoHTTPD as its HTTP transport.
// Add the dependency to the app module's build.gradle (idempotent — skipped if
// already present).
function withNanoHttpd(config) {
  return withAppBuildGradle(config, (cfg) => {
    const dep = `    implementation("org.nanohttpd:nanohttpd:2.3.1")`;
    if (!cfg.modResults.contents.includes("org.nanohttpd:nanohttpd")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        (m) => `${m}\n${dep}`,
      );
    }
    return cfg;
  });
}

// Qualcomm NPU support, off unless explicitly built in.
//
//   VESTA_ENABLE_NPU=1 npx expo prebuild --platform android --clean
//
// Two halves that must move together: the Maven dependency and the native
// bridge that references it. Neither exists in a default build, so a normal
// prebuild fetches nothing from Qualcomm and cannot fail on an SDK it never
// asked for. See docs/NPU-BACKEND.md for the licensing position — the binaries
// are resolved from Maven at build time and never committed.
function npuEnabled() {
  const flag = process.env.VESTA_ENABLE_NPU;
  return flag === "1" || flag === "true";
}

// Pinned: the native bridge is written against this exact API surface (read out
// of the AAR, not inferred), so a floating version could silently break it.
const GENIEX_VERSION = "0.4.0";

// The AAR declares minSdkVersion 27, and the manifest merger fails rather than
// warns when the app declares less. So an NPU build raises the floor — but only
// an NPU build: a default APK keeps installing on API 24 devices.
//
// It is raised through `android.minSdkVersion` in gradle.properties, NOT by
// writing into app/build.gradle's defaultConfig. Two reasons, the first of
// which already bit us:
//
//   1. The template's own defaultConfig contains `minSdkVersion
//      rootProject.ext.minSdkVersion`. An injected line lands above it, Groovy
//      takes the LAST assignment, and the override silently evaporates — which
//      is how a build that looked configured still failed the merge at 24.
//   2. This property feeds the `expoLibs` version catalog, which
//      ExpoRootProjectPlugin reads into `rootProject.ext.minSdkVersion`. Every
//      Expo and React Native library module resolves its own minSdk from that
//      same extra, so one lever moves the entire build. A per-module override
//      would leave the libraries at 24 and merge them straight back in.
//
// Raising minSdk is NOT a claim that the NPU works on API 27 — see
// docs/NPU-BACKEND.md. It is the floor at which the AAR can be linked at all;
// the backend still probes at runtime and hands back to llama.cpp on a device
// that cannot actually serve it.
const GENIEX_MIN_SDK = 27;
const MIN_SDK_PROPERTY = "android.minSdkVersion";

// Deliberately NOT `tools:overrideLibrary`. That suppresses the merge error
// without changing what gets installed, so the APK would go on claiming API 24
// and land on devices the Qualcomm runtime cannot load — trading a build
// failure for a crash in someone's hand.
//
// Runs in BOTH directions, because android/ is generated but not always
// regenerated from scratch: a non-NPU prebuild over a tree that once had the
// flag set has to take the raised floor back out, or a default build would
// quietly keep it.
function withNpuMinSdk(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === "property" && item.key === MIN_SDK_PROPERTY),
    );
    if (npuEnabled()) {
      cfg.modResults.push({
        type: "property",
        key: MIN_SDK_PROPERTY,
        value: String(GENIEX_MIN_SDK),
      });
    }
    return cfg;
  });
}

function withGenieX(config) {
  config = withNpuMinSdk(config);

  // The dependency is symmetrical for the same reason: a stale geniex line left
  // by an earlier NPU prebuild would pull the proprietary AAR into a build that
  // never asked for it, and bring the merge failure along with it. The old
  // defaultConfig override is stripped too, wherever it was left behind.
  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = cfg.modResults.contents
      .split("\n")
      .filter(
        (line) => !line.includes("geniex-android") && !line.includes("vesta-npu-minsdk"),
      )
      .join("\n");
    if (npuEnabled()) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        (m) =>
          `${m}\n    implementation("com.qualcomm.qti:geniex-android:${GENIEX_VERSION}")`,
      );
    }
    return cfg;
  });

  if (!npuEnabled()) return config;

  // Copy the bridge next to the other Kotlin sources. It lives in
  // native/android-npu/ precisely so the unconditional copy below never
  // picks it up.
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, "native/android-npu");
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/java/com/cosmico/vesta",
      );
      if (!fs.existsSync(srcDir)) {
        console.warn("[with-system-actions] VESTA_ENABLE_NPU set but native/android-npu is missing");
        return cfg;
      }
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith(".kt")) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }
      console.log(
        `[with-system-actions] NPU enabled: geniex-android:${GENIEX_VERSION} + native bridge`,
      );
      return cfg;
    },
  ]);

  return config;
}

function withSystemActions(config) {
  // Copy Kotlin source files into the generated android project
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const srcDir = path.join(
        config.modRequest.projectRoot,
        "native/android/src/main/java/com/cosmico/vesta"
      );
      const destDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java/com/cosmico/vesta"
      );

      if (!fs.existsSync(srcDir)) {
        console.warn(
          "[with-system-actions] Source directory not found:",
          srcDir
        );
        return config;
      }

      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith(".kt") || file.endsWith(".java")) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }

      // Copy Android resource files (widget layout, drawables, values, xml)
      const resSrcDir = path.join(
        config.modRequest.projectRoot,
        "native/android/src/main/res"
      );
      const resDestDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/res"
      );

      if (fs.existsSync(resSrcDir)) {
        for (const subDir of fs.readdirSync(resSrcDir)) {
          const srcSubDir = path.join(resSrcDir, subDir);
          const destSubDir = path.join(resDestDir, subDir);
          if (fs.statSync(srcSubDir).isDirectory()) {
            fs.mkdirSync(destSubDir, { recursive: true });
            for (const file of fs.readdirSync(srcSubDir)) {
              fs.copyFileSync(
                path.join(srcSubDir, file),
                path.join(destSubDir, file)
              );
            }
          }
        }
      }

      return config;
    },
  ]);

  // Register the package in MainApplication
  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;

    // Add import (if not already present)
    if (!contents.includes("import com.cosmico.vesta.SystemActionsPackage")) {
      // Try multiple import insertion patterns
      const importPatterns = [
        /(import com\.facebook\.react.*\n)/,
        /(import android\.app\.Application\n)/,
        /(^package .*\n)/m,
      ];

      let importInserted = false;
      for (const pattern of importPatterns) {
        if (pattern.test(contents)) {
          contents = contents.replace(
            pattern,
            `$1import com.cosmico.vesta.SystemActionsPackage\n`
          );
          importInserted = true;
          break;
        }
      }

      if (!importInserted) {
        console.warn(
          "[with-system-actions] Could not find import insertion point in MainApplication"
        );
      }
    }

    // Add to packages list (if not already present)
    if (!contents.includes("SystemActionsPackage()")) {
      const packagePatterns = [
        // Expo SDK 55 / RN 0.83: PackageList(this).packages.apply { ... }
        // Insert add() call inside the .apply block
        {
          pattern: /(PackageList\(this\)\.packages\.apply\s*\{)\s*\n/,
          replacement: `$1\n          add(SystemActionsPackage())\n`,
        },
        // Older pattern: packages.add(MainReactPackage())
        {
          pattern: /(packages\.add\(MainReactPackage\(\)\))/,
          replacement: `$1\n          packages.add(SystemActionsPackage())`,
        },
      ];

      let packageInserted = false;
      for (const { pattern, replacement } of packagePatterns) {
        if (pattern.test(contents)) {
          contents = contents.replace(pattern, replacement);
          packageInserted = true;
          break;
        }
      }

      if (!packageInserted) {
        console.warn(
          "[with-system-actions] Could not find package registration point in MainApplication. " +
            "You may need to manually add SystemActionsPackage() to your packages list."
        );
      }
    }

    config.modResults.contents = contents;
    return config;
  });

  // Register the Vesta Widget receiver in AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const mainApplication = config.modResults.manifest.application[0];

    if (!mainApplication.receiver) {
      mainApplication.receiver = [];
    }

    // Register widget activities (transparent overlays)
    if (!mainApplication.activity) {
      mainApplication.activity = [];
    }

    // Quick chat dialog (floating input over home screen)
    const hasQuickChat = mainApplication.activity.some(
      (a) => a.$?.["android:name"] === ".VestaQuickChatActivity"
    );
    if (!hasQuickChat) {
      mainApplication.activity.push({
        $: {
          "android:name": ".VestaQuickChatActivity",
          "android:theme": "@android:style/Theme.Translucent.NoTitleBar",
          "android:exported": "false",
          "android:excludeFromRecents": "true",
          "android:taskAffinity": "",
          "android:windowSoftInputMode": "adjustResize",
        },
      });
    }

    // Voice input activity — also Vesta's ASSISTANT entry point.
    //
    // Handling ACTION_ASSIST is what makes the package a ROLE_ASSISTANT
    // candidate: the system's role controller probes for exactly two things,
    // a VoiceInteractionService and an ACTION_ASSIST activity, and before this
    // Vesta declared neither (this activity had no intent filter at all and
    // was not exported), so it never appeared under Digital assistant app.
    //
    // ACTION_ASSIST rather than a VoiceInteractionService, deliberately — see
    // ADR-020. The short version: a VoiceInteractionService must name an
    // `android:recognitionService` in its metadata, and the platform points
    // Settings.Secure.VOICE_RECOGNITION_SERVICE at it when the assistant is
    // selected. Vesta ships no recognizer on purpose (it delegates to whatever
    // the user chose, e.g. FUTO), so it has nothing honest to name there, and
    // claiming one would risk taking dictation away from other apps. The
    // activity route also means no always-running bound service, which fits an
    // assistant that is only ever invoked explicitly.
    //
    // CATEGORY_DEFAULT is required for the bare `new Intent(ACTION_ASSIST)`
    // the system fires to resolve here; exported must be true for the system
    // to launch it at all.
    //
    // This entry is REWRITTEN rather than skipped-if-present. android/ is
    // generated but not always regenerated from scratch — a prebuild over an
    // existing directory finds the activity already there, and a
    // skip-if-present check would silently keep whatever shape it had, which
    // is precisely how a rebuild would end up without the assist filter and
    // Vesta would stay missing from the assistant list.
    const voiceActivity = {
      $: {
        "android:name": ".VestaVoiceActivity",
        "android:theme": "@android:style/Theme.Translucent.NoTitleBar",
        "android:exported": "true",
        "android:excludeFromRecents": "true",
        "android:taskAffinity": "",
      },
      "intent-filter": [
        {
          action: [
            { $: { "android:name": "android.intent.action.ASSIST" } },
            { $: { "android:name": "android.intent.action.VOICE_COMMAND" } },
          ],
          category: [
            { $: { "android:name": "android.intent.category.DEFAULT" } },
          ],
        },
      ],
    };
    const voiceIndex = mainApplication.activity.findIndex(
      (a) => a.$?.["android:name"] === ".VestaVoiceActivity"
    );
    if (voiceIndex >= 0) {
      mainApplication.activity[voiceIndex] = voiceActivity;
    } else {
      mainApplication.activity.push(voiceActivity);
    }

    const hasWidget = mainApplication.receiver.some(
      (r) => r.$?.["android:name"] === ".VestaWidgetProvider"
    );

    if (!hasWidget) {
      mainApplication.receiver.push({
        $: {
          "android:name": ".VestaWidgetProvider",
          "android:exported": "true",
          "android:label": "@string/widget_label",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.appwidget.action.APPWIDGET_UPDATE",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.appwidget.provider",
              "android:resource": "@xml/vesta_widget_info",
            },
          },
        ],
      });
    }

    // Register VestaService (foreground service) in manifest
    if (!mainApplication.service) {
      mainApplication.service = [];
    }

    const hasService = mainApplication.service.some(
      (s) => s.$?.["android:name"] === ".VestaService"
    );
    if (!hasService) {
      mainApplication.service.push({
        $: {
          "android:name": ".VestaService",
          "android:foregroundServiceType": "specialUse",
          "android:exported": "false",
        },
        property: [
          {
            $: {
              "android:name": "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
              "android:value": "Keeps AI model loaded in memory for offline inference",
            },
          },
        ],
      });
    }

    return config;
  });

  config = withNanoHttpd(config);
  config = withGenieX(config);

  return config;
}

module.exports = withSystemActions;
