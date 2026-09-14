package com.cosmico.vesta

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Android system text-to-speech, for the assistant surface.
 *
 * The system engine, never a cloud voice: the assistant reads back timers and
 * short answers, and shipping those to a server would undo the point of the
 * app. Whatever the user has set as their TTS engine is what speaks.
 *
 * One utterance at a time, by design. A new `speak()` flushes whatever is
 * playing (QUEUE_FLUSH), and `stop()` cuts it off — so a second assistant
 * invocation or a dismissal never leaves the previous answer talking over the
 * new one.
 *
 * `onDone` fires once per utterance, on completion, failure, OR interruption,
 * so a caller waiting to dismiss its UI is never left hanging on an engine
 * that went quiet.
 */
class VestaSpeaker(context: Context) {

    private val appContext = context.applicationContext
    private var tts: TextToSpeech? = null

    @Volatile
    private var ready = false

    @Volatile
    private var failed = false

    // Queued while the engine is still starting up (init is async and the first
    // assistant utterance usually arrives before it finishes).
    private var queued: Pair<String, String>? = null

    private val ids = AtomicLong(0)

    // The completion callback for the utterance in flight, taken (not copied)
    // by whichever terminal event happens first.
    @Volatile
    private var onDone: ((String) -> Unit)? = null

    @Volatile
    private var currentId: String? = null

    private fun finish(id: String, reason: String) {
        // Only the utterance actually in flight may complete the callback: a
        // late event from a flushed one must not dismiss the new turn's UI.
        if (id != currentId) return
        val callback = onDone
        onDone = null
        currentId = null
        callback?.invoke(reason)
    }

    private fun ensureEngine() {
        if (tts != null || failed) return
        tts = TextToSpeech(appContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ready = true
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        finish(utteranceId ?: "", "done")
                    }

                    override fun onStop(utteranceId: String?, interrupted: Boolean) {
                        finish(utteranceId ?: "", "stopped")
                    }

                    @Deprecated("Required by the pre-API-21 interface")
                    override fun onError(utteranceId: String?) {
                        finish(utteranceId ?: "", "error")
                    }

                    override fun onError(utteranceId: String?, errorCode: Int) {
                        finish(utteranceId ?: "", "error")
                    }
                })
                queued?.let { (text, language) ->
                    queued = null
                    enqueue(text, language)
                }
            } else {
                // No usable engine on this device. Speech is an enhancement, so
                // this is reported, not thrown: the text is on screen either way.
                Log.w("VestaSpeaker", "TextToSpeech init failed: $status")
                failed = true
                ready = false
                val pending = queued
                queued = null
                if (pending != null) finish(currentId ?: "", "unavailable")
            }
        }
    }

    private fun enqueue(text: String, language: String) {
        val engine = tts ?: return
        applyLanguage(engine, language)
        val id = currentId ?: return
        val params = Bundle()
        params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
        if (result != TextToSpeech.SUCCESS) finish(id, "error")
    }

    // Best effort: the app's language if the engine has it, otherwise leave the
    // engine's own default rather than forcing a voice it cannot produce.
    private fun applyLanguage(engine: TextToSpeech, language: String) {
        if (language.isBlank()) return
        try {
            val locale = Locale.forLanguageTag(language)
            val availability = engine.isLanguageAvailable(locale)
            if (availability == TextToSpeech.LANG_AVAILABLE ||
                availability == TextToSpeech.LANG_COUNTRY_AVAILABLE ||
                availability == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE
            ) {
                engine.language = locale
            }
        } catch (e: Exception) {
            Log.w("VestaSpeaker", "could not set TTS language '$language'", e)
        }
    }

    /**
     * Speaks `text`, cutting off anything already playing. `onComplete` is
     * called exactly once with "done", "stopped", "error" or "unavailable".
     */
    fun speak(text: String, language: String, onComplete: (String) -> Unit) {
        // Retire the previous utterance's waiter before starting a new one, so
        // it resolves instead of being orphaned by the flush below.
        finish(currentId ?: "", "stopped")

        if (text.isBlank()) {
            onComplete("done")
            return
        }
        if (failed) {
            onComplete("unavailable")
            return
        }

        val id = "vesta-${ids.incrementAndGet()}"
        currentId = id
        onDone = onComplete

        ensureEngine()
        if (ready) enqueue(text, language) else queued = text to language
    }

    /** Cuts off speech. Safe to call when nothing is playing. */
    fun stop() {
        queued = null
        try {
            tts?.stop()
        } catch (e: Exception) {
            Log.w("VestaSpeaker", "stop failed", e)
        }
        finish(currentId ?: "", "stopped")
    }

    /** Releases the engine. Call from the module's teardown. */
    fun shutdown() {
        stop()
        try {
            tts?.shutdown()
        } catch (e: Exception) {
            Log.w("VestaSpeaker", "shutdown failed", e)
        }
        tts = null
        ready = false
    }
}
