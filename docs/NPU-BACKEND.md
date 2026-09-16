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

### What Vesta actually asks for, and how to see it

The chipset guard passing moved the failure one layer out, to
`rc=-100010` — `GENIEX_ERROR_COMMON_HUB_MODEL_NOT_FOUND`, an HTTP 404 from the
remote hub. A bare code is unactionable, so the request is now logged in full
before a byte moves (`adb logcat -s VestaNpu`):

```
VestaNpu  I  pull: model=ai-hub-models/Qwen3-4B-Instruct-2507 \
               chipset=<resolved> precision=w4a16 hub=AIHUB \
               runtime=qairt compute=npu
```

Nothing there is a credential and nothing ever will be: `ModelPullInput.hf_token`
is pinned to null in `pullInputFrom()` and is never read from the config, so
there is no path by which one reaches a log line.

### Ask the hub, do not re-derive its catalogue

The 404 was diagnosed with three strings in flight — model name, chipset,
precision — all three supplied from Vesta's own catalog. A hand-maintained copy
of someone else's catalogue is wrong the moment they change it, and cannot say
which of the three is wrong when it is.

GenieX answers the question itself. The **entire public model-management
surface** is `ModelManagerWrapper`:

| Public call | Used for |
| --- | --- |
| `listHubModels(domain)` → `HubModel{name, model_type, chipsets}` | every model the hub offers, and **the chipsets it offers each one for** |
| `resolveAlias(name)` → `String?` | a name the catalogue may list in resolved form |
| `listChipsets()` → `ChipsetInfo[]` | the chipset equivalence table (§5, chipset identity) |
| `pullFlow(input)` → `Flow<PullEvent>` | the download itself, and `PullEvent.Error(code, message)` |
| `getPaths` / `getType` / `list` / `remove` / `clean` / `detectChipset` / `init` | bundle bookkeeping |

The consequences:

- **Both the model name and the chipset come from the hub's own catalogue.**
  Three vocabularies name this silicon — Android's `SM8850`, GenieX's device
  name, AI Hub's `qualcomm-snapdragon-8-elite-gen5` — and only one resolves an
  asset. The chipset is matched to this device through the runtime's own
  chipset table, so the same canonical equivalence the compatibility guard uses
  decides it, with the same refusal to guess.
- **`resolveAlias()` is tried after the literal name**, so a model the
  catalogue lists in resolved form is still found.
- **"Not offered for this chipset" and "no such model" are told apart**, because
  they have different next steps and `-100010` flattens them into one number.
- **The resolution runs before the placeholder row exists**, so a hub that says
  no costs nothing.

#### What is NOT callable, and why this document said otherwise

`com.geniex.sdk.jni.ModelManager` carries two calls that would be better still —
`query(ModelPullInput)`, a dry run returning per-precision candidates and their
sizes, and `lastErrorMessage()`, the native text behind a code. An earlier
revision of this file described them as usable. **They are not.**

The class is `internal` in the SDK's Kotlin metadata. `javap` reports it as
`public final class`, because Kotlin `internal` compiles to JVM `public` and the
distinction lives only in the `@Metadata` annotation that the Kotlin compiler
reads. Reading the JVM signature and concluding "public API" was the error; the
compiler is the authority and it says:

```
Cannot access 'class ModelManager : Any': it is internal in file
```

The corroborating evidence was there to be read: no public wrapper method
anywhere takes or returns a `com.geniex.sdk.jni` type. Every reference is a
private field plus a synthetic `access$…$p` accessor — `ModelManagerWrapper`
holds a `ModelManager`, `LlmWrapper` an `Llm`, `VlmWrapper` a `Vlm`, all three
the same shape. That is an implementation package, not an API.

There is no public companion, no re-export and no supported alternative route.
Reflection would reach it, and is deliberately not used: it would break an
encapsulation the vendor declared on purpose, and would bind Vesta to a private
signature that can change in any patch release.

So the dry run is assembled from what is public. What is lost is the
per-precision size. What is kept is the part that mattered: knowing whether an
asset exists for this chip before spending gigabytes finding out.

### Is the SM8850 asset published? — yes, and two of our strings were wrong

An earlier revision of this document recorded "answered: no". **That was wrong,
and it was wrong because of a bug on this side.** `listHubModels()` does return
Qwen3-4B-Instruct-2507 — as **`qualcomm/Qwen3-4B-Instruct-2507`**. Vesta was
asking for `ai-hub-models/Qwen3-4B-Instruct-2507`, the identifier in Qualcomm's
Android sample `model_list.json`, so the exact-match lookup missed and the card
reported the model unavailable while the hub was listing it.

Qualcomm publicly lists exactly the asset we want: Qwen3-4B-Instruct-2507,
`GENIEX_QAIRT`, `w4a16`, Snapdragon 8 Elite Gen 5 Mobile, QAIRT 2.45.

Two independent string bugs produced three indistinguishable `-100010`s:

| Attempt | `model_name` | `chipset` | Verdict |
| --- | --- | --- | --- |
| 1 | `ai-hub-models/…` | `SM8850` | name wrong |
| 2 | `ai-hub-models/…` | `Snapdragon 8 Elite Gen 5 QRD` (`ChipsetInfo.name`) | both wrong |
| 3 | `qualcomm/…` | `qualcomm-snapdragon-8-elite-gen5` (`HubModel.chipsets`) | name right, chipset wrong |

Note what that table shows: **the correct name and the SoC identifier have never
been sent together.** Attempt 3 fixed one bug and introduced another.

#### The two chipset vocabularies

This is the mistake worth remembering, because the types invite it:

| | Field | Example | Use |
| --- | --- | --- | --- |
| Catalog metadata | `HubModel.chipsets` | `qualcomm-snapdragon-8-elite-gen5` | the release manifest's `supported_chipsets` asset key. Display, and deciding compatibility. |
| Pull parameter | `ModelPullInput.chipset` | `SM8850` | the **SoC identifier**. Qualcomm's Android API documents this field with exactly this example — SM8750 = Snapdragon 8 Elite, SM8850 = Snapdragon 8 Elite Gen 5. |
| Runtime device name | `ChipsetInfo.name` | `Snapdragon 8 Elite Gen 5 QRD` | what `listChipsets()` calls the entry; its `aliases` carry both of the above. |

Three spellings of one chip, on three different beans. The reasoning that went
wrong was "the hub's own spelling must be what the hub wants back" — plausible,
never verified, and false. `HubModel.chipsets` and `ModelPullInput.chipset` are
different fields on different types and the SDK never claimed they matched.

`CompatibleHubModel` now names them apart — `hubChipsetKey` versus
`canonicalSoc` — so the two cannot be swapped by accident again, and the Models
screen shows both, labelled.

#### What is unchanged

- **Compatibility still runs on the canonical equivalence machinery.** The SoC
  identifier is *derived* from the runtime's own `listChipsets()` table, not
  pattern-matched out of the asset key: with no table, nothing resolves, which
  is the same refusal the load-time guard makes. No fuzzy matching was added.
- **Precision stays null.** `HubModel` publishes none, QAIRT bundles are
  pre-quantized, and nothing in the 0.4.0 API establishes that the field is
  required. Changing it at the same time as the chipset would also have
  destroyed the diagnostic value of the next attempt — one variable at a time.

#### Diagnosing the next one

The full request is logged before the pull and **again at the moment it fails**,
beside the rc and `Build.SOC_MODEL`:

```
adb logcat -s VestaNpu
VestaNpu  I  pull: model=qualcomm/Qwen3-4B-Instruct-2507 chipset=SM8850 …
VestaNpu  W  pull FAILED rc=-100010 for model=… chipset=… (Build.SOC_MODEL=SM8850) :: …
```

The request also rides in the on-screen error now, because an rc with no subject
cannot be acted on — twice a `-100010` has turned out to be one of these three
strings rather than a missing asset. No credential appears in either:
`hf_token` is pinned null in `pullInputFrom()` and never read from config.

The SDK's own logging is a second capture, under its own tag — `adb logcat -s
GenieXSdk`. It needs no switch and has none; see *What the SDK will tell you
about itself* below for why, and for what it does not contain.

### The hub is the catalogue

The consequence for the UI is larger than one model. A hard-coded list of one
downloadable entry was going to be wrong the moment Qualcomm's list changed, and
it was wrong already — offering an Install that could only 404 while 19 real,
installable models went unmentioned.

So **Models → Qualcomm NPU** now renders Qualcomm's own catalogue:

- The list comes from `listHubModels()` and is never hard-coded.
- It is filtered to this device through the same canonical chipset machinery the
  load-time guard uses. Models for other chipsets are counted, not listed —
  a count is informative, a row you cannot install is not.
- Model types the app has no runtime for (VLM; the backend builds an
  `LlmWrapper`) are excluded and counted separately. That is a compatibility
  fact, not a judgement about the model.
- Each card shows only what `HubModel` actually carries: the exact identifier
  that gets pulled, the model type, the chipset, and the canonical target.
  **No size and no precision** — the public API publishes neither, and a guessed
  number is worse than a blank space.
- No quality ranking is invented or implied. The only claim repeated from the
  hub is "Available from Qualcomm Hub".
- Installing uses the hub's own spelling of both the model name and the chipset.
  Precision is left null so GenieX picks the bundle's own; the runtime-version
  gate is skipped rather than given an invented bound; `minRamMb` is null, so
  the fit label reads "unknown", which is true.

An installed hub model is an ordinary registry row — `backend=qualcomm_npu`,
`runtime=qairt`, `compute=npu` — and coexists with every GGUF and with a
manually imported bundle. **Activation stays an explicit choice**: only a device
with nothing active at all gets one picked for it.

### Vesta's preferred model, when the hub does not have it

The Qwen3 4B card stays. It is a recommendation, and a recommendation does not
stop being one because the vendor is between releases. What changes is which
actions can possibly work:

| Hub state | Card shows |
| --- | --- |
| never checked | "Check hub" as the primary action; Install hidden, Import bundle offered |
| listed for this chipset | Install, Import bundle |
| answered, not listed | "Not currently available from Qualcomm Hub" with the time of the check, "Check again", Import bundle |

A known-doomed Install is never left active after a successful check proves the
model absent.

### Caching

The last successful catalogue is written to a JSON file in the cache directory —
a disposable copy of someone else's data, not a setting, and the OS is welcome
to evict it. On load it is marked `cached` and rendered with its age. A corrupt
or unreadable cache degrades to "not checked yet", never to a half-populated
list that would be read as the hub's answer. **A cached absence is never treated
as permanent.**

A failed refresh lands *beside* the last good snapshot rather than replacing it:
losing a good answer because a later query timed out would be strictly worse
than showing an older one. A failed install is recorded against that model
alone, so one doomed download cannot make the whole catalogue look broken.

### Manual import: a bundle you already have

Not a workaround for the compatibility guard — the identical refusal runs first,
against the identical catalog entry, so an imported bundle still has to be for
this silicon. What it skips is Qualcomm's release schedule.

**Models → Qualcomm NPU → Import bundle**, then pick the `.zip`. A `.zip`
because it is one of the three layouts the runtime accepts and the only one an
Android file picker can return — the picker hands back a single document, never
a directory.

The import goes through the manager's own `HubSource.LOCALFS` path, which means
it is the same code as a download, differing only in `hub` and `local_path`:

| | Hub pull | Manual import |
| --- | --- | --- |
| Chipset compatibility guard | runs | **runs, identically** |
| Layout validation (`metadata.json`, `*.bin`, tokenizer) | manager | **manager, identically** |
| `runtime_id` must be `qairt` | enforced | **enforced** |
| Per-file size measured from disk | yes | **yes** |
| SHA-256 for files ≤ 8 MB | yes | **yes** |
| Storage | `filesDir/geniex/…`, app-private | **same** |
| Registry row | `backend=qualcomm_npu`, `trust=user_supplied_baseline` | **same** |
| GGUF import | untouched, separate path | **untouched, separate path** |

One cost worth knowing: the picker returns a `content://` URI, which the native
side cannot open as a file, so the archive is staged into app storage first and
deleted as soon as the manager has unpacked it. That means a second copy of a
multi-gigabyte file exists for the duration of the import.

### Public precompiled asset vs. an export you generate

These are different artifacts with different provenance, and the distinction
matters for both licensing and support:

| | Public precompiled | Your own AI Hub export |
| --- | --- | --- |
| Who built it | Qualcomm, published to the AI Hub asset bucket | you, on your own machine |
| How it arrives | GenieX model manager pulls it on-device | you export, then Import bundle |
| Account needed | none | a free Qualcomm MyAccount and an API token |
| Availability | whatever the hub lists today | whenever you run the export |
| Licence | the model's own (Qwen3: Apache-2.0) | unchanged — the weights are still Apache-2.0 |

The export, on a Linux or macOS host (it does not run on the phone, and does not
run on Windows):

```bash
pip install "qai-hub-models[qwen3-4b-instruct-2507]"
qai-hub configure --api_token <token>     # from aihub.qualcomm.com — never committed
python -m qai_hub_models.models.qwen3_4b_instruct_2507.export \
  --chipset qualcomm-snapdragon-8-elite-gen5 \
  --skip-profiling --output-dir genie_bundle
```

The module path is verified against the `qai-hub-models` repository tree, and
`--chipset` takes AI Hub's own manifest key for this silicon. Expected output,
which is what the importer validates:

| File | Required | Why |
| --- | --- | --- |
| `metadata.json` | **yes** | carries the `model_id` that selects the model family |
| `*.bin` (one or more) | **yes** | the compiled w4a16 context binaries |
| `tokenizer.json` | **yes** | `tokenizer.json not found in: {}` otherwise |
| `tokenizer_config.json` | for chat | without it, `apply_chat_template` has no template |
| `embed_tokens.npy` / `embedding_weights.raw` | model-dependent | recorded as a warning, not a rejection |

Zip that directory and import it. `genie_bundle/` and `*.bin` are in
`.gitignore`; the token never belongs anywhere near the tree.

### Error codes

`rc` is never obscured. The native side formats every failure as
`rc=<n>: <message>`, where `<message>` is `PullEvent.Error.message` — code
first and always, because it is
the only token that can be looked up against Qualcomm's definitions — and
`lib/models/npu-errors.ts` turns it into a sentence while keeping the number in
the text the user sees.

That table is deliberately short. Only codes with a source are in it:

| Code | Constant | Source |
| --- | --- | --- |
| `0` | `GENIEX_SUCCESS` | `javap -constants` on `ModelManagerWrapper` |
| `-100006` | `GENIEX_ERROR_CANCELLED` | same |
| `-100008` | `GENIEX_ERROR_ALREADY_INITIALIZED` | same |
| `-100010` | `GENIEX_ERROR_COMMON_HUB_MODEL_NOT_FOUND` | Qualcomm's published error definitions |

Anything else is reported as "the Qualcomm runtime refused this install with
code `<n>`". Inventing an explanation for an unverified code is worse than
offering none — it sends the reader somewhere that is not the problem.

### Other refusals the runtime can give

Two more, distinguishable from `-100010` by their text rather than their code:

> `Requested chipset not available for this model; supported: …`

The model resolved but this chipset did not — and the runtime names the ones
that did. `listHubModels()` now answers the same question before the pull, so
this should be reached only when the hub list and the asset manifest disagree.

> `No pre-compiled assets available for <X> due to licensing restrictions.
> Please use the qai-hub-models Python package to manually export the model.`

For a model whose weights Qualcomm may not redistribute. Qwen3 is Apache-2.0, so
this should not apply to the catalog entry — and if it ever does, the export
above is exactly what it is asking for.

One naming trap worth keeping straight: the `genie` asset in the release
manifest is for the older Genie CLI workflow, and `geniex_qairt` is the one this
SDK consumes. Vesta asks for the latter by asking GenieX rather than by
hand-rolling a URL, which is the point.

### What the SDK will tell you about itself

Asked whether GenieX 0.4.0 honours a `GENIEX_LOG=trace` environment variable,
the answer from the binaries is **no — and there is nothing to turn on, because
it is already on.** Both halves matter, so both are recorded here with how they
were established. Everything below comes from the AAR Gradle actually resolves
(`com.qualcomm.qti:geniex-android:0.4.0`), read with an ELF symbol/relocation
parser and a disassembler; nothing is inferred from Qualcomm's documentation.

**`GENIEX_LOG` does not exist in 0.4.0.** The string appears in none of the 52
native libraries in the AAR and in none of its classes. The `GENIEX_*`
environment variables that *are* in the binaries are exactly:

| Variable | Library | What it governs |
| --- | --- | --- |
| `GENIEX_AIHUBBASEURL`, `GENIEX_AIHUBVERSION` | `libgeniex.so` | the AI Hub endpoint and release |
| `GENIEX_HFTOKEN`, `HF_ENDPOINT` | `libgeniex.so` | the Hugging Face hub path |
| `GENIEX_DATADIR` | `libgeniex.so` | where the model cache lives |
| `GENIEX_DL_CHUNK_SIZE`, `GENIEX_DL_FILE_CONCURRENCY`, `GENIEX_DL_CHUNK_CONCURRENCY` | `libgeniex.so` | download shape |
| `GENIEX_PLUGIN_PATH` | `libgeniex.so`, both plugins | where plugins are looked for |
| `GENIEX_DECODE_WORKERS`, `GENIEX_DECODE_CPUMASK`, `GENIEX_DECODE_POLL`, `GENIEX_CLOCK_KEEPER_THREADS`, `GENIEX_DUMP_IO` | `libgeniex_core.so` | decode threading and I/O dumps |

No logging variable is among them, and none of the libraries is built with
`env_logger` or reads `RUST_LOG`. A `setenv("GENIEX_LOG", "trace", 1)` before
`init` would set a variable nothing reads, so **no such JNI bridge was added**.

**What 0.4.0 has instead is a C sink**, exported from `libgeniex.so`:

```c
extern void (*geniex_log)(int level, const char *msg);  /* .data, non-null default */
extern int   geniex_log_level;                          /* .bss, 4 bytes */
int          geniex_set_log(void (*cb)(int, const char *));
```

`geniex_set_log` is six instructions: it stores its one argument into
`geniex_log` and returns 0. The levels are `0 TRACE, 1 DEBUG, 2 INFO, 3 WARN,
4 ERROR` — the built-in sink indexes a five-entry table of `[TRACE] `,
`[DEBUG] `, `[ INFO] `, `[ WARN] `, `[ERROR] ` (with matching ANSI colours)
before writing the message. Every call site in `libgeniex.so`,
`libgeniex_plugin_qairt.so` and `libgeniex_plugin_llama_cpp.so` compiles to the
same guard:

```
w8 = geniex_log_level ; x9 = geniex_log
cmp w8, #<level>      ; skip if geniex_log_level > level, or geniex_log == NULL
```

`geniex_log_level` lives in `.bss` and **no library in the AAR ever writes it**
— there is no setter in the exported API, no reference to it from
`libgeniex.so`'s own initialisers, and the two plugins only read it. It is `0`,
i.e. TRACE, from the first instruction. There is no verbosity left to raise.

**And the sink is already wired to logcat.** `libnpu_jni.so`'s `JNI_OnLoad`,
before returning `JNI_VERSION_1_6`, does three things: installs a
`geniex_set_log` callback that is a one-line
`__android_log_print(level + 2, "GenieXSdk", "%s", msg)` (so TRACE arrives as
VERBOSE and ERROR as ERROR), redirects this process's stdout and stderr into
the same tag as `[STDOUT] …` / `[STDERR] …`, and writes one self-test line to
each. GenieX is at maximum verbosity, in logcat, under a single tag, before
Vesta's first line of Kotlin runs.

So the only thing that was actually missing was reading it, and that is what
`VestaNpuModule.genieXLogReport()` does — an app may read its own logcat
entries without `READ_LOGS`, and every GenieX line comes from our process. It
runs `logcat -d -v threadtime -s GenieXSdk:V`, keeps the newest lines up to a
budget (logcat's own `-t` is applied by logd to the whole buffer and the tag
filter only afterwards, so `-t 400` on a chatty process can hand back no GenieX
lines at all), blanks anything credential-shaped *before* the line crosses the
bridge, and reports the counts per priority alongside the lines. Two of those
counts are load-bearing:

- a **VERBOSE** line is a GenieX TRACE line that passed the level gate, which is
  the only on-device confirmation available that `geniex_log_level` is still 0;
- the two **self-test** lines prove the stdout/stderr redirect is live in this
  process rather than merely present in the binary.

The capture joins the identity probe, the cache report and the list probe in the
single block the Diagnostics screen copies and writes under `VestaNpu`.

#### What this does not answer

The AI Hub endpoint, the manifest URL, cache hits and misses, the canonical
model name, the chipset lookup, the release-assets URL and the HTTP status are
**absent at every level, because they were never written.** That half of the SDK
is Rust inside `libgeniex.so`, and it reaches the log sink through exactly six
`geniex_model_log_emit()` call sites: `"geniex model manager initialized"`
(DEBUG), `"geniex_model_init called after the model manager was already
initialized…"` (WARN), and four error paths carrying runtime-formatted text.
Not one carries a URL, a cache decision or a status code — and
`geniex_model_log_emit` does not even consult `geniex_log_level`, so no setting
could gate them differently.

Those questions therefore stay where they already were: `hubCacheReport()` and
`hubListProbe()`, which read the manifests the runtime cached in our own data
directory. Turning up the SDK's logging was never going to answer them.

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
