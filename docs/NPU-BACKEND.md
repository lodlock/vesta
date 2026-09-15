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

### The runtime

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
remove or alter proprietary notices** (§2b) — the AAR's NOTICE file must survive
into the app; the licence is **revocable and terminates automatically on
breach** (§7); everything is AS-IS with liability capped at $100 (§5, §6).

**Verdict: not blocked.** Redistribution inside the application is expressly
granted. The binaries are pulled at build time and are never committed.

### The GenieX SDK itself

`com.qualcomm.qti:geniex-android` (0.4.0 at the time of writing) declares **two**
licences: BSD-3-Clause (the SDK source, which is on GitHub) and Qualcomm's Terms
of Use. The BSD half is unproblematic; the Qualcomm half is the same shape as
above. The AAR is the object-code delivery the grant contemplates.

### What could not be verified

- Whether the `geniex-android` AAR bundles the QNN runtime or resolves it as a
  separate dependency — its published POM shows no declared dependencies, which
  may mean the natives are inside the AAR. Either way both artifacts carry a
  grant permitting redistribution in an application.
- Whether Qualcomm publishes a precompiled **Qwen3-4B-Instruct-2507** bundle for
  SM8850 specifically. Qwen3-4B is the tutorial's headline example; the exact
  2507 instruct variant is not listed in the docs that were reachable. This is a
  setup-time question, not a licensing one — see §4.

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

The NPU backend is **off unless you build it in**, following the same
opt-in shape as the scheduling-only profile and the release signing config:

```bash
# Default build — unchanged, no Qualcomm dependency, NPU reports unavailable
npx expo prebuild --platform android --clean

# NPU-enabled build
VESTA_ENABLE_NPU=1 npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

With the flag set, the config plugin adds the Maven dependency and copies the
native bridge. Without it, neither exists, so a default build cannot break on a
Qualcomm SDK it never fetched.

Then, on the device side:

1. Create a free **Qualcomm MyAccount** and sign in to AI Hub.
2. Obtain a Qwen3-4B (Instruct 2507 if published) bundle compiled for
   **SM8850**, either from AI Hub's precompiled assets or by exporting with
   `qai-hub-models`. Export runs off-device.
3. Note the bundle's SHA-256 for each file. Vesta verifies the bundle as one
   integrity unit and refuses to load it if any file fails.
4. Import it in Models → Import, or host it somewhere Vesta can download from.

**Nothing from steps 1–4 belongs in this repository**: not the bundle, not the
SDK, not your AI Hub token. `.gitignore` covers the artifact extensions, and the
build pulls the runtime from Maven rather than from a checked-in binary.
