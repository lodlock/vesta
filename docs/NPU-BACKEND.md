# Qualcomm NPU backend — decision, licensing, and setup

Vesta runs GGUF models on llama.cpp on the CPU. On a Snapdragon 8 Elite Gen 5
that means a ~20–30s cold load for Qwen3 4B, because the weights are being read
and prepared for the wrong processor. This document records what was checked
before adding a second backend that uses the Hexagon NPU, and what a developer
has to do to enable it.

Everything below was read from primary sources — license PDFs, Maven POMs,
Qualcomm's own docs — not from memory. Where something could not be verified it
says so. **None of this is legal advice**; it is a record of what the documents
say, for a human to make a decision with.

---

## 1. Licensing gate

### Which licence governs what

Three separate licences meet in an NPU build, and they are not
interchangeable. Vesta's own licence covers none of the other two.

| Component | How it arrives | Licence | Committed here? |
| --- | --- | --- | --- |
| Vesta itself (all source in this repo) | this repository | **MIT** — see [LICENSE](../LICENSE) | yes, it *is* the repo |
| `com.qualcomm.qti:geniex-android:0.4.0` — the SDK, the QAIRT plugin, `libQnnHtp*`, the Hexagon skels | Gradle → Maven Central, at build time | dual, as declared in the artifact's own POM: **BSD-3-Clause** (<https://github.com/qualcomm/geniex/blob/main/LICENSE>) **and Qualcomm Terms of Use** (<https://www.qualcomm.com/site/terms-of-use>) | **no** |
| The Qwen3-4B-Instruct-2507 weights, as an AI Hub `geniex_qairt` bundle | GenieX model manager, on device, at install time | **Apache-2.0** — the model's own licence (<https://www.apache.org/licenses/LICENSE-2.0>), which is what Qualcomm's FAQ says the deployed assets inherit | **no** |
| Qualcomm AI Hub itself (only if you export a bundle yourself) | `qai-hub` CLI on a Linux/macOS host | Qualcomm AI Hub Model License / *Terms and Conditions of Use, AI Model & Software License* (QuIC) | **no**, and neither is the token |

`geniex-android` is the **only** Qualcomm coordinate the build declares
(`plugins/with-system-actions.js`). Its POM lists no dependencies, and
unzipping the AAR confirms why: the QNN natives are inside it —
`jni/arm64-v8a/` carries `libQnnHtp.so`, `libQnnHtpV79.so`, `libQnnHtpV81.so`,
their skels and stubs, `libQnnSystem.so`, `libgeniex_plugin_qairt.so` and
`libggml-hexagon.so`. There is no separate `qnn-runtime` artifact to resolve.

**Vesta's MIT licence does not extend to any of this.** Integrating with a
proprietary binary does not relicense it: the GenieX AAR stays under Qualcomm's
terms, the model weights stay under Apache-2.0, and neither becomes an MIT
work because Vesta calls into it. Qualcomm says the same from the other side —
§9 of the AI Hub Model License states *"any Software provided to You is NOT A
CONTRIBUTION to any open source project"*.

**None of this is legal advice.** It is a record of what these documents say,
read from the POM, the licence pages and the AAR itself.

### The AI Hub model licence, in detail

`com.qualcomm.qti:qnn-runtime` on Maven Central declares the **Qualcomm AI Hub
Model License** — formally *"Terms and Conditions of Use, AI Model & Software
License"* from Qualcomm Innovation Center (QuIC). The operative grant, §1:

> Subject to and conditioned upon Your compliance with the terms and conditions
> of this Agreement, QuIC grants to You a non-exclusive, non-transferable,
> revocable, limited royalty-and-fee-free license … to (i) use and copy the
> Software solely to develop Your software applications; … **(iv) distribute and
> sublicense the Software solely in object code format and as incorporated in
> Your software application**, and (v) use the Software for benchmarking
> purposes … **For the avoidance of doubt, nothing herein grants You a license
> to distribute or sublicense the Software on a standalone basis.**

So, against the questions that had to be answered:

| Question | Answer |
|---|---|
| May a third-party Android APK redistribute the runtime? | **Yes** — §1(iv), in object code, incorporated in the application. |
| Are the Maven-delivered artifacts redistributable in an APK/AAB? | **Yes**, same clause. The AAR *is* the object-code delivery. |
| Is accepting the SDK license sufficient? | Yes — acceptance is by downloading/using; no separate agreement is referenced for this grant. |
| Does AI Hub restrict distributing generated context binaries? | No, for our case. Qualcomm's FAQ: *"the deployed assets you get out of AI Hub typically have the same distribution license as your model. If it's your own IP then the model is yours to distribute."* Qwen3-4B-Instruct-2507 is Apache-2.0. A **free Qualcomm MyAccount is required** to use AI Hub. |
| Can this ship as an open-source application? | **Yes, with a boundary.** Vesta stays MIT. The Qualcomm binaries never become part of it: §9 states *"any Software provided to You is NOT A CONTRIBUTION to any open source project"*, and §1 forbids standalone redistribution. |
| Must any Qualcomm binary stay out of this repository? | **Yes.** Committing the `.aar`/`.so` would be standalone redistribution, and would also fold proprietary code into an MIT repo. Gradle resolves it from Maven Central at build time instead — it enters the APK, never the git history. |

Other obligations that shape the design: no reverse engineering (§2a); **do not
remove or alter proprietary notices** (§2b); the licence is **revocable and
terminates automatically on breach** (§7); everything is AS-IS with liability
capped at $100 (§5, §6).

On §2b specifically: `geniex-android:0.4.0` ships **no** `NOTICE` or `LICENSE`
file — its `META-INF/` contains only `aar-metadata.properties`, and the
`classes.jar` only a Kotlin module file. So there is no notice file to preserve
into the APK; what §2b protects is whatever notices the binaries themselves
carry, and nothing in this build strips or rewrites them. If a later SDK version
adds a notice file, packaging must keep it.

**Verdict: not blocked.** Redistribution inside the application is expressly
granted. The binaries are pulled at build time and are never committed.

### The GenieX SDK itself

`com.qualcomm.qti:geniex-android` (0.4.0 at the time of writing) declares **two**
licences: BSD-3-Clause (the SDK source, which is on GitHub) and Qualcomm's Terms
of Use. The BSD half is unproblematic; the Qualcomm half is the same shape as
above. The AAR is the object-code delivery the grant contemplates.

### What could not be verified

- ~~Whether the `geniex-android` AAR bundles the QNN runtime or resolves it as a
  separate dependency.~~ **Answered: bundled.** The POM declares no
  dependencies and the AAR's `jni/arm64-v8a/` carries the QNN libraries, the
  Hexagon V79/V81 skels and stubs, and both GenieX plugins. One coordinate
  delivers everything.
- ~~Whether Qualcomm publishes a precompiled **Qwen3-4B-Instruct-2507** bundle
  for SM8850 specifically.~~ **Answered: yes.** Qualcomm's own Android sample
  lists `ai-hub-models/Qwen3-4B-Instruct-2507` with runtime `qairt`, and the
  GenieX README uses `geniex pull ai-hub-models/Qwen3-4B-Instruct-2507` as an
  example. The chipset is passed as a parameter, so the same entry serves
  SM8750 and SM8850. See §5.
- ~~Whether the AI Hub release manifest carries an **SM8850** asset for this
  model.~~ **Answered: yes.** `qai-hub-models`' own
  `src/qai_hub_models/models/qwen3_4b_instruct_2507/release-assets.yaml` lists,
  under `precisions.w4a16.chipset_assets`, a `qualcomm-snapdragon-8-elite-gen5`
  entry with a **`geniex_qairt`** asset built with QAIRT `2.45.0` — that is
  exactly this chip, this precision and this runtime. (It also lists a `q4_0`
  GGUF for the llama.cpp path, which is not what we want.)
- Whether that asset is **reachable right now**. Its `s3_key` in every released
  tag still points under `pre_release_assets/`, and every URL shape tried from
  outside returns S3 `403` — which is S3's answer for both "not public" and "no
  such key", so it proves nothing either way. Only the device can settle it, and
  the runtime answers precisely: `chipset <X> not available for this model;
  supported: …`. §5 says what to do if it does.

---

## 2. Runtime choice

**Qualcomm GenieX** (`com.qualcomm.qti:geniex-android`), over the alternatives:

| Candidate | Verdict |
|---|---|
| **GenieX** ✅ | Kotlin SDK on Maven Central — an integration route meant for third-party apps, not a CLI runner. Android support explicitly lists **Snapdragon 8 Elite Gen 5 (SM8850)**. Accepts both AI Hub precompiled bundles and GGUF. Exposes what this app needs: streaming generation, cancellation, and a chat template call with an `enableThinking` flag that maps straight onto assist mode's reasoning suppression. |
| ExecuTorch QNN | Backend docs verify SM8550/SM8450 and do not list SM8850. Wants a Linux host, QNN SDK 2.37, NDK 26c, AOT `.pte` export and hand-managed `.so` redistribution with `ADSP_LIBRARY_PATH`. More moving parts, less current hardware coverage. |
| llama.cpp Hexagon | Still **experimental** upstream, with an open garbled-output issue on **SM8850 / Hexagon v81** specifically, and a 3.5 GB per-session address-space limit. It would be the most elegant fit — same runtime, same GGUF — and is worth re-checking later. Not a base to build on today. |

### Artifact format

Two paths, and the difference matters:

- **AI Hub precompiled bundle** — quantized **w4a16** (int4 weights, int16
  activations), compiled for one SoC family. This is the true NPU path.
- **GGUF** — GenieX also accepts GGUF, and Qualcomm's guidance is *"stick with
  `Q4_0` if you want the model to land on the Hexagon NPU"*.

A bundle is **not portable**: one built for SM8850 is not slower elsewhere, it
is unusable. That is why NPU models carry a target SoC in their metadata and are
refused on anything else, and why this backend can never be a drop-in for
"bring your own GGUF" — which remains llama.cpp's job, on every device.

---

## 3. Architecture

```
ModelBackend  (lib/llm/backends)
├── LlamaCppBackend      GGUF, any device, the universal fallback
└── QualcommNpuBackend   AI Hub bundle, SM8850-class only, opt-in
```

Selection is first-match-wins with llama.cpp last, and a backend answers for
itself whether it can run a given artifact **on this device**. A model whose
target SoC does not match the phone is refused, not degraded — and the
diagnostics screen names the backend that actually produced an answer, so "NPU"
is never claimed for something CPU did.

---

## 4. Setup (what a developer must do)

### Requirements at a glance

Qualcomm NPU support is **optional and off by default**. A default build
contains no GenieX, no QAIRT and no Qualcomm dependency of any kind, reports the
NPU unavailable, and runs every model on llama.cpp.

| | Default build | `VESTA_ENABLE_NPU=1` |
| --- | --- | --- |
| Qualcomm dependency | none | `com.qualcomm.qti:geniex-android:0.4.0`, from Maven Central |
| Android `minSdk` | 24 | **27** (Android 8.1) |
| ABIs | `armeabi-v7a, arm64-v8a, x86, x86_64` | **`arm64-v8a` only** |
| Hardware | anything | a compatible Qualcomm SoC with a Hexagon NPU |
| Model format | GGUF | GGUF **and** AI Hub `geniex_qairt` bundles |

**Current validated development target: SM8850 / Snapdragon 8 Elite Gen 5**,
tested on a OnePlus 15. That is the only chipset the curated NPU catalog carries
an entry for. Other Snapdragon parts may work once a bundle exists for them —
the compatibility guard refuses rather than guessing, so an unsupported chip
gets a clear refusal instead of a multi-gigabyte download it cannot run.


The NPU backend is **off unless you build it in**, following the same
opt-in shape as the scheduling-only profile and the release signing config:

```bash
# Default build — unchanged, no Qualcomm dependency, NPU reports unavailable
npx expo prebuild --platform android --clean

# NPU-enabled build
VESTA_ENABLE_NPU=1 npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

With the flag set, the config plugin adds the Maven dependency, copies the
native bridge, and changes exactly three gradle properties. Without it, none of
that exists, so a default build cannot break on a Qualcomm SDK it never fetched.

### What the flag changes

| Property | Default build | `VESTA_ENABLE_NPU=1` | Why |
| --- | --- | --- | --- |
| `android.minSdkVersion` | *(absent → 24)* | **27** | The AAR's own manifest floor; the merger errors, not warns, below it. |
| `reactNativeArchitectures` | `armeabi-v7a,arm64-v8a,x86,x86_64` | **`arm64-v8a`** | The AAR ships arm64 natives and no others. |
| `expo.useLegacyPackaging` | `false` | **`true`** | The libraries must be extracted as files. See below. |

The first is added and removed; the other two are part of the Expo template and
are **edited in place and restored**, because a build that found them missing
would fall back to a tool default rather than to what the template says. All
three are asserted in `plugins/__tests__/with-npu-minsdk.test.ts`, in both
directions.

**Why legacy packaging is not optional.** `GenieXSdk.init` registers its plugins
by looking them up as files on disk — decompiled, for each of `llama_cpp` and
`qairt`:

```kotlin
File(context.applicationInfo.nativeLibraryDir, "libgeniex_plugin_$id.so")
  .takeIf { it.exists() }
  ?.let { registerPlugin(it.absolutePath) }
```

With AGP's modern default the `.so` files stay inside the APK, uncompressed and
page-aligned, and are never unpacked into `nativeLibraryDir`. `exists()` is
false, registration is skipped, and `init` reports *"Cannot find
libgeniex_plugin_qairt.so in \<dir\>"* — an APK that ships all 206 MB of the
Qualcomm runtime and cannot use a byte of it. Qualcomm's own sample app
(`ai-hub-apps/apps/geniex_chat_android/build.gradle`) sets the same AGP flag.

This was **confirmed on this tree**, not inferred: with
`expo.useLegacyPackaging=false` the processed release manifest contains
`android:extractNativeLibs="false"`; flipping the property and re-running
`:app:processReleaseManifest` produces `android:extractNativeLibs="true"`.

A second, weaker reason points the same way: the Hexagon skel libraries
(`libQnnHtpV81Skel.so` and friends) are loaded by fastRPC on the DSP side from a
filesystem path the QAIRT plugin puts in `ADSP_LIBRARY_PATH` — its own log line
is `Setting ADSP_LIBRARY_PATH to {}` — and a path inside an APK is not something
the DSP loader can open. That one is inferred from how fastRPC works rather than
read out of GenieX's code, so it is recorded as the weaker claim. The first
settles the decision on its own.

The cost is real: extraction roughly doubles the installed footprint of the
native libraries. Only the NPU build pays it.

**API 27 is a linking floor, not a capability claim.** It is the lowest level at
which the AAR may be merged at all; it says nothing about whether the NPU works.
Actual Hexagon inference needs far more — a recent Android, Hexagon v73 or
later, and a bundle compiled for that exact SoC. On anything short of that the
backend declines during its probe and the request goes to llama.cpp, which is
the point of having two backends.

**This is not suppressed with `tools:overrideLibrary`.** That would silence the
merge error while leaving the APK declaring API 24, so it would still install on
devices the Qualcomm runtime cannot load — a build failure traded for a crash in
someone's hand.

---

## 5. Getting the model: what the artifact is, and how it arrives

### The artifact

A QAIRT bundle is **a directory**, not a file. The runtime states its own
accepted layouts in the error it raises when none matches:

> `did not match any known layout: expected a directory with *.gguf (HF GGUF), a
> directory with metadata.json + *.bin (AI Hub extracted), or a .zip file (AI
> Hub archive)`

and the QAIRT plugin names the rest in its own messages:

| File | Required? | The runtime's own words |
| --- | --- | --- |
| `metadata.json` | **yes** | `dispatch: cannot read metadata.json: {}` — it carries the `model_id` that selects the model family (`dispatch: no LLM factory matches model_id '{}'`). |
| `*.bin` shards | **yes**, ≥1 | `No .bin LLM shards found in: {}` — the compiled context binaries, w4a16. |
| `tokenizer.json` | **yes** | `tokenizer.json not found in: {}` |
| `tokenizer_config.json` | *needed for chat* | `apply_chat_template: no chat template loaded (pass tokenizer_config_path to from_file())` |
| `embed_tokens.npy` / `embedding_weights.raw` | model-dependent | referenced by the plugin's input providers |

`lib/models/npu-bundle.ts` enforces the first three as hard requirements and
records the fourth as a warning naming its exact symptom — whether every AI Hub
bundle ships one could not be verified from outside, and rejecting a bundle that
might be fine costs the user the whole download.

There is **no separate GenieX config file to write**. Older QNN/Genie workflows
needed a hand-authored `genie_config.json` plus an HTP backend-extensions JSON;
GenieX 0.4.0 reads `metadata.json` from the bundle instead and takes runtime
options through `LlmCreateInput` / `ModelConfig`. Note that the QAIRT plugin
**rejects a non-zero `n_ctx` and `n_gpu_layers`** (`--nctx (n_ctx) is not
supported by the qairt plugin`): both are fixed at compile time inside the
bundle, and the Kotlin defaults are non-zero, so the bridge zeroes them
explicitly.

### How it arrives: the SDK pulls it

The SDK ships a model manager, and Vesta uses it rather than downloading
anything itself. This is not a shortcut — the asset URLs are resolved from a
release manifest keyed by chipset and precision that only the SDK can read
(`GENIEX_AIHUBBASEURL`, default
`https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models`, which
does not permit listing), and the cache layout, resume behaviour and the
`runtime_id` that says which runtime a bundle is for all belong to it.

```kotlin
ModelManagerWrapper.pullFlow(
  ModelPullInput(
    model_name = "ai-hub-models/Qwen3-4B-Instruct-2507",
    precision  = "w4a16",
    hub        = HubSource.AIHUB,
    chipset    = "SM8850",   // REQUIRED on Android
  )
)
```

So, against the acquisition questions:

The manifest behind that pull is public, even though the assets are not:
`qai-hub-models`' `release-assets.yaml` for this model shows exactly which
chipsets, precisions and runtimes exist —

```yaml
precisions:
  w4a16:
    chipset_assets:
      qualcomm-snapdragon-8-elite-gen5:
        geniex_qairt:
          s3_key: …/qwen3_4b_instruct_2507-geniex_qairt-w4a16-qualcomm_snapdragon_8_elite_gen5.zip
          tool_versions: { qairt: 2.45.0… }
```

— which is how "does an SM8850 w4a16 bundle exist for this model" was answered
without a device. Note the asset is a **`.zip`**, which is the third layout the
runtime accepts ("a .zip file (AI Hub archive)"); the manager unpacks it into
the `metadata.json + *.bin` directory described above.

Against the acquisition questions:

| Question | Answer |
| --- | --- |
| Qualcomm account needed? | **Not for the pull.** The assets come from a public S3 prefix; no token is sent. A free MyAccount is only needed for AI Hub's web catalogue and for `qai-hub-models` exports. |
| AI Hub / CLI / tool flow? | **None, for the curated path.** Models → Qualcomm NPU → Install runs the pull on-device. |
| Exact model identifier | `ai-hub-models/Qwen3-4B-Instruct-2507` (`org/repo`; the runtime rejects anything else). |
| Exact chipset selection | `SM8850`. Documented by Qualcomm as the GenieX id for Snapdragon 8 Elite Gen 5, and the same string Android's `Build.SOC_MODEL` reports on this device. |
| Quantization | `w4a16` — int4 weights, int16 activations, what AI Hub compiles LLM bundles at. |
| Expected files | `metadata.json`, one or more `*.bin`, `tokenizer.json`, `tokenizer_config.json`. Exact names and sizes are recorded from disk at install; nothing is assumed. |
| Bundle size | Not published anywhere reachable — the manifest carries no size and the object cannot be HEADed. The catalog carries ~3 GB as an order of magnitude and the UI marks it "approx." until the real total is measured from disk. |
| Companion files | None beyond the bundle. No `genie_config.json`, no HTP backend-extensions JSON, no separate QAIRT SDK install — the AAR carries `libQnnHtp*`, the V79/V81 skels and the stubs. |
| Where the files go | `filesDir/geniex/…` — app-private, and nowhere near the `.gguf` directory. |
| Credentials in git? | None involved. `.gitignore` already covers `.qai-hub/`, `qai_hub_token*` and the artifact extensions. |

### If the pull says the chipset isn't available

The runtime answers precisely: `chipset <X> not available for this model;
supported: …`, or, for a model whose weights Qualcomm may not redistribute:

> `No pre-compiled assets available for <X> due to licensing restrictions.
> Please use the qai-hub-models Python package to manually export the model.`

Qwen3 is Apache-2.0, so the second should not apply. If the first does, the
fallback is an off-device export on a Linux/macOS host with a free Qualcomm
MyAccount:

```bash
pip install "qai-hub-models[qwen3-4b-instruct-2507]"
qai-hub configure --api_token <token>       # from aihub.qualcomm.com, never committed
python -m qai_hub_models.models.qwen3_4b_instruct_2507.export \
  --chipset qualcomm-snapdragon-8-elite-gen5 \
  --skip-profiling --output-dir genie_bundle
```

The module path `qai_hub_models.models.qwen3_4b_instruct_2507` is verified
against the repository tree; the `--chipset` value is the manifest's own key for
this silicon (AI Hub spells it `qualcomm-snapdragon-8-elite-gen5`, GenieX spells
the same chip by a device name and carries `SM8850` among its aliases, and
Android reports `SM8850` — the runtime's `listChipsets()` table is what declares
those to be one chip, and `lib/models/chipset-identity.ts` is the only place
that reads it). Export runs off-device and
needs a Linux or macOS host. The result is the same
`metadata.json + *.bin + tokenizer` layout, placeable under the GenieX data
directory or pullable with `HubSource.LOCALFS`.

Two spellings of the same idea are worth keeping apart: the `genie` asset in the
manifest is for the older Genie CLI workflow, and `geniex_qairt` is the one this
SDK consumes. Vesta asks for the latter by asking GenieX, which is the point of
not hand-rolling the URL.

### What must never be committed

Source integration belongs in this repository. Binaries and generated artifacts
do not — for size as much as for licensing.

| Never committed | Why | Where it lives instead |
| --- | --- | --- |
| The GenieX AAR, `libQnn*.so`, `libgeniex*.so`, any QAIRT/QNN SDK drop | §1 forbids standalone redistribution, and it would fold proprietary code into an MIT repo | Gradle's Maven cache; it enters the APK, never the git history |
| NPU context bundles (`metadata.json` + `*.bin` shards + tokenizer, or the `.zip`) | gigabytes, and not ours to redistribute | `filesDir/geniex/…` on the device |
| AI Hub API tokens, `~/.qai_hub/client.ini`, any `qai_hub_token*` | a credential | your machine, outside the tree |
| Exported bundles from a local `qai-hub-models` run | generated artifact | `genie_bundle/` or wherever you exported it, ignored |

`.gitignore` covers all four by extension and by directory. **Do not work
around it by copying a Qualcomm SDK into the tree** — the build does not look
for one there, and a manually dropped `.so` is exactly the standalone
redistribution §1 excludes.

---

## 6. The GGUF / llama.cpp route, which is unchanged

The NPU path is an addition, not a replacement, and nothing about the existing
route moved.

- **Every device still runs GGUF on llama.cpp.** It is the last backend in the
  registry and the one that claims whatever nothing else claims. A phone with
  no Qualcomm runtime — which is every phone, in a default build — behaves
  exactly as it did before this backend existed.
- **Bring-your-own models still work.** The curated catalog, "Add from
  HuggingFace" (any public GGUF repo and quant) and "Import a local `.gguf`"
  are untouched, including your own merged, fine-tuned or self-quantized files.
  A local import is recorded at the `user_supplied_baseline` trust level, which
  is the same honesty label an NPU bundle gets.
- **An NPU model and its GGUF twin can coexist.** They are separate registry
  rows with separate artifacts, stored in directories neither of which is
  derived from the other (`filesDir/geniex/…` vs. the models directory), and
  installing or removing one cannot touch the other — `bundleIsolatedFromGguf`
  pins that. Only one is *active* at a time, because both are multi-gigabyte
  resident allocations; switching between them in Models is a normal activate.
- **The NPU bundle is not portable and the GGUF is.** A bundle compiled for
  SM8850 does not run slower elsewhere, it does not run. That asymmetry is why
  the GGUF route can never be retired: it is the one that works everywhere.

---

## 7. What "NPU" is allowed to mean

GenieX exposes **no post-hoc attestation** — nothing in its API reports which
processor executed a generation. So the claim the diagnostics screen makes is
exactly the one that can be supported, and it says so on screen. A run is
labelled NPU only when all four hold:

1. the QAIRT plugin registered — the SDK returned a version string for it
2. the session was created with `runtime_id = "qairt"`
3. the session was created with `compute_unit = "npu"`
4. the Qualcomm backend's own wrapper produced the tokens

Plus one fact from the runtime rather than from us: the QAIRT plugin refuses to
run anywhere else — `qairt plugin only supports NPU inference; ignoring
device='…'`. That makes a successful create a strong claim, but it remains an
inference from a successful create. The Backends panel says so in those words,
and `computeAttested: false` is what drives it.

**There is no CPU fallback in this phase.** If QAIRT/NPU creation fails, the
error propagates and the user is told. Falling back to llama.cpp while keeping
the label is the precise bug this whole design exists to prevent; a fallback
*with an honest warning* is a later feature.

---

## 8. Integrity: what is and isn't verified

Qualcomm publishes no per-file digest for these bundles, so nothing can be
verified against a source the way a HuggingFace GGUF is. What is recorded at
install is a **baseline**:

- every file's real size, measured from disk
- a SHA-256 for files ≤ 8 MB (`metadata.json`, the tokenizer, configs)
- no digest for the multi-GB shards — hashing them would take minutes on the
  phone and there is nothing to compare the result against

That is integrity **from install onwards**, which is exactly the
`user_supplied_baseline` trust level the local-GGUF import already uses, and it
is labelled as that rather than as "verified". Models → Verify re-measures and
reports honestly how much of the bundle each check actually covered.

An NPU install cannot damage a GGUF. The two live in directories neither of
which is derived from the other (`filesDir/geniex/…` vs. the models directory),
a failed pull removes only its own cache entry, and `bundleIsolatedFromGguf`
pins that invariant in a test.
