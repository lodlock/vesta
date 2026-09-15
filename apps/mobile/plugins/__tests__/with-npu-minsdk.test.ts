// The build floor for an NPU build, and the fact that a default build doesn't
// have one.
//
// This is worth asserting rather than eyeballing because the first attempt
// LOOKED right and wasn't: the plugin wrote `minSdkVersion 27` into
// defaultConfig, the template's own `minSdkVersion rootProject.ext.minSdkVersion`
// followed it, Groovy took the last assignment, and the merge still failed at
// 24. Nothing in the generated file was obviously wrong — you had to know that
// two assignments were fighting. So these tests check the lever that actually
// moves (the gradle property) and check that the dead override is gone.

/* eslint-disable @typescript-eslint/no-require-imports */

interface GradleProperty {
  type: string;
  key?: string;
  value?: string;
}

type PropsMod = (cfg: { modResults: GradleProperty[] }) => {
  modResults: GradleProperty[];
};
type GradleMod = (cfg: { modResults: { contents: string } }) => {
  modResults: { contents: string };
};

const propsMods: PropsMod[] = [];
const gradleMods: GradleMod[] = [];

jest.mock("expo/config-plugins", () => ({
  withMainApplication: (config: unknown) => config,
  withDangerousMod: (config: unknown) => config,
  withAndroidManifest: (config: unknown) => config,
  withAppBuildGradle: (config: unknown, mod: GradleMod) => {
    gradleMods.push(mod);
    return config;
  },
  withGradleProperties: (config: unknown, mod: PropsMod) => {
    propsMods.push(mod);
    return config;
  },
}));

// The shape the Expo template actually generates. The second assignment is the
// whole reason the first fix failed, so it has to be here.
const TEMPLATE_BUILD_GRADLE = `android {
    namespace 'com.cosmico.vesta'
    defaultConfig {
        applicationId 'com.cosmico.vesta'
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

// gradle.properties as prebuild writes it, parsed into the shape the mod sees.
const TEMPLATE_PROPERTIES = (): GradleProperty[] => [
  { type: "property", key: "android.useAndroidX", value: "true" },
  { type: "property", key: "newArchEnabled", value: "true" },
  // Both of these ARE in the Expo template, with these exact values. That is
  // why the plugin edits them in place and restores them, rather than adding
  // and deleting them the way it does with android.minSdkVersion.
  {
    type: "property",
    key: "reactNativeArchitectures",
    value: "armeabi-v7a,arm64-v8a,x86,x86_64",
  },
  { type: "property", key: "expo.useLegacyPackaging", value: "false" },
];

interface PrebuildResult {
  properties: GradleProperty[];
  buildGradle: string;
}

/** Runs the plugin the way prebuild would, with the env of a given build. */
function prebuild(
  env: Record<string, string | undefined>,
  seed: { properties?: GradleProperty[]; buildGradle?: string } = {},
): PrebuildResult {
  const saved = process.env.VESTA_ENABLE_NPU;
  if (env.VESTA_ENABLE_NPU === undefined) delete process.env.VESTA_ENABLE_NPU;
  else process.env.VESTA_ENABLE_NPU = env.VESTA_ENABLE_NPU;

  try {
    propsMods.length = 0;
    gradleMods.length = 0;
    jest.resetModules();
    const withSystemActions = require("../with-system-actions");
    withSystemActions({});

    let properties = seed.properties ?? TEMPLATE_PROPERTIES();
    for (const mod of propsMods) properties = mod({ modResults: properties }).modResults;

    let contents = seed.buildGradle ?? TEMPLATE_BUILD_GRADLE;
    for (const mod of gradleMods) contents = mod({ modResults: { contents } }).modResults.contents;

    return { properties, buildGradle: contents };
  } finally {
    if (saved === undefined) delete process.env.VESTA_ENABLE_NPU;
    else process.env.VESTA_ENABLE_NPU = saved;
  }
}

/**
 * The minSdk the build will actually use.
 *
 * `android.minSdkVersion` feeds the expoLibs version catalog, which
 * ExpoRootProjectPlugin turns into `rootProject.ext.minSdkVersion`; absent it,
 * that plugin's own default of 24 stands. Every module resolves from there, so
 * this one property is the effective floor for the app AND every library.
 */
function effectiveMinSdk(result: PrebuildResult): number {
  const property = result.properties.find(
    (p) => p.type === "property" && p.key === "android.minSdkVersion",
  );
  return property ? Number(property.value) : 24;
}

describe("a default build stays installable on API 24", () => {
  const result = () => prebuild({ VESTA_ENABLE_NPU: undefined });

  it("declares minSdk 24", () => {
    expect(effectiveMinSdk(result())).toBe(24);
  });

  it("pulls in no Qualcomm dependency", () => {
    // The flag is the only thing that may ever reach Maven for a proprietary
    // AAR; a build that never opted in must not resolve one.
    expect(result().buildGradle).not.toContain("geniex-android");
    expect(result().buildGradle).not.toMatch(/qualcomm/i);
  });

  it("takes the floor back out after an earlier NPU prebuild", () => {
    // android/ is generated but not always regenerated from scratch, so the
    // leftovers of a previous `VESTA_ENABLE_NPU=1` run are the realistic
    // starting state — and a default build must not inherit them.
    const stale = prebuild(
      { VESTA_ENABLE_NPU: undefined },
      {
        properties: [
          ...TEMPLATE_PROPERTIES(),
          { type: "property", key: "android.minSdkVersion", value: "27" },
        ],
        buildGradle: TEMPLATE_BUILD_GRADLE.replace(
          "dependencies {",
          'dependencies {\n    implementation("com.qualcomm.qti:geniex-android:0.4.0")',
        ),
      },
    );

    expect(effectiveMinSdk(stale)).toBe(24);
    expect(stale.buildGradle).not.toContain("geniex-android");
  });
});

describe("an NPU build raises the floor to the AAR's own", () => {
  const result = () => prebuild({ VESTA_ENABLE_NPU: "1" });

  it("declares minSdk 27", () => {
    expect(effectiveMinSdk(result())).toBe(27);
  });

  it("sets it once, not once per prebuild", () => {
    const matching = result().properties.filter((p) => p.key === "android.minSdkVersion");
    expect(matching).toHaveLength(1);
  });

  it("raises it where the whole build reads it, not inside defaultConfig", () => {
    // The failed first attempt, asserted directly: a line in defaultConfig is
    // overwritten by the template's next line, so there must not be one.
    const gradle = result().buildGradle;
    expect(gradle).not.toMatch(/defaultConfig\s*\{\s*\n\s*minSdkVersion\s+27/);
    expect(gradle).not.toContain("vesta-npu-minsdk");
    expect(gradle).toContain("minSdkVersion rootProject.ext.minSdkVersion");
  });

  it("pulls in GenieX", () => {
    expect(result().buildGradle).toContain(
      'implementation("com.qualcomm.qti:geniex-android:0.4.0")',
    );
  });

  it("pulls it in once, even over a tree that already had it", () => {
    const repeated = prebuild(
      { VESTA_ENABLE_NPU: "1" },
      {
        buildGradle: TEMPLATE_BUILD_GRADLE.replace(
          "dependencies {",
          'dependencies {\n    implementation("com.qualcomm.qti:geniex-android:0.4.0")',
        ),
      },
    );
    const occurrences = repeated.buildGradle.split("geniex-android").length - 1;
    expect(occurrences).toBe(1);
  });

  it("accepts VESTA_ENABLE_NPU=true as well as 1", () => {
    expect(effectiveMinSdk(prebuild({ VESTA_ENABLE_NPU: "true" }))).toBe(27);
    // ...and nothing else. A typo must fail closed, not half-enable a build.
    expect(effectiveMinSdk(prebuild({ VESTA_ENABLE_NPU: "yes" }))).toBe(24);
    expect(prebuild({ VESTA_ENABLE_NPU: "0" }).buildGradle).not.toContain("geniex");
  });
});

describe("the merge error is fixed, not silenced", () => {
  it("never adds tools:overrideLibrary", () => {
    // It would suppress the error without changing what ships: the APK would go
    // on declaring API 24 and install on devices the Qualcomm runtime cannot
    // load. A build failure traded for a crash in someone's hand.
    for (const flag of [undefined, "1"]) {
      const built = prebuild({ VESTA_ENABLE_NPU: flag });
      expect(built.buildGradle).not.toContain("overrideLibrary");
      expect(JSON.stringify(built.properties)).not.toContain("overrideLibrary");
    }
  });

  it("does not disable the manifest merger or its checks", () => {
    const built = prebuild({ VESTA_ENABLE_NPU: "1" });
    const text = built.buildGradle + JSON.stringify(built.properties);
    expect(text).not.toMatch(/overrideLibrary|disableResourceValidation/);
    expect(text).not.toMatch(/android\.injected\.build\.abi|manifestmerger.*false/i);
  });
});

/**
 * The other two things an NPU build has to change, and a default build must not
 * inherit: the ABI list and native-library extraction.
 *
 * Both are here because each was a silent failure the first time. A build
 * without the ABI restriction produces armeabi-v7a and x86_64 outputs carrying
 * every library except the Qualcomm one. A build without legacy packaging
 * produces an APK that ships all 206 MB of the Qualcomm runtime and then cannot
 * register a single plugin, because GenieXSdk.init looks its plugins up as
 * FILES in ApplicationInfo.nativeLibraryDir and unextracted libraries are not
 * files.
 */
function property(result: PrebuildResult, key: string): string | undefined {
  return result.properties.find((p) => p.type === "property" && p.key === key)?.value;
}

/** How many times a key appears. Two of anything here is a silent bug. */
function occurrences(result: PrebuildResult, key: string): number {
  return result.properties.filter((p) => p.type === "property" && p.key === key).length;
}

describe("an NPU build is arm64-only", () => {
  it("restricts the architectures", () => {
    expect(property(prebuild({ VESTA_ENABLE_NPU: "1" }), "reactNativeArchitectures")).toBe(
      "arm64-v8a",
    );
  });

  it("restores the template's list for a default build", () => {
    // Restored, not deleted. The property is part of the template, and a build
    // that found it missing would fall back to react.gradle's own default
    // rather than to what the template says.
    expect(
      property(prebuild({ VESTA_ENABLE_NPU: undefined }), "reactNativeArchitectures"),
    ).toBe("armeabi-v7a,arm64-v8a,x86,x86_64");
  });

  it("takes the restriction back out after an NPU prebuild", () => {
    const stale = prebuild(
      { VESTA_ENABLE_NPU: undefined },
      {
        properties: TEMPLATE_PROPERTIES().map((p) =>
          p.key === "reactNativeArchitectures" ? { ...p, value: "arm64-v8a" } : p,
        ),
      },
    );
    expect(property(stale, "reactNativeArchitectures")).toBe(
      "armeabi-v7a,arm64-v8a,x86,x86_64",
    );
  });

  it("edits the property in place rather than appending a second one", () => {
    // Two assignments of the same key is the failure mode the minSdk fix
    // already ran into once, in a different file.
    expect(occurrences(prebuild({ VESTA_ENABLE_NPU: "1" }), "reactNativeArchitectures")).toBe(1);
    expect(
      occurrences(prebuild({ VESTA_ENABLE_NPU: undefined }), "reactNativeArchitectures"),
    ).toBe(1);
  });
});

describe("an NPU build extracts its native libraries", () => {
  it("turns legacy packaging on", () => {
    expect(
      property(prebuild({ VESTA_ENABLE_NPU: "1" }), "expo.useLegacyPackaging"),
    ).toBe("true");
  });

  it("uses the template's own switch rather than a second packaging block", () => {
    // app/build.gradle already contains
    //   packagingOptions { jniLibs { useLegacyPackaging <this property> } }
    // Injecting another one would leave two blocks that can disagree, and a
    // nested block is not something a regex can reliably take back out.
    const gradle = prebuild({ VESTA_ENABLE_NPU: "1" }).buildGradle;
    expect(gradle).not.toContain("packagingOptions");
    expect(gradle).not.toContain("useLegacyPackaging");
  });

  it("turns it back off for a default build", () => {
    expect(
      property(prebuild({ VESTA_ENABLE_NPU: undefined }), "expo.useLegacyPackaging"),
    ).toBe("false");
  });

  it("turns it back off over a tree that had it on", () => {
    const stale = prebuild(
      { VESTA_ENABLE_NPU: undefined },
      {
        properties: TEMPLATE_PROPERTIES().map((p) =>
          p.key === "expo.useLegacyPackaging" ? { ...p, value: "true" } : p,
        ),
      },
    );
    expect(property(stale, "expo.useLegacyPackaging")).toBe("false");
  });
});
