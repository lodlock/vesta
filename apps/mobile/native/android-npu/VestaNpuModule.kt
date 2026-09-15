package com.cosmico.vesta

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.geniex.sdk.GenieXSdk
import com.geniex.sdk.LlmWrapper
import com.geniex.sdk.bean.ChatMessage
import com.geniex.sdk.bean.ComputeUnitValue
import com.geniex.sdk.bean.GenerationConfig
import com.geniex.sdk.bean.LlmCreateInput
import com.geniex.sdk.bean.LlmStreamResult
import com.geniex.sdk.bean.ModelConfig
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

/**
 * The Qualcomm NPU bridge, over the GenieX SDK.
 *
 * ONLY COMPILED INTO A BUILD MADE WITH VESTA_ENABLE_NPU=1. The config plugin
 * copies this file and adds the Maven dependency together; in a default build
 * neither exists, `NativeModules.VestaNpuModule` is undefined, and the
 * TypeScript backend reports the NPU unavailable. That is why this file lives
 * outside native/android/ — everything in there is copied unconditionally.
 *
 * Written against the real API of geniex-android 0.4.0, read out of the AAR
 * with javap, not inferred:
 *
 *   GenieXSdk.getInstance().init(context, InitCallback)     async, once
 *   registerPlugin(PLUGIN_ID_QAIRT): Int                    0 == ok
 *   getPluginVersion(PLUGIN_ID_QAIRT): String
 *   LlmWrapper.builder().llmCreateInput(input).build()      suspend, Result<LlmWrapper>
 *   LlmCreateInput(model_path, tokenizer_path, ModelConfig, runtime_id, compute_unit)
 *   generateStreamFlow(prompt, GenerationConfig): Flow<LlmStreamResult>
 *   applyChatTemplate(messages, tools, enableThinking, addGenerationPrompt)
 *   stopStream() / destroy()
 *
 * GenieX is Kotlin, so everything it exposes as `getX()` in the bytecode is a
 * PROPERTY, not a callable getter: `profile.ttftMs`, not `profile.getTtftMs()`.
 * The names below are the ones in the AAR's Kotlin metadata, verified with
 * javap, including the two that do not follow from the Java signature —
 * ProfilingData.decodingSpeed (not decodeSpeed) and the snake_case
 * LlmCreateInput(model_path, tokenizer_path, config, runtime_id, compute_unit).
 *
 * The profiling numbers reported back are the runtime's own (ProfilingData:
 * TTFT, prefill/decode speed, token counts). Nothing here invents a metric —
 * a field the runtime does not give us is absent, not guessed.
 */
class VestaNpuModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "VestaNpuModule"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile private var sdkReady = false
    @Volatile private var pluginVersion: String? = null
    @Volatile private var llm: LlmWrapper? = null
    @Volatile private var computeUnit: String? = null
    private var generateJob: Job? = null

    // ── Probe ────────────────────────────────────────────────────────────
    // "Is there a usable runtime here?" — answered by actually initializing
    // it and registering the QAIRT plugin, not by the class being on the
    // classpath. A device without Hexagon reaches this code and must come away
    // with null rather than a false promise.
    @ReactMethod
    fun probe(promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.resolve(null)
                    return@launch
                }
                val info = Arguments.createMap()
                info.putString("version", pluginVersion)
                info.putString("computeUnit", computeUnit)
                info.putString("soc", android.os.Build.SOC_MODEL)
                promise.resolve(info)
            } catch (e: Throwable) {
                // A runtime that cannot start is a runtime we will not use.
                promise.resolve(null)
            }
        }
    }

    private suspend fun ensureSdk(): Boolean {
        if (sdkReady) return true
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
                            android.util.Log.w("VestaNpu", "GenieX init failed: $message")
                            if (cont.isActive) cont.resumeWith(Result.success(false))
                        }
                    },
                )
            } catch (e: Throwable) {
                if (cont.isActive) cont.resumeWith(Result.success(false))
            }
        }
        if (!started) return false

        // QAIRT is the Hexagon path. Registering it is what makes the NPU
        // available; without it GenieX would quietly fall back to its own
        // llama.cpp plugin on the CPU — which this app already has, and which
        // must never be reported as "NPU".
        val registered = sdk.registerPlugin(GenieXSdk.PLUGIN_ID_QAIRT)
        if (registered != 0) {
            android.util.Log.w("VestaNpu", "QAIRT plugin unavailable (code $registered)")
            return false
        }
        pluginVersion = try {
            sdk.getPluginVersion(GenieXSdk.PLUGIN_ID_QAIRT)
        } catch (e: Throwable) {
            null
        }
        sdkReady = true
        return true
    }

    // ── Load ─────────────────────────────────────────────────────────────
    @ReactMethod
    fun load(configJson: String, promise: Promise) {
        scope.launch {
            try {
                if (!ensureSdk()) {
                    promise.reject("NPU_UNAVAILABLE", "No usable Qualcomm NPU runtime on this device")
                    return@launch
                }
                val config = JSONObject(configJson)
                val modelPath = config.getString("modelPath")
                val tokenizerPath = config.optString("tokenizerPath", "")
                    .ifBlank { defaultTokenizerPath(modelPath) }

                if (!File(stripScheme(modelPath)).exists()) {
                    promise.reject("NPU_MODEL_MISSING", "Model artifact not found: $modelPath")
                    return@launch
                }

                releaseLlm()

                val input = LlmCreateInput(
                    stripScheme(modelPath),
                    stripScheme(tokenizerPath),
                    ModelConfig(nCtx = config.optInt("contextSize", 4096)),
                    RuntimeIdValue.QAIRT.value,
                    ComputeUnitValue.NPU.value,
                )

                val built = LlmWrapper.builder().llmCreateInput(input).build()
                val wrapper = built.getOrElse { error ->
                    promise.reject("NPU_LOAD_FAILED", error.message ?: "GenieX could not load the model", error)
                    return@launch
                }
                llm = wrapper
                computeUnit = ComputeUnitValue.NPU.value

                val info = Arguments.createMap()
                info.putString("version", pluginVersion)
                info.putString("computeUnit", computeUnit)
                info.putString("soc", android.os.Build.SOC_MODEL)
                promise.resolve(info)
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
        val job = scope.launch {
            try {
                val options = JSONObject(optionsJson)
                val messages = parseMessages(messagesJson)

                // The runtime's own switch, the same contract as llama.rn's
                // enable_thinking: assist mode suppresses reasoning at
                // generation rather than stripping it afterwards.
                val enableThinking = options.optBoolean("enableThinking", true)
                val templated = wrapper.applyChatTemplate(messages, null, enableThinking, true)
                val prompt = templated.getOrElse { error ->
                    promise.reject("NPU_TEMPLATE_FAILED", error.message ?: "chat template failed", error)
                    return@launch
                }.formattedText

                val sampler = SamplerConfig(
                    temperature = options.optDouble("temperature", 0.3).toFloat(),
                )
                val generation = GenerationConfig(
                    maxTokens = options.optInt("maxTokens", 320),
                    samplerConfig = sampler,
                )

                val text = StringBuilder()
                var profile: ProfilingData? = null
                var failure: Throwable? = null

                wrapper.generateStreamFlow(prompt, generation).collect { result ->
                    when (result) {
                        is LlmStreamResult.Token -> text.append(result.text)
                        is LlmStreamResult.Completed -> profile = result.profile
                        is LlmStreamResult.Error -> failure = result.throwable
                        else -> {}
                    }
                }

                val error = failure
                if (error != null) {
                    promise.reject("NPU_GENERATE_FAILED", error.message ?: "generation failed", error)
                    return@launch
                }
                promise.resolve(resultMap(text.toString(), profile))
            } catch (e: kotlinx.coroutines.CancellationException) {
                // A user-cancelled turn is not a failure; hand back whatever was
                // produced so the caller can show it rather than an error.
                promise.resolve(resultMap("", null))
            } catch (e: Throwable) {
                promise.reject("NPU_GENERATE_FAILED", e.message, e)
            }
        }
        generateJob = job
    }

    private fun resultMap(text: String, profile: ProfilingData?): WritableMap {
        val map = Arguments.createMap()
        map.putString("text", text)
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
                android.util.Log.w("VestaNpu", "stopStream failed", e)
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
                android.util.Log.w("VestaNpu", "destroy failed", e)
            }
        }
        llm = null
        computeUnit = null
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
    // convention when the caller did not say where it is.
    private fun defaultTokenizerPath(modelPath: String): String {
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
