package com.cosmico.vesta

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.geniex.sdk.GenieXSdk
import com.geniex.sdk.LlmWrapper
import com.geniex.sdk.ModelManagerWrapper
import com.geniex.sdk.bean.ChatMessage
import com.geniex.sdk.bean.ComputeUnitValue
import com.geniex.sdk.bean.GenerationConfig
import com.geniex.sdk.bean.HubSource
import com.geniex.sdk.bean.LlmCreateInput
import com.geniex.sdk.bean.LlmStreamResult
import com.geniex.sdk.bean.ModelConfig
import com.geniex.sdk.bean.ModelPaths
import com.geniex.sdk.bean.ModelPullInput
import com.geniex.sdk.bean.ModelType
import com.geniex.sdk.bean.ProfilingData
import com.geniex.sdk.bean.RuntimeIdValue
import com.geniex.sdk.bean.SamplerConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * The Qualcomm NPU bridge, over the GenieX SDK.
 *
 * ONLY COMPILED INTO A BUILD MADE WITH VESTA_ENABLE_NPU=1. The config plugin
 * copies this file and adds the Maven dependency together; in a default build
 * neither exists, `NativeModules.VestaNpuModule` is undefined, and the
 * TypeScript backend reports the NPU unavailable. That is why this file lives
 * outside native/android/ — everything in there is copied unconditionally.
 *
 * ## Written against the real API of geniex-android 0.4.0
 *
 * Every signature below was read out of the AAR with `javap`, not inferred, and
 * 0.4.0 is the newest published version at the time of writing. That matters
 * more than usual here: Qualcomm's own Android sample in `qualcomm/ai-hub-apps`
 * is written against a LATER, unpublished SDK — its `LlmCreateInput` takes a
 * `model_name` and its `ModelConfig` has an `enable_thinking` field, and
 * neither exists in 0.4.0. Copying the sample verbatim does not compile.
 *
 *   GenieXSdk.getInstance().init(context, InitCallback)
 *   getPluginVersion(PLUGIN_ID_QAIRT): String                 native
 *   ModelManagerWrapper.init(dataDir): Result<Unit>           suspend
 *   ModelManagerWrapper.pullFlow(ModelPullInput): Flow<PullEvent>
 *   ModelManagerWrapper.getPaths(name): ModelPaths?           suspend
 *   ModelManagerWrapper.detectChipset(offline): String?       suspend
 *   ModelManagerWrapper.listChipsets(): List<ChipsetInfo>     suspend
 *   ModelManagerWrapper.remove(name): Int                     suspend
 *   LlmWrapper.builder().llmCreateInput(input).build()        suspend, Result<LlmWrapper>
 *   LlmCreateInput(model_path, tokenizer_path, ModelConfig, runtime_id, compute_unit)
 *   applyChatTemplate(messages, tools, enableThinking, addGenerationPrompt)
 *   generateStreamFlow(prompt, GenerationConfig): Flow<LlmStreamResult>
 *   stopStream() / destroy()
 *
 * GenieX is Kotlin, so everything the bytecode exposes as `getX()` is a
 * PROPERTY, not a callable getter: `profile.ttftMs`, never
 * `profile.getTtftMs()`. Two names do not follow from the Java signature and
 * are spelled the way the Kotlin metadata spells them —
 * `ProfilingData.decodingSpeed` (not decodeSpeed), and the snake_case
 * `LlmCreateInput(model_path, tokenizer_path, …)`.
 *
 * ## Plugin registration is the SDK's job, not ours
 *
 * An earlier version of this file called `registerPlugin(PLUGIN_ID_QAIRT)` —
 * `registerPlugin("qairt")` — and treated a zero return as "the NPU is here".
 * Reading `GenieXSdk.init`'s bytecode shows that is wrong twice over:
 *
 *   1. `registerPlugin` takes a FILESYSTEM PATH, not a plugin id. init() builds
 *      `File(applicationInfo.nativeLibraryDir, "libgeniex_plugin_$id.so")` and
 *      passes its absolute path. Handing it the bare string "qairt" can only
 *      fail, which would have made the probe report "no NPU" on a device that
 *      has one.
 *   2. init() already does this for BOTH plugins (llama_cpp and qairt) before
 *      it calls back. There is nothing left for us to register.
 *
 * So registration is attested the only honest way available: ask the SDK for
 * the QAIRT plugin's version afterwards. A version string comes back only if
 * the plugin is registered and alive.
 *
 * ## …which is also why the NPU build needs legacy packaging
 *
 * That same line — `File(nativeLibraryDir, "libgeniex_plugin_qairt.so")
 * .exists()` — is a real filesystem check. With AGP's modern default
 * (`extractNativeLibs="false"`) the `.so` files are never unpacked out of the
 * APK, the file does not exist, init() skips registration and reports
 * "Cannot find libgeniex_plugin_qairt.so in <dir>". The config plugin therefore
 * sets `expo.useLegacyPackaging=true` for the NPU build — the property the Expo
 * template already feeds into `packagingOptions { jniLibs { useLegacyPackaging
 * } }`. Qualcomm's own sample app sets the same AGP flag. The probe below
 * checks for the file rather than assuming the flag took, so a build that got
 * this wrong says so in one sentence instead of failing at model load.
 * See docs/NPU-BACKEND.md.
 *
 * ## Honesty rules this file enforces
 *
 * - The runtime is pinned: `runtime_id = qairt`, `compute_unit = npu`. GenieX
 *   will happily run a GGUF on its own llama.cpp plugin, and this app already
 *   has llama.cpp; a CPU run must never come back labelled NPU.
 * - A bundle is refused unless the model manager's own `ModelPaths.runtime_id`
 *   says "qairt". That is the manifest's word, not our guess.
 * - There is NO fallback here. If QAIRT/NPU creation fails, the failure is
 *   reported. Falling back to CPU while keeping the NPU label is exactly the
 *   bug the rest of this design exists to prevent.
 * - Profiling numbers are the runtime's own (ProfilingData). A field the
 *   runtime does not report is ABSENT from the result map, never zero.
 */
class VestaNpuModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "VestaNpuModule"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile private var sdkReady = false
    @Volatile private var pluginVersion: String? = null
    @Volatile private var initError: String? = null
    @Volatile private var llm: LlmWrapper? = null

    /** The bundle name behind the current session, or null when none. */
    @Volatile private var loadedModelName: String? = null

    private var generateJob: Job? = null
    private var pullJob: Job? = null

    /**
     * Tokens seen so far in the turn currently running. A field rather than a
     * local because the cancellation handler needs them: a `StringBuilder`
     * local to the try block is already out of scope by the time
     * CancellationException is caught, and a cancelled turn that returns ""
     * throws away text the user was watching appear.
     */
    private val partialText = StringBuilder()

    companion object {
        private const val TAG = "VestaNpu"
        private const val EVENT_TOKEN = "vestaNpuToken"
        private const val EVENT_PULL = "vestaNpuPullProgress"

        /** The plugin GenieX loads for the Hexagon path, as a file name. */
        private const val QAIRT_PLUGIN_LIB = "libgeniex_plugin_qairt.so"

        /**
         * Files small enough to hash at install time. A context bundle's weight
         * shards are gigabytes; hashing them would take minutes on the phone
         * and GenieX publishes no digest to compare against anyway, so shards
         * get a recorded SIZE and the small descriptive files get a digest.
         * See lib/models/npu-bundle.ts for what is done with both.
         */
        private const val HASHABLE_MAX_BYTES = 8L * 1024 * 1024
    }

    // RN requires these for a module that emits device events.
    @ReactMethod fun addListener(eventName: String) {}

    @ReactMethod fun removeListeners(count: Int) {}

    // ── SDK lifecycle ────────────────────────────────────────────────────

    /**
     * Brings the SDK up once, and decides — honestly — whether the Hexagon
     * path is actually available.
     *
     * Three separate things have to be true, and each is checked rather than
     * assumed: the plugin .so is a real file on disk (so legacy packaging is
     * on), `init` reported no failure, and the QAIRT plugin answers with a
     * version. Whatever fails is kept in [initError] so diagnostics can say
     * which one it was instead of "unavailable".
     */
    private suspend fun ensureSdk(): Boolean {
        if (sdkReady) return true

        val libDir = reactApplicationContext.applicationInfo.nativeLibraryDir
        if (!File(libDir, QAIRT_PLUGIN_LIB).exists()) {
            // The characteristic symptom of extractNativeLibs=false: the APK
            // has the library, but not as a file anything can open by path.
            initError =
                "$QAIRT_PLUGIN_LIB is not present as a file in $libDir. " +
                    "The GenieX SDK loads its plugins by path, so this build needs " +
                    "expo.useLegacyPackaging=true (extractNativeLibs)."
            return false
        }

        val sdk = GenieXSdk.Companion.getInstance()
        val started = kotlinx.coroutines.suspendCancellableCoroutine<Boolean> { cont ->
            try {
                sdk.init(
                    reactApplicationContext.applicationContext,
                    object : GenieXSdk.InitCallback {
                        override fun onSuccess() {
                            if (cont.isActive) cont.resumeWith(Result.success(true))
                        }

                        override fun onFailure(message: String) {
                            // init() composes this from what actually went wrong
                            // ("Cannot find …", "Cannot registerPlugin …",
                            // "geniex_model_init failed (rc=…)"). Keep it verbatim.
                            initError = message
                            android.util.Log.w(TAG, "GenieX init failed: $message")
                            if (cont.isActive) cont.resumeWith(Result.success(false))
                        }
                    },
                )
            } catch (e: Throwable) {
                initError = e.message ?: e.toString()
                if (cont.isActive) cont.resumeWith(Result.success(false))
            }
        }
        if (!started) return false

        // The attestation that QAIRT is registered. init() registers both
        // plugins itself; a version string is what proves this one took.
        pluginVersion =
            try {
                sdk.getPluginVersion(GenieXSdk.PLUGIN_ID_QAIRT)?.takeIf { it.isNotBlank() }
            } catch (e: Throwable) {
                null
            }
        if (pluginVersion == null) {
            initError = "The QAIRT plugin did not register; this device has no usable Hexagon runtime."
            return false
        }

        // The model manager keeps its own `initialized` flag, separate from the
        // one GenieXSdk.init sets, so it has to be initialized too — against the
        // SAME directory, or the two would disagree about where models live.
        // A second init of the native side returns ALREADY_INITIALIZED, which
        // the wrapper treats as success.
        val dataDir = File(reactApplicationContext.filesDir, "geniex")
        dataDir.mkdirs()
        val managerInit = ModelManagerWrapper.init(dataDir.absolutePath)
        if (managerInit.isFailure) {
            initError =
                "GenieX model manager init failed: " +
                    (managerInit.exceptionOrNull()?.message ?: "unknown error")
            return false
        }

        initError = null
        sdkReady = true
        return true
    }

    private fun runtimeInfo(extra: (WritableMap) -> Unit = {}): WritableMap {
        val info = Arguments.createMap()
        info.putString("version", pluginVersion)
        info.putString("computeUnit", ComputeUnitValue.NPU.value)
        info.putString("runtimeId", RuntimeIdValue.QAIRT.value)
        info.putString("soc", socModel())
        info.putString("dataDir", File(reactApplicationContext.filesDir, "geniex").absolutePath)
        extra(info)
        return info
    }

    private fun socModel(): String? =
        try {
            android.os.Build.SOC_MODEL?.takeIf {
                it.isNotBlank() && !it.equals("unknown", ignoreCase = true)
            }
        } catch (e: Throwable) {
            null
        }

    // ── Probe ────────────────────────────────────────────────────────────

    /**
     * "Is there a usable Hexagon runtime here?" — answered by starting it, not
     * by the classes being on the classpath. A device without Hexagon reaches
     * this code and must come away with a null (plus a readable reason), never
     * with a false promise.
     */
    @ReactMethod
    fun probe(promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    // Resolve rather than reject: "no NPU here" is an ANSWER, and
                    // the caller needs the reason to show it.
                    val failure = Arguments.createMap()
                    failure.putString("error", initError ?: "No usable Qualcomm NPU runtime on this device")
                    failure.putString("soc", socModel())
                    promise.resolve(failure)
                    return@launch
                }
                promise.resolve(
                    runtimeInfo {
                        it.putBoolean("available", true)
                        // What the currently loaded session was created with, if
                        // there is one. Diagnostics reads this rather than
                        // re-deriving it, so the screen can only describe a
                        // session that actually exists.
                        it.putString("loadedModel", loadedModelName)
                        it.putBoolean("loaded", llm != null)
                    },
                )
            } catch (e: Throwable) {
                val failure = Arguments.createMap()
                failure.putString("error", e.message ?: e.toString())
                failure.putString("soc", socModel())
                promise.resolve(failure)
            }
        }
    }

    // ── Chipset identification ───────────────────────────────────────────

    /**
     * Everything this device will say about its chipset, from every source that
     * has an opinion, kept separate so the TypeScript side can cross-check them
     * rather than trust one.
     *
     *   socModel   Android's own `Build.SOC_MODEL` (API 31+)
     *   detected   GenieX's `detectChipset`. Qualcomm document host auto-detect
     *              as Windows-on-Snapdragon only, and the runtime carries the
     *              matching string "chipset not provided and host auto-detect is
     *              not supported on this platform" — so this is EXPECTED to come
     *              back empty on Android. Empty is reported as empty.
     *   known      `listChipsets()`: every chipset the runtime knows, with its
     *              aliases. This is what makes "SM8850" and whatever marketing
     *              name a device reports resolvable to the same target.
     */
    @ReactMethod
    fun deviceChipset(promise: Promise) {
        scope.launch {
            try {
                val out = Arguments.createMap()
                out.putString("socModel", socModel())
                out.putString("board", android.os.Build.BOARD)
                out.putString("hardware", android.os.Build.HARDWARE)

                if (!ensureSdk()) {
                    out.putString("error", initError ?: "runtime unavailable")
                    promise.resolve(out)
                    return@launch
                }

                out.putString(
                    "detected",
                    try {
                        ModelManagerWrapper.detectChipset(false)?.takeIf { it.isNotBlank() }
                    } catch (e: Throwable) {
                        null
                    },
                )

                val known: WritableArray = Arguments.createArray()
                try {
                    for (chip in ModelManagerWrapper.listChipsets()) {
                        val entry = Arguments.createMap()
                        entry.putString("name", chip.name)
                        val aliases = Arguments.createArray()
                        chip.aliases.forEach { aliases.pushString(it) }
                        entry.putArray("aliases", aliases)
                        known.pushMap(entry)
                    }
                } catch (e: Throwable) {
                    android.util.Log.w(TAG, "listChipsets failed", e)
                }
                out.putArray("known", known)
                promise.resolve(out)
            } catch (e: Throwable) {
                promise.reject("NPU_CHIPSET_FAILED", e.message, e)
            }
        }
    }

    // ── Bundle installation ──────────────────────────────────────────────

    /**
     * Downloads an AI Hub context bundle into app-private storage.
     *
     * The download is GenieX's, not ours, and that is deliberate: the asset
     * URLs are resolved from a release manifest keyed by chipset and precision
     * that only the SDK can read, the bundle is many files, and the SDK's cache
     * already lives under `filesDir/geniex` — app-private, not world-readable,
     * and nowhere near the `.gguf` directory, so an NPU install cannot collide
     * with or overwrite a GGUF. A failed pull leaves `.inflight/` behind for a
     * resume and touches nothing else.
     *
     * `chipset` is REQUIRED for the AI Hub path on Android (Qualcomm's own
     * sample refuses without one) and is validated on the TypeScript side
     * against this device before we get here.
     */
    @ReactMethod
    fun pull(configJson: String, promise: Promise) {
        if (pullJob?.isActive == true) {
            promise.reject("NPU_PULL_BUSY", "A bundle is already downloading")
            return
        }
        pullJob =
            scope.launch {
                try {
                    if (!ensureSdk()) {
                        promise.reject("NPU_UNAVAILABLE", initError ?: "No usable Qualcomm NPU runtime")
                        return@launch
                    }
                    val config = JSONObject(configJson)
                    val modelName = config.getString("modelName")
                    val chipset = config.optString("chipset", "").ifBlank { null }
                    val precision = config.optString("precision", "").ifBlank { null }
                    val hub =
                        try {
                            HubSource.valueOf(config.optString("hub", "AIHUB").uppercase())
                        } catch (e: IllegalArgumentException) {
                            HubSource.AIHUB
                        }

                    if (hub == HubSource.AIHUB && chipset == null) {
                        promise.reject(
                            "NPU_CHIPSET_REQUIRED",
                            "An AI Hub bundle cannot be pulled without a chipset.",
                        )
                        return@launch
                    }

                    val input =
                        ModelPullInput(
                            modelName,
                            precision,
                            hub,
                            null,
                            null,
                            chipset,
                            config.optString("displayName", "").ifBlank { null },
                            ModelType.LLM,
                        )

                    var failure: Pair<Int, String>? = null
                    ModelManagerWrapper.pullFlow(input).collect { event ->
                        when (event) {
                            is ModelManagerWrapper.PullEvent.Progress -> {
                                var done = 0L
                                var total = 0L
                                val files = Arguments.createArray()
                                for (f in event.files) {
                                    done += f.downloaded_bytes
                                    if (f.total_bytes > 0) total += f.total_bytes
                                    val entry = Arguments.createMap()
                                    entry.putString("name", f.file_name)
                                    entry.putDouble("downloaded", f.downloaded_bytes.toDouble())
                                    entry.putDouble("total", f.total_bytes.toDouble())
                                    files.pushMap(entry)
                                }
                                val payload = Arguments.createMap()
                                payload.putString("modelName", modelName)
                                payload.putDouble("downloaded", done.toDouble())
                                payload.putDouble("total", total.toDouble())
                                payload.putArray("files", files)
                                reactApplicationContext.emitDeviceEvent(EVENT_PULL, payload)
                            }

                            is ModelManagerWrapper.PullEvent.Completed -> Unit

                            is ModelManagerWrapper.PullEvent.Error ->
                                failure = event.code to event.message
                        }
                    }

                    val err = failure
                    if (err != null) {
                        promise.reject("NPU_PULL_FAILED", "rc=${err.first}: ${err.second}")
                        return@launch
                    }
                    // Completion is not "the flow ended" — it is "the manager now
                    // has paths for it". A pull that stopped mid-way leaves the
                    // model in .inflight/, which getPaths deliberately hides.
                    val paths = ModelManagerWrapper.getPaths(modelName)
                    if (paths == null) {
                        promise.reject(
                            "NPU_PULL_INCOMPLETE",
                            "The download ended without producing a complete bundle.",
                        )
                        return@launch
                    }
                    promise.resolve(describeBundle(modelName, paths))
                } catch (e: kotlinx.coroutines.CancellationException) {
                    promise.reject("NPU_PULL_CANCELED", "Download canceled")
                } catch (e: Throwable) {
                    promise.reject("NPU_PULL_FAILED", e.message, e)
                }
            }
    }

    @ReactMethod
    fun cancelPull() {
        pullJob?.cancel()
        pullJob = null
    }

    /**
     * What is actually on disk for this bundle, measured rather than assumed:
     * every file, its real size, and a SHA-256 for the small ones.
     *
     * No digest is "known" here in the sense the GGUF path means it — GenieX
     * publishes none — so these are baselines recorded at install, exactly like
     * a user-supplied local GGUF. That is stated plainly in the UI rather than
     * dressed up as verification.
     */
    @ReactMethod
    fun bundleInfo(modelName: String, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.reject("NPU_UNAVAILABLE", initError ?: "No usable Qualcomm NPU runtime")
                    return@launch
                }
                val paths = ModelManagerWrapper.getPaths(modelName)
                if (paths == null) {
                    promise.resolve(null)
                    return@launch
                }
                promise.resolve(describeBundle(modelName, paths))
            } catch (e: Throwable) {
                promise.reject("NPU_BUNDLE_FAILED", e.message, e)
            }
        }
    }

    private fun describeBundle(modelName: String, paths: ModelPaths): WritableMap {
        val out = Arguments.createMap()
        out.putString("modelName", modelName)
        out.putString("resolvedName", paths.model_name)
        out.putString("modelPath", paths.model_path)
        out.putString("modelDir", paths.model_dir)
        out.putString("tokenizerPath", paths.tokenizer_path)
        // The manifest's own word on which runtime this is for. The TS side
        // refuses anything that is not "qairt" before a load is attempted.
        out.putString("runtimeId", paths.runtime_id)
        out.putString("modelType", paths.model_type.name)

        val dir = File(stripScheme(paths.model_dir))
        val files = Arguments.createArray()
        var totalBytes = 0L
        if (dir.isDirectory) {
            // Sorted so two installs of the same bundle produce the same list,
            // which is what makes a recorded manifest comparable later.
            dir.walkTopDown()
                .filter { it.isFile }
                .sortedBy { it.absolutePath }
                .forEach { file ->
                    val size = file.length()
                    totalBytes += size
                    val entry = Arguments.createMap()
                    entry.putString("path", file.relativeTo(dir).path.replace(File.separatorChar, '/'))
                    entry.putDouble("sizeBytes", size.toDouble())
                    if (size in 1..HASHABLE_MAX_BYTES) {
                        entry.putString("sha256", sha256Of(file))
                    }
                    files.pushMap(entry)
                }
        }
        out.putArray("files", files)
        out.putDouble("totalBytes", totalBytes.toDouble())
        return out
    }

    private fun sha256Of(file: File): String? =
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
            digest.digest().joinToString("") { "%02x".format(it) }
        } catch (e: Throwable) {
            null
        }

    @ReactMethod
    fun removeBundle(modelName: String, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    // Nothing to remove if the runtime never came up; that is not
                    // an error the user can act on.
                    promise.resolve(null)
                    return@launch
                }
                if (loadedModelName == modelName) releaseLlm()
                val rc = ModelManagerWrapper.remove(modelName)
                if (rc != 0) {
                    promise.reject("NPU_REMOVE_FAILED", "GenieX could not remove $modelName (rc=$rc)")
                    return@launch
                }
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("NPU_REMOVE_FAILED", e.message, e)
            }
        }
    }

    // ── Load ─────────────────────────────────────────────────────────────

    /**
     * Creates the QAIRT/NPU session, or fails saying why. No fallback.
     */
    @ReactMethod
    fun load(configJson: String, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.reject("NPU_UNAVAILABLE", initError ?: "No usable Qualcomm NPU runtime on this device")
                    return@launch
                }
                val config = JSONObject(configJson)
                val modelName = config.optString("modelName", "").ifBlank { null }

                // A bundle is addressed by NAME, and the model manager resolves
                // it to paths. A raw path is accepted only as a fallback for a
                // bundle the manager does not know about.
                val paths = modelName?.let { ModelManagerWrapper.getPaths(it) }
                val modelPath = stripScheme(paths?.model_path ?: config.optString("modelPath", ""))
                val tokenizerPath =
                    stripScheme(
                        paths?.tokenizer_path?.takeIf { it.isNotBlank() }
                            ?: config.optString("tokenizerPath", "").ifBlank { defaultTokenizerPath(modelPath) },
                    )

                if (modelPath.isBlank() || !File(modelPath).exists()) {
                    promise.reject(
                        "NPU_MODEL_MISSING",
                        "Model artifact not found: ${modelPath.ifBlank { modelName ?: "(no path)" }}",
                    )
                    return@launch
                }

                // The manifest's runtime_id is authoritative. Loading a
                // llama.cpp GGUF through this module would work — GenieX would
                // happily run it on its own CPU plugin — and would then be
                // reported as NPU. Refuse instead.
                val manifestRuntime = paths?.runtime_id?.takeIf { it.isNotBlank() }
                if (manifestRuntime != null && manifestRuntime != RuntimeIdValue.QAIRT.value) {
                    promise.reject(
                        "NPU_WRONG_RUNTIME",
                        "$modelName is a ${manifestRuntime} model, not a Qualcomm AI Engine Direct bundle.",
                    )
                    return@launch
                }

                releaseLlm()

                // QAIRT rejects a non-zero n_ctx and n_gpu_layers: both are
                // fixed at compile time inside the bundle, and the Kotlin
                // defaults are non-zero. The plugin's own strings say so
                // ("--nctx (n_ctx) is not supported by the qairt plugin"), and
                // Qualcomm's sample zeroes them for exactly this reason.
                val modelConfig =
                    ModelConfig().apply {
                        nCtx = 0
                        nGpuLayers = 0
                    }

                val started = System.currentTimeMillis()
                val input =
                    LlmCreateInput(
                        modelPath,
                        tokenizerPath,
                        modelConfig,
                        RuntimeIdValue.QAIRT.value,
                        ComputeUnitValue.NPU.value,
                    )

                val built = LlmWrapper.builder().llmCreateInput(input).build()
                val wrapper =
                    built.getOrElse { error ->
                        promise.reject(
                            "NPU_LOAD_FAILED",
                            error.message ?: "GenieX could not create a QAIRT/NPU session",
                            error,
                        )
                        return@launch
                    }
                llm = wrapper
                loadedModelName = modelName

                // Everything a diagnostics screen may claim about this session,
                // assembled at the moment it was created. Each field is something
                // that was REQUESTED or REPORTED, and is labelled as such on the
                // other side — GenieX exposes no post-hoc "this ran on the NPU"
                // attestation, and none is invented here.
                val attestation =
                    runtimeInfo {
                        it.putBoolean("available", true)
                        it.putString("modelPath", modelPath)
                        it.putString("tokenizerPath", tokenizerPath)
                        it.putString("manifestRuntimeId", manifestRuntime)
                        it.putDouble("loadMs", (System.currentTimeMillis() - started).toDouble())
                    }
                promise.resolve(attestation)
            } catch (e: Throwable) {
                promise.reject("NPU_LOAD_FAILED", e.message, e)
            }
        }
    }

    // ── Generate ─────────────────────────────────────────────────────────

    @ReactMethod
    fun generate(messagesJson: String, optionsJson: String, promise: Promise) {
        val wrapper = llm
        if (wrapper == null) {
            promise.reject("NPU_NOT_LOADED", "No NPU model loaded")
            return
        }
        val job =
            scope.launch {
                try {
                    val options = JSONObject(optionsJson)
                    val messages = parseMessages(messagesJson)

                    // The runtime's own switch, the same contract as llama.rn's
                    // enable_thinking: assist mode suppresses reasoning AT
                    // GENERATION rather than stripping it afterwards.
                    val enableThinking = options.optBoolean("enableThinking", true)
                    val templated =
                        wrapper.applyChatTemplate(messages, null, enableThinking, true).getOrElse { error ->
                            promise.reject(
                                "NPU_TEMPLATE_FAILED",
                                error.message ?: "chat template failed",
                                error,
                            )
                            return@launch
                        }
                    val prompt = templated.formattedText

                    val generation =
                        GenerationConfig().apply {
                            maxTokens = options.optInt("maxTokens", 320)
                            samplerConfig =
                                SamplerConfig().apply {
                                    temperature = options.optDouble("temperature", 0.3).toFloat()
                                    if (options.has("topP")) topP = options.optDouble("topP").toFloat()
                                }
                        }

                    partialText.setLength(0)
                    var profile: ProfilingData? = null
                    var failure: Throwable? = null
                    val emitTokens = options.optBoolean("streamTokens", true)

                    wrapper.generateStreamFlow(prompt, generation).collect { result ->
                        when (result) {
                            is LlmStreamResult.Token -> {
                                partialText.append(result.text)
                                if (emitTokens) {
                                    val payload = Arguments.createMap()
                                    payload.putString("token", result.text)
                                    reactApplicationContext.emitDeviceEvent(EVENT_TOKEN, payload)
                                }
                            }

                            // No else branch: LlmStreamResult is sealed over
                            // exactly these three, and the compiler says so.
                            // Adding one back would silently swallow a fourth
                            // case a future SDK introduces instead of failing
                            // the build, which is when we would want to know.
                            is LlmStreamResult.Completed -> profile = result.profile
                            is LlmStreamResult.Error -> failure = result.throwable
                        }
                    }

                    val error = failure
                    if (error != null) {
                        promise.reject("NPU_GENERATE_FAILED", error.message ?: "generation failed", error)
                        return@launch
                    }
                    promise.resolve(resultMap(partialText.toString(), profile, canceled = false))
                } catch (e: kotlinx.coroutines.CancellationException) {
                    // A user-cancelled turn is not a failure. Hand back what was
                    // produced so the caller can show it rather than an error —
                    // and say it was cancelled, so no one reads the (absent)
                    // profiling numbers as a completed run.
                    promise.resolve(resultMap(partialText.toString(), null, canceled = true))
                } catch (e: Throwable) {
                    promise.reject("NPU_GENERATE_FAILED", e.message, e)
                } finally {
                    partialText.setLength(0)
                }
            }
        generateJob = job
    }

    private fun resultMap(text: String, profile: ProfilingData?, canceled: Boolean): WritableMap {
        val map = Arguments.createMap()
        map.putString("text", text)
        map.putBoolean("canceled", canceled)
        // Only what the runtime actually reported. A caller that sees a missing
        // field must say "not reported", never substitute a plausible number.
        if (profile != null) {
            map.putDouble("ttftMs", profile.ttftMs)
            map.putDouble("promptTimeMs", profile.promptTimeMs)
            map.putDouble("decodeTimeMs", profile.decodeTimeMs)
            map.putDouble("promptTokens", profile.promptTokens.toDouble())
            map.putDouble("generatedTokens", profile.generatedTokens.toDouble())
            map.putDouble("prefillSpeed", profile.prefillSpeed)
            map.putDouble("decodeSpeed", profile.decodingSpeed)
            map.putString("stopReason", profile.stopReason)
        }
        return map
    }

    // ── Cancel / unload ──────────────────────────────────────────────────

    @ReactMethod
    fun cancel() {
        val wrapper = llm ?: return
        scope.launch {
            try {
                wrapper.stopStream()
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "stopStream failed", e)
            }
            generateJob?.cancelAndJoin()
            generateJob = null
        }
    }

    @ReactMethod
    fun unload(promise: Promise) {
        scope.launch {
            try {
                releaseLlm()
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("NPU_UNLOAD_FAILED", e.message, e)
            }
        }
    }

    private suspend fun releaseLlm() {
        generateJob?.let {
            it.cancelAndJoin()
            generateJob = null
        }
        llm?.let { wrapper ->
            try {
                wrapper.destroy()
                wrapper.close()
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "destroy failed", e)
            }
        }
        llm = null
        loadedModelName = null
    }

    override fun invalidate() {
        // The NPU session holds a large allocation; a torn-down React context
        // must not leave it behind.
        runBlocking { releaseLlm() }
        super.invalidate()
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun stripScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    // A bundle ships its tokenizer beside the weights; only fall back to that
    // convention when neither the manifest nor the caller said where it is.
    private fun defaultTokenizerPath(modelPath: String): String {
        if (modelPath.isBlank()) return ""
        val file = File(stripScheme(modelPath))
        val dir = if (file.isDirectory) file else file.parentFile ?: return ""
        return File(dir, "tokenizer.json").absolutePath
    }

    private fun parseMessages(json: String): Array<ChatMessage> {
        val array = JSONArray(json)
        return Array(array.length()) { i ->
            val item = array.getJSONObject(i)
            ChatMessage(item.optString("role", "user"), item.optString("content", ""))
        }
    }
}
