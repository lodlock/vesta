package com.cosmico.vesta

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Android system text-to-speech, for the assistant surface.
 *
 * The system engine, never a cloud voice: the assistant reads back timers and
 * answers, and shipping those to a server would undo the point of the app.
 * Whatever the user has set as their TTS engine is what speaks.
 *
 * One utterance at a time, by design. A new `speak()` flushes whatever is
 * playing (QUEUE_FLUSH), and `stop()` cuts it off — so a second assistant
 * invocation or a dismissal never leaves the previous answer talking over the
 * new one.
 *
 * `onDone` fires exactly once per `speak()`, on completion, failure OR
 * interruption, so a caller waiting to dismiss its UI is never left hanging on
 * an engine that went quiet.
 *
 * ── Long answers ────────────────────────────────────────────────────────────
 *
 * Two things used to cut a page-length answer off after a sentence or two, and
 * both are handled here:
 *
 *  1. Android refuses a single utterance longer than
 *     `getMaxSpeechInputLength()` (~4000 chars). Text is split on sentence
 *     boundaries and queued as consecutive chunks of ONE logical utterance; the
 *     caller is told it finished only when the last chunk does.
 *
 *  2. A flat watchdog cannot tell "the engine is dead" from "the engine is
 *     reading a long answer". So there are two stages:
 *
 *       stage 1  no onStart within START_TIMEOUT_MS → it never began. Report,
 *                and release the caller.
 *       stage 2  onStart arrived, so playback is real. Stage 1 is replaced by a
 *                ceiling derived from the LENGTH of the text — generous enough
 *                that no genuine reading reaches it, present only so an engine
 *                that starts and then dies silently cannot hold the surface
 *                open forever. It is re-armed on every chunk that starts, so
 *                the ceiling tracks progress rather than the whole answer.
 *
 * Nothing here decides when speech SHOULD stop. Done, Back, Open Chat and a
 * superseding invocation all call stop(), and that is the policy.
 */
class VestaSpeaker(context: Context) {

    private companion object {
        /** No onStart within this long means the engine never began. */
        const val START_TIMEOUT_MS = 8_000L
        // Once a chunk HAS started: a ceiling proportional to its text. Android
        // TTS runs at roughly 12-18 characters/second at the default rate, so
        // 120 ms per character plus a floor leaves several times the headroom a
        // real utterance needs.
        const val PROGRESS_BASE_MS = 15_000L
        const val PROGRESS_PER_CHAR_MS = 120L
        /** Fallback when the engine doesn't report its own limit. */
        const val FALLBACK_MAX_CHUNK = 3_900
        /** Separates one logical utterance's id from its chunk index. */
        const val CHUNK_SEP = '#'
    }

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

    private val watchdog = Handler(Looper.getMainLooper())
    // Held so it can be cancelled by name — a stale callback for a finished
    // utterance must not fire against a later one. Armed from the engine's
    // callback thread (onStart) as well as the caller's.
    @Volatile
    private var watchdogTask: Runnable? = null

    // The completion callback for the utterance in flight, taken (not copied)
    // by whichever terminal event happens first.
    @Volatile
    private var onDone: ((String) -> Unit)? = null

    /** Base id of the logical utterance in flight. Chunks are "<base>#<n>". */
    @Volatile
    private var currentId: String? = null

    /** The chunk id whose completion means the whole utterance is done. */
    @Volatile
    private var finalChunkId: String? = null

    private fun baseOf(utteranceId: String): String = utteranceId.substringBefore(CHUNK_SEP)

    /** True when this callback belongs to the utterance currently in flight. */
    private fun isCurrent(utteranceId: String): Boolean =
        currentId != null && baseOf(utteranceId) == currentId

    private fun finish(id: String, reason: String) {
        // Only the utterance actually in flight may complete the callback: a
        // late event from a flushed one must not dismiss the new turn's UI.
        if (id.isEmpty() || !isCurrent(id)) return
        cancelWatchdog()
        val callback = onDone
        onDone = null
        currentId = null
        finalChunkId = null
        callback?.invoke(reason)
    }

    private fun cancelWatchdog() {
        watchdogTask?.let { watchdog.removeCallbacks(it) }
        watchdogTask = null
    }

    /** Arms a watchdog that finishes `id` unless a real callback does first. */
    private fun armWatchdog(id: String, afterMs: Long) {
        cancelWatchdog()
        val task = Runnable {
            watchdogTask = null
            Log.w("VestaSpeaker", "TTS watchdog fired for $id after ${afterMs}ms")
            finish(id, "error")
        }
        watchdogTask = task
        watchdog.postDelayed(task, afterMs)
    }

    private fun ensureEngine() {
        if (tts != null || failed) return
        tts = TextToSpeech(appContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ready = true
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        // Real playback began on this chunk. Stage 1 is over:
                        // replace it with a ceiling sized to what is being read,
                        // so a long answer is read to the end.
                        val id = utteranceId ?: return
                        if (!isCurrent(id)) return
                        armWatchdog(id, chunkCeiling(id))
                    }

                    override fun onDone(utteranceId: String?) {
                        val id = utteranceId ?: return
                        // Intermediate chunks are progress, not completion —
                        // reporting "done" on the first one is exactly how a
                        // long answer used to look finished after a sentence.
                        if (id != finalChunkId) return
                        finish(id, "done")
                    }

                    override fun onStop(utteranceId: String?, interrupted: Boolean) {
                        // A flush or stop kills the whole queue, so any chunk
                        // stopping ends the logical utterance.
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

    // Length of the chunk this id names, for the stage-2 ceiling. Written on
    // the caller's thread, read on the engine's callback thread.
    private val chunkLengths = java.util.concurrent.ConcurrentHashMap<String, Int>()

    private fun chunkCeiling(chunkId: String): Long =
        PROGRESS_BASE_MS + (chunkLengths[chunkId] ?: 0) * PROGRESS_PER_CHAR_MS

    private fun maxChunk(): Int {
        val reported = try {
            TextToSpeech.getMaxSpeechInputLength()
        } catch (e: Throwable) {
            0
        }
        // A little headroom under the engine's own limit.
        return if (reported > 64) reported - 64 else FALLBACK_MAX_CHUNK
    }

    /**
     * Splits `text` into pieces the engine will accept, preferring sentence
     * ends, then any whitespace, and only cutting mid-word as a last resort.
     */
    internal fun chunkText(text: String, limit: Int): List<String> {
        if (text.length <= limit) return listOf(text)
        val chunks = ArrayList<String>()
        var rest = text
        while (rest.length > limit) {
            val window = rest.substring(0, limit)
            // A sentence end in the back two thirds of the window, else any
            // space there, else a hard cut — always making progress.
            val sentence = window.lastIndexOfAny(charArrayOf('.', '!', '?', '\n'))
            val space = window.lastIndexOf(' ')
            val cut = when {
                sentence > limit / 3 -> sentence + 1
                space > limit / 3 -> space
                else -> limit
            }
            chunks.add(rest.substring(0, cut).trim())
            rest = rest.substring(cut).trimStart()
        }
        if (rest.isNotEmpty()) chunks.add(rest.trim())
        return chunks.filter { it.isNotEmpty() }
    }

    private fun enqueue(text: String, language: String) {
        val engine = tts ?: return
        applyLanguage(engine, language)
        val base = currentId ?: return

        val chunks = chunkText(text, maxChunk())
        if (chunks.isEmpty()) {
            finish(base, "done")
            return
        }
        chunkLengths.clear()
        finalChunkId = "$base$CHUNK_SEP${chunks.size - 1}"

        chunks.forEachIndexed { index, chunk ->
            val chunkId = "$base$CHUNK_SEP$index"
            chunkLengths[chunkId] = chunk.length
            val params = Bundle()
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, chunkId)
            // The first chunk flushes whatever was playing; the rest queue
            // behind it so the answer is read as one continuous utterance.
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val result = engine.speak(chunk, mode, params, chunkId)
            if (result != TextToSpeech.SUCCESS) {
                finish(chunkId, "error")
                return
            }
        }
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
     * Speaks `text` in full, cutting off anything already playing. `onComplete`
     * is called exactly once with "done", "stopped", "error" or "unavailable".
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
        finalChunkId = null
        onDone = onComplete
        // Stage 1. Covers the engine failing to start at all, and the wait for
        // an engine that is still initialising (the queued path below).
        armWatchdog(id, START_TIMEOUT_MS)

        ensureEngine()
        if (ready) enqueue(text, language) else queued = text to language
    }

    /** Cuts off speech. Safe to call when nothing is playing. */
    fun stop() {
        cancelWatchdog()
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
