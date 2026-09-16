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
import java.util.concurrent.TimeUnit

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
 *   ModelManagerWrapper.listHubModels(domain): List<HubModel> suspend
 *   ModelManagerWrapper.resolveAlias(name): String?           suspend
 *   ModelManagerWrapper.remove(name): Int                     suspend
 *   LlmWrapper.builder().llmCreateInput(input).build()        suspend, Result<LlmWrapper>
 *   LlmCreateInput(model_path, tokenizer_path, ModelConfig, runtime_id, compute_unit)
 *   applyChatTemplate(messages, tools, enableThinking, addGenerationPrompt)
 *   generateStreamFlow(prompt, GenerationConfig): Flow<LlmStreamResult>
 *   stopStream() / destroy()
 *
 * Everything in `com.geniex.sdk.jni` is INTERNAL to the SDK and unusable from
 * here, however public it looks in `javap` — Kotlin `internal` compiles to JVM
 * `public`, and only the Kotlin metadata carries the distinction. See the note
 * above the hub interrogation block.
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

        /** Cache-report bounds. Metadata is small; the weights are not. */
        private const val MAX_CACHE_ENTRIES = 200
        // Small enough to read in a copied report; platform.json fits.
        private const val MAX_JSON_BYTES = 8L * 1024L
        private const val MAX_MANIFEST_MATCHES = 12
        private const val MAX_MATCH_CHARS = 4000

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

        /**
         * The one logcat tag every GenieX 0.4.0 line arrives under — the
         * native log callback, stdout and stderr alike. See [genieXLogReport]
         * for where that is established.
         */
        private const val GENIEX_LOG_TAG = "GenieXSdk"

        /** Capture bounds. A diagnostic that has to be scrolled past is noise. */
        private const val DEFAULT_LOG_LINES = 400
        private const val MAX_LOG_LINES = 2000
        private const val LOGCAT_TIMEOUT_MS = 5_000L

        /**
         * The two lines `libnpu_jni.so`'s `JNI_OnLoad` writes to stdout and
         * stderr immediately after installing the redirect. Seeing either is
         * proof the redirect is live in THIS process, rather than an inference
         * from the binary.
         */
        private const val STDOUT_SELF_TEST = "GENIEX SDK: stdout redirection test"
        private const val STDERR_SELF_TEST = "GENIEX SDK: stderr redirection test"

        /** The priority letter in logcat's `threadtime` format. */
        private val LOGCAT_PRIORITY =
            Regex("""^\d{2}-\d{2} [\d:.]+\s+\d+\s+\d+\s+([VDIWEF])\s""")

        /**
         * A query parameter whose NAME says its value is a credential. The
         * name is kept — it is diagnostic — and the value is not.
         */
        private val SECRET_QUERY_PARAM =
            Regex(
                """([?&][A-Za-z0-9_-]*""" +
                    """(?:token|signature|credential|secret|password|accesskey|apikey)""" +
                    """[A-Za-z0-9_-]*)=[^&\s"']+""",
                RegexOption.IGNORE_CASE,
            )

        /** `Authorization: Bearer …`, in whatever shape it reaches a log line. */
        private val AUTH_SCHEME_TOKEN =
            Regex("""(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}""", RegexOption.IGNORE_CASE)
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
    /**
     * Writes a diagnostic block to logcat under this module's own tag.
     *
     * So `adb logcat -s VestaNpu` carries the identity probe in the SAME
     * capture as the pull request and its failure — three things that have to
     * be read together and were landing under two different tags
     * (ReactNativeJS for anything console.log touched).
     *
     * Split per line rather than logged as one blob: logcat truncates a single
     * entry at a few kilobytes, and a truncated diagnostic is the problem this
     * whole pass exists to fix.
     */
    @ReactMethod
    fun logDiagnostic(message: String) {
        for (line in message.lines()) {
            android.util.Log.i(TAG, line)
        }
    }

    /**
     * GenieX's own native logging, read back out of this process's logcat.
     *
     * A diagnostic surface only: this file is compiled into a build made with
     * VESTA_ENABLE_NPU=1, and nothing but the Diagnostics screen calls it.
     *
     * ## There is no verbosity switch, and that is the finding
     *
     * `GENIEX_LOG` does not exist in geniex-android 0.4.0. The string is in
     * none of the 52 native libraries the AAR ships and in none of its
     * classes. The environment variables the SDK does read are
     * `GENIEX_AIHUBBASEURL`, `GENIEX_AIHUBVERSION`, `GENIEX_HFTOKEN`,
     * `GENIEX_DATADIR`, `GENIEX_PLUGIN_PATH`, `GENIEX_DL_CHUNK_SIZE`,
     * `GENIEX_DL_FILE_CONCURRENCY`, `GENIEX_DL_CHUNK_CONCURRENCY`,
     * `GENIEX_DECODE_WORKERS`, `GENIEX_DECODE_CPUMASK`, `GENIEX_DECODE_POLL`,
     * `GENIEX_CLOCK_KEEPER_THREADS` and `GENIEX_DUMP_IO` — that is the whole
     * list. A `setenv("GENIEX_LOG", "trace", 1)` before init would set a
     * variable nothing reads, so no such bridge was added.
     *
     * What 0.4.0 has instead is a C sink, in `libgeniex.so`'s dynamic symbols:
     *
     *     extern void (*geniex_log)(int level, const char *msg);   // .data
     *     extern int   geniex_log_level;                           // .bss
     *     int          geniex_set_log(void (*cb)(int, const char *));
     *
     * Levels are 0 TRACE, 1 DEBUG, 2 INFO, 3 WARN, 4 ERROR — the built-in sink
     * indexes a five-entry table of `[TRACE] `, `[DEBUG] `, `[ INFO] `,
     * `[ WARN] `, `[ERROR] `. Every call site is gated on
     * `geniex_log_level <= level && geniex_log != nullptr`, and no library in
     * the AAR ever writes `geniex_log_level`: it is a four-byte `.bss` object
     * that stays **0 — TRACE — from the first instruction**. There is no
     * verbosity left to raise.
     *
     * The sink is already connected, too. `libnpu_jni.so`'s `JNI_OnLoad` calls
     * `geniex_set_log()` with a callback that does
     * `__android_log_print(level + 2, "GenieXSdk", "%s", msg)` — TRACE lands
     * at VERBOSE, ERROR at ERROR — and then redirects this process's stdout
     * and stderr into the same tag as `[STDOUT] …` and `[STDERR] …`. GenieX is
     * at maximum verbosity, in logcat, under one tag, before Vesta's first
     * line of Kotlin runs.
     *
     * Which leaves exactly one useful thing to do: read it. An app may read
     * its own logcat entries without READ_LOGS, and every GenieX line is
     * written by our own process.
     *
     * ## What it will not tell you
     *
     * The AI Hub endpoint, the manifest URL, cache hits and misses, the
     * release-assets URL and the HTTP status are absent at every level,
     * because they were never written. That half of the SDK is Rust inside
     * `libgeniex.so`, and it reaches the sink through exactly six
     * `geniex_model_log_emit()` call sites: "geniex model manager
     * initialized", the already-initialized warning, and four error paths.
     * Not one carries a URL, a cache decision or a status code. Those
     * questions stay answered by [hubCacheReport] and [hubListProbe], which
     * read the manifests the runtime cached in our own data directory.
     *
     * Anything credential-shaped is blanked before it crosses the bridge —
     * see [redactSecrets].
     */
    @ReactMethod
    fun genieXLogReport(configJson: String, promise: Promise) {
        scope.launch {
            val out = Arguments.createMap()
            out.putString("tag", GENIEX_LOG_TAG)
            try {
                val config = JSONObject(configJson)
                val maxLines =
                    config.optInt("maxLines", DEFAULT_LOG_LINES).coerceIn(1, MAX_LOG_LINES)

                // Brought up first when it is not already. A capture taken
                // before init would truthfully report that GenieX has logged
                // nothing, which is not the question anyone is asking.
                val started = ensureSdk()
                out.putBoolean("sdkStarted", started)
                if (!started) out.putString("initError", initError)

                // No `-t`: logcat's tail count is applied by logd to the
                // buffer as a whole and the tag filter only afterwards, in the
                // client, so `-t 400` on a chatty process can hand back zero
                // GenieX lines. The whole filtered dump is read instead and the
                // budget applied here, to the lines that actually matched.
                val argv =
                    arrayOf("logcat", "-d", "-v", "threadtime", "-s", "$GENIEX_LOG_TAG:V")
                out.putString("command", argv.joinToString(" "))

                val (raw, totalLines) = readOwnLogcat(argv, maxLines)
                val counts = linkedMapOf("V" to 0, "D" to 0, "I" to 0, "W" to 0, "E" to 0)
                val captured: WritableArray = Arguments.createArray()
                for (line in raw) {
                    val safe = redactSecrets(line)
                    LOGCAT_PRIORITY.find(safe)?.groupValues?.get(1)?.let { p ->
                        counts[p] = (counts[p] ?: 0) + 1
                    }
                    captured.pushString(safe)
                }
                out.putArray("lines", captured)
                out.putInt("lineCount", raw.size)
                out.putInt("totalLines", totalLines)
                out.putBoolean("truncated", totalLines > raw.size)

                val byPriority = Arguments.createMap()
                counts.forEach { (k, v) -> byPriority.putInt(k, v) }
                out.putMap("byPriority", byPriority)

                // JNI_OnLoad's own probes. Either one proves the redirect is
                // live in this process — unless the ring buffer has already
                // rolled past process start, which is why absence is reported
                // as a boolean and never as a failure.
                out.putBoolean("sawStdoutSelfTest", raw.any { it.contains(STDOUT_SELF_TEST) })
                out.putBoolean("sawStderrSelfTest", raw.any { it.contains(STDERR_SELF_TEST) })

                // A VERBOSE line is a TRACE line that passed the gate, and is
                // the only on-device confirmation available that
                // geniex_log_level is still 0.
                out.putBoolean("verboseSeen", (counts["V"] ?: 0) > 0)

                promise.resolve(out)
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "genieXLogReport failed", e)
                out.putString("error", e.message ?: e.toString())
                promise.resolve(out)
            }
        }
    }

    /**
     * One `logcat -d`, read to completion: the last [maxLines] matching lines,
     * and how many there were in all.
     *
     * The NEWEST lines are the ones kept — a diagnostic taken right after a
     * failed pull is about what just happened — so the whole dump is read and
     * an old line is dropped for each new one past the budget. `-d` dumps and
     * exits, so this cannot hang on an endless stream; it is still waited on
     * with a bound, because a diagnostics screen that wedges is worse than one
     * that reports a timeout. logcat's own stderr is folded into the output on
     * purpose: when the capture comes back empty, logcat's complaint is the
     * only thing left to read.
     */
    private fun readOwnLogcat(argv: Array<String>, maxLines: Int): Pair<List<String>, Int> {
        val process = ProcessBuilder(*argv).redirectErrorStream(true).start()
        return try {
            val kept = ArrayDeque<String>(maxLines)
            var seen = 0
            process.inputStream.bufferedReader().use { reader ->
                reader.forEachLine { line ->
                    seen++
                    if (kept.size == maxLines) kept.removeFirst()
                    kept.addLast(line)
                }
            }
            process.waitFor(LOGCAT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            kept.toList() to seen
        } finally {
            process.destroy()
        }
    }

    /**
     * Blanks anything credential-shaped in a captured line.
     *
     * Applied at the source, before the line crosses the bridge, so a token
     * cannot reach the clipboard however the formatters downstream change.
     * Vesta never sets `GENIEX_HFTOKEN` and pins `hf_token` null in
     * [pullInputFrom], so on this path it should have nothing to do — which is
     * precisely why it costs nothing to keep. The parameter NAME survives;
     * only the value goes.
     */
    private fun redactSecrets(line: String): String =
        line
            .replace(SECRET_QUERY_PARAM, "\$1=REDACTED")
            .replace(AUTH_SCHEME_TOKEN, "\$1 REDACTED")

    /**
     * Finds the array of model entries in a manifest whose exact shape we have
     * never seen.
     *
     * `models` first, because that is the field name the binary's own serde
     * metadata lists for ReleaseManifest. Failing that, the first top-level
     * array whose elements look like model entries — so a schema change
     * degrades to "found it anyway" rather than to "no models", which would be
     * indistinguishable from the answer we are actually testing for.
     */
    private fun findModelsArray(root: JSONObject): Pair<String, JSONArray>? {
        root.optJSONArray("models")?.let { return "models" to it }
        val keys = root.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val arr = root.optJSONArray(key) ?: continue
            val first = arr.optJSONObject(0) ?: continue
            if (first.has("id") || first.has("display_name")) return key to arr
        }
        return null
    }

    /**
     * What a cached manifest says about one model, without shipping the
     * manifest.
     *
     * The file is 311 KB; the question is three booleans and a handful of
     * entries. Parsing here rather than in JavaScript keeps the whole thing off
     * the bridge and out of logcat — and the last two rounds established that
     * an abbreviated dump answers nothing, so the way to stay compact is to
     * send less, not to truncate more.
     */
    private fun analyseManifest(
        text: String,
        needle: String,
        wantDisplayName: String,
        wantId: String,
    ): WritableMap {
        val out = Arguments.createMap()
        val root =
            try {
                JSONObject(text)
            } catch (e: Throwable) {
                out.putString("parseError", e.message ?: e.toString())
                return out
            }

        // Top-level version fields, whatever they are called. The release a
        // manifest came from is the thing this whole report is chasing.
        val versions = Arguments.createMap()
        val topKeys = Arguments.createArray()
        val keys = root.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            topKeys.pushString(key)
            if (key.contains("version", ignoreCase = true)) {
                versions.putString(key, root.opt(key)?.toString())
            }
        }
        out.putArray("topLevelKeys", topKeys)
        out.putMap("versionFields", versions)

        val found = findModelsArray(root)
        if (found == null) {
            out.putString("modelsKey", null)
            out.putInt("modelCount", 0)
            return out
        }
        val (modelsKey, models) = found
        out.putString("modelsKey", modelsKey)
        out.putInt("modelCount", models.length())

        var exactDisplayName = false
        var exactId = false
        val matches: WritableArray = Arguments.createArray()

        for (i in 0 until models.length()) {
            val entry = models.optJSONObject(i) ?: continue
            val id = entry.optString("id", "")
            val displayName = entry.optString("display_name", "")

            if (displayName.equals(wantDisplayName, ignoreCase = true)) {
                exactDisplayName = true
            }
            if (id.equals(wantId, ignoreCase = true)) exactId = true

            if (
                matches.size() < MAX_MANIFEST_MATCHES &&
                    (id.contains(needle, ignoreCase = true) ||
                        displayName.contains(needle, ignoreCase = true))
            ) {
                // The whole object: every field, including the ones we have
                // not thought to ask about. That is the point of looking.
                val raw = entry.toString()
                matches.pushString(
                    if (raw.length <= MAX_MATCH_CHARS) raw
                    else raw.take(MAX_MATCH_CHARS) + "…(entry truncated)",
                )
            }
        }

        out.putBoolean("exactDisplayName", exactDisplayName)
        out.putBoolean("exactId", exactId)
        out.putArray("matches", matches)
        return out
    }

    /**
     * Lists hub models, with the manifest's mtime and size taken immediately
     * before and after.
     *
     * If listHubModels() refreshes or replaces the file that pull() then reads,
     * these two stats differ — and that would explain a catalogue and a
     * download disagreeing about the same model without either being wrong.
     */
    @ReactMethod
    fun hubListProbe(configJson: String, promise: Promise) {
        scope.launch {
            val out = Arguments.createMap()
            try {
                if (!ensureSdk()) {
                    out.putString("error", initError ?: "runtime unavailable")
                    promise.resolve(out)
                    return@launch
                }
                val config = JSONObject(configJson)
                val filter = config.optString("filter", "").ifBlank { null }
                val relative =
                    config.optString("manifestPath", "").ifBlank { "aihub/manifest.json" }
                val manifest = File(File(reactApplicationContext.filesDir, "geniex"), relative)

                out.putString("filter", filter)
                out.putMap("before", statOf(manifest))
                val models = ModelManagerWrapper.listHubModels(filter)
                out.putMap("after", statOf(manifest))

                out.putInt("count", models.size)
                val entries: WritableArray = Arguments.createArray()
                for (m in models) {
                    val entry = Arguments.createMap()
                    entry.putString("name", m.name)
                    entry.putString("modelType", m.model_type.name)
                    val chipsets = Arguments.createArray()
                    m.chipsets.forEach { chipsets.pushString(it) }
                    entry.putArray("chipsets", chipsets)
                    entries.pushMap(entry)
                }
                out.putArray("models", entries)
                promise.resolve(out)
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "hubListProbe failed", e)
                out.putString("error", e.message ?: e.toString())
                promise.resolve(out)
            }
        }
    }

    private fun statOf(file: File): WritableMap {
        val out = Arguments.createMap()
        out.putBoolean("exists", file.isFile)
        out.putDouble("sizeBytes", if (file.isFile) file.length().toDouble() else -1.0)
        out.putDouble("modifiedAt", if (file.isFile) file.lastModified().toDouble() else -1.0)
        return out
    }

    /**
     * Everything this app can see about where the AI Hub data came from.
     *
     * The runtime caches its hub metadata under OUR data directory — the
     * binary carries "aihub cache mkdir", "aihub cache write", "aihub
     * info.json fetch for" and "aihub info.json parse for" — so the manifests
     * that listHubModels() and pull() actually consulted are files we own and
     * may simply read. No reflection, no internal classes, nothing inferred.
     *
     * This exists to answer one question the SDK exposes no API for: whether
     * the catalogue listing and the download are looking at the same release.
     * listHubModels() finds Qwen3-4B-Instruct-2507; pull() reports it missing.
     * Both cannot be true of one manifest.
     *
     * `GENIEX_HFTOKEN` is reported as set/unset and NEVER by value. Nothing
     * else here is a credential.
     */
    @ReactMethod
    fun hubCacheReport(configJson: String, promise: Promise) {
        scope.launch {
            val out = Arguments.createMap()
            try {
                val config = JSONObject(configJson)
                val needle = config.optString("needle", "").ifBlank { "qwen3" }
                val wantDisplayName = config.optString("displayName", "")
                val wantId = config.optString("id", "")

                // The endpoint and release the native side resolves from. Read
                // through the public System.getenv rather than guessed: an
                // unset value is itself the answer (the SDK's built-in default
                // applies), and it is what decides which manifest is fetched.
                val env = Arguments.createMap()
                env.putString("GENIEX_AIHUBBASEURL", System.getenv("GENIEX_AIHUBBASEURL"))
                env.putString("GENIEX_AIHUBVERSION", System.getenv("GENIEX_AIHUBVERSION"))
                env.putString("GENIEX_DATADIR", System.getenv("GENIEX_DATADIR"))
                env.putString(
                    "GENIEX_HFTOKEN",
                    if (System.getenv("GENIEX_HFTOKEN").isNullOrBlank()) "unset" else "set",
                )
                out.putMap("env", env)

                val dir = File(reactApplicationContext.filesDir, "geniex")
                out.putString("dataDir", dir.absolutePath)
                out.putBoolean("dataDirExists", dir.isDirectory)

                val files: WritableArray = Arguments.createArray()
                if (dir.isDirectory) {
                    dir.walkTopDown()
                        .filter { it.isFile }
                        .sortedBy { it.absolutePath }
                        .take(MAX_CACHE_ENTRIES)
                        .forEach { f ->
                            val entry = Arguments.createMap()
                            entry.putString(
                                "path",
                                f.relativeTo(dir).path.replace(File.separatorChar, '/'),
                            )
                            entry.putDouble("sizeBytes", f.length().toDouble())
                            entry.putDouble("modifiedAt", f.lastModified().toDouble())
                            // JSON is the metadata; the multi-gigabyte weights
                            // are not, and reading one into a bridge map would
                            // take the screen down.
                            if (f.name.endsWith(".json", ignoreCase = true)) {
                                val text = f.readText()
                                // A targeted answer instead of the file. The
                                // real manifest is 311 KB and the question is
                                // three booleans plus a few entries; shipping
                                // the rest would bury the answer in logcat.
                                entry.putMap(
                                    "analysis",
                                    analyseManifest(text, needle, wantDisplayName, wantId),
                                )
                                // Small files still go in whole — platform.json
                                // is where aihm_version lives.
                                if (f.length() <= MAX_JSON_BYTES) {
                                    entry.putString("content", text)
                                }
                            }
                            files.pushMap(entry)
                        }
                }
                out.putArray("files", files)
                promise.resolve(out)
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "hubCacheReport failed", e)
                out.putString("error", e.message ?: e.toString())
                promise.resolve(out)
            }
        }
    }

    // ── Hub interrogation ────────────────────────────────────────────────
    //
    // Everything below asks the SAME source the pull itself resolves against,
    // rather than re-deriving Qualcomm's catalogue by hand. That distinction is
    // the whole reason these exist: an `rc=-100010` (hub model not found) is
    // unactionable without knowing what the hub DOES have, and a hand-written
    // answer to that question is stale the moment Qualcomm publishes anything.
    //
    // ## What is and is not callable
    //
    // `ModelManagerWrapper` is the public surface, and it is the whole of it:
    //
    //     listHubModels(domain) : List<HubModel>   ← used
    //     resolveAlias(name)    : String?          ← used
    //     listChipsets()        : List<ChipsetInfo>← used (chipset identity)
    //     pullFlow(input)       : Flow<PullEvent>  ← used
    //     getPaths / getType / list / remove / clean / detectChipset / init
    //
    // `com.geniex.sdk.jni.ModelManager` carries two more that would be useful
    // here — `query(ModelPullInput)`, a dry run returning per-precision
    // candidates and sizes, and `lastErrorMessage()`, the native text behind a
    // code. Neither is reachable: the class is **internal** in the SDK's Kotlin
    // metadata, and `javap` does not show that, because Kotlin `internal`
    // compiles to JVM `public`. An earlier version of this file constructed one
    // directly on exactly that misreading and did not compile. The only
    // reference to the type anywhere in the wrapper's signatures is a synthetic
    // `access$getNative$p()` whose RETURN type is equally inaccessible, so there
    // is no supported path and reflection would be breaking an encapsulation
    // the vendor declared deliberately.
    //
    // So the dry run is assembled from what IS public: `listHubModels()` gives
    // the model names and the chipsets each is offered for, `resolveAlias()`
    // resolves a name the catalogue may list differently, and the resolution
    // itself happens in TypeScript (lib/models/npu-hub.ts) where it is
    // testable. What is lost is the per-precision size, which nothing depended
    // on. What is kept is the thing that mattered: knowing whether an asset
    // exists for this chip before spending gigabytes finding out.

    /**
     * One ModelPullInput, built once, used by both pull() and importBundle().
     *
     * Shared on purpose: a download and an import that resolved differently
     * would be two definitions of the same request.
     *
     * `hf_token` is left null here and is never read from the config: nothing
     * in Vesta's NPU path uses a credential, and this keeps it impossible for
     * one to reach a log line.
     */
    private fun pullInputFrom(config: JSONObject): ModelPullInput {
        val hub =
            try {
                HubSource.valueOf(config.optString("hub", "AIHUB").uppercase())
            } catch (e: IllegalArgumentException) {
                HubSource.AIHUB
            }
        return ModelPullInput(
            config.getString("modelName"),
            config.optString("precision", "").ifBlank { null },
            hub,
            config.optString("localPath", "").ifBlank { null },
            null, // hf_token — never populated, never logged
            config.optString("chipset", "").ifBlank { null },
            config.optString("displayName", "").ifBlank { null },
            ModelType.LLM,
        )
    }

    /**
     * The whole request on one line, for the log.
     *
     * `model_type` is `ModelType?` in the SDK, so it is read with `?.` and
     * reported as "unspecified" when absent. `pullInputFrom` always passes
     * ModelType.LLM, so in practice it is never null — but the declared
     * contract is what this has to be written against, and `!!` on a value
     * that is merely expected is how a crash gets shipped. `hub` is NOT
     * nullable (the compiler accepts `input.hub.name`) and is read directly.
     */
    private fun describeRequest(input: ModelPullInput): String {
        val type = input.model_type?.name ?: "unspecified"
        return "model=${input.model_name} chipset=${input.chipset} " +
            "precision=${input.precision} hub=${input.hub.name} type=$type " +
            "runtime=${RuntimeIdValue.QAIRT.value} compute=${ComputeUnitValue.NPU.value}"
    }

    /**
     * Runs a pull flow to completion, emitting progress. Returns the failure as
     * `(rc, message)` or null on success.
     *
     * Shared by pull() and importBundle() so the progress events, the
     * cancellation behaviour and the error shape cannot diverge between them.
     */
    private suspend fun collectPull(
        input: ModelPullInput,
        modelName: String,
    ): Pair<Int, String>? {
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

                is ModelManagerWrapper.PullEvent.Error -> failure = event.code to event.message
            }
        }
        return failure
    }

    /**
     * A failure string that keeps the machine-readable parts machine-readable.
     *
     * `rc=<n>` first and always, because that is the only token that can be
     * looked up against Qualcomm's error definitions, and the TypeScript side
     * parses it back out to choose a readable sentence. The runtime's own
     * message follows, because `-100010` alone does not tell you WHICH model
     * the hub could not find.
     *
     * `PullEvent.Error(code, message)` is the whole public error surface here.
     * `ModelManager.lastErrorMessage()` would sometimes say more, but it lives
     * on an internal class — see the note on hub interrogation above — so the
     * flow's own message is what there is, and it is enough to identify the
     * request when read beside the `pull:` log line.
     */
    private fun formatPullFailure(rc: Int, message: String): String =
        if (message.isBlank()) "rc=$rc" else "rc=$rc: $message"

    /**
     * Every model the hub offers, with the chipsets it offers each one FOR.
     *
     * `HubModel.chipsets` is the authoritative answer to "can this device have
     * this model", in the hub's own vocabulary — which is also the string the
     * pull must then be given. Asking beats guessing: Android says `SM8850`,
     * GenieX's chipset table answers with a device name, and AI Hub's release
     * manifest keys on a third spelling. Only one of those resolves an asset,
     * and this is the call that says which.
     */
    @ReactMethod
    fun hubModels(domain: String?, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.reject("NPU_UNAVAILABLE", initError ?: "No usable Qualcomm NPU runtime")
                    return@launch
                }
                val models = ModelManagerWrapper.listHubModels(domain?.ifBlank { null })
                val entries: WritableArray = Arguments.createArray()
                for (m in models) {
                    val entry = Arguments.createMap()
                    entry.putString("name", m.name)
                    entry.putString("modelType", m.model_type.name)
                    val chipsets = Arguments.createArray()
                    m.chipsets.forEach { chipsets.pushString(it) }
                    entry.putArray("chipsets", chipsets)
                    entries.pushMap(entry)
                }
                android.util.Log.i(TAG, "listHubModels -> ${models.size} entries")
                val out = Arguments.createMap()
                out.putArray("models", entries)
                promise.resolve(out)
            } catch (e: Throwable) {
                // Resolved-with-error rather than rejected: "the hub could not
                // be reached" is an ANSWER the Models screen has to show, and
                // it is a different answer from "the hub does not have this".
                android.util.Log.w(TAG, "listHubModels failed", e)
                val out = Arguments.createMap()
                out.putString("error", e.message ?: e.toString())
                promise.resolve(out)
            }
        }
    }

    /**
     * The name the manager resolves an alias to. Null when it cannot, which is
     * itself worth knowing when a pull reports "model not found".
     */
    @ReactMethod
    fun resolveModelAlias(modelName: String, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.resolve(null)
                    return@launch
                }
                promise.resolve(ModelManagerWrapper.resolveAlias(modelName))
            } catch (e: Throwable) {
                promise.resolve(null)
            }
        }
    }

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
                    val input = pullInputFrom(config)
                    val modelName = input.model_name

                    if (input.hub == HubSource.AIHUB && input.chipset == null) {
                        promise.reject(
                            "NPU_CHIPSET_REQUIRED",
                            "An AI Hub bundle cannot be pulled without a chipset.",
                        )
                        return@launch
                    }

                    // The whole request, before a byte moves. Without this an
                    // rc=-100010 is a number with no subject: it does not say
                    // which name, which chipset or which precision was asked
                    // for, and those are exactly the three things that decide
                    // whether an asset resolves.
                    android.util.Log.i(TAG, "pull: ${describeRequest(input)}")

                    val failure = collectPull(input, modelName)

                    if (failure != null) {
                        // The request again, at the moment it failed. A code on
                        // its own is not diagnosable: it does not say which
                        // name, which chipset or which precision was asked for,
                        // and those are the three things that decide whether an
                        // asset resolves. Logged adjacent to the rc so one
                        // logcat capture carries both.
                        android.util.Log.w(
                            TAG,
                            "pull FAILED rc=${failure.first} for ${describeRequest(input)} " +
                                "(Build.SOC_MODEL=${socModel()}) :: ${failure.second}",
                        )
                        promise.reject(
                            "NPU_PULL_FAILED",
                            formatPullFailure(failure.first, failure.second),
                        )
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

    /**
     * Registers a bundle the user already has, from a local directory or a
     * `.zip`, through the manager's own `LOCALFS` source.
     *
     * Deliberately the same code path as the AI Hub pull, differing only in
     * `hub` and `local_path`. The manager does the unpacking, the layout
     * validation and the `runtime_id` determination it always does, and the
     * result goes through `describeBundle()` — so an imported bundle is
     * measured, hashed and recorded EXACTLY like a downloaded one. A separate
     * hand-rolled importer would be a second definition of "valid bundle", and
     * the two would drift.
     *
     * This exists because the hub path can fail for reasons no amount of client
     * code can fix: an asset that is not published for this chipset yet. A user
     * who has exported one themselves with `qai-hub-models` should not be
     * blocked on Qualcomm's release schedule.
     */
    @ReactMethod
    fun importBundle(configJson: String, promise: Promise) {
        if (pullJob?.isActive == true) {
            promise.reject("NPU_PULL_BUSY", "A bundle is already being installed")
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
                    val localPath = config.optString("localPath", "").ifBlank { null }
                    if (localPath == null) {
                        promise.reject("NPU_IMPORT_NO_PATH", "No bundle path was given.")
                        return@launch
                    }
                    val source = File(stripScheme(localPath))
                    if (!source.exists()) {
                        // Checked here rather than left to the manager, because
                        // "that path does not exist" is a mistake the user can
                        // fix and deserves to be told in those words.
                        promise.reject(
                            "NPU_IMPORT_NOT_FOUND",
                            "Nothing at $localPath — pick the bundle directory or its .zip.",
                        )
                        return@launch
                    }

                    val input = pullInputFrom(
                        JSONObject(configJson).put("hub", HubSource.LOCALFS.name),
                    )
                    android.util.Log.i(
                        TAG,
                        "import: ${describeRequest(input)} from=${source.absolutePath}",
                    )

                    val failure = collectPull(input, input.model_name)
                    if (failure != null) {
                        promise.reject(
                            "NPU_IMPORT_FAILED",
                            formatPullFailure(failure.first, failure.second),
                        )
                        return@launch
                    }
                    val paths = ModelManagerWrapper.getPaths(input.model_name)
                    if (paths == null) {
                        promise.reject(
                            "NPU_IMPORT_INCOMPLETE",
                            "The import ended without producing a complete bundle.",
                        )
                        return@launch
                    }
                    promise.resolve(describeBundle(input.model_name, paths))
                } catch (e: kotlinx.coroutines.CancellationException) {
                    promise.reject("NPU_PULL_CANCELED", "Import canceled")
                } catch (e: Throwable) {
                    promise.reject("NPU_IMPORT_FAILED", e.message, e)
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
