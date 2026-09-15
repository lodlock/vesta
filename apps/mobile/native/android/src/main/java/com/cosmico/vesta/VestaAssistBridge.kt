package com.cosmico.vesta

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicLong

/**
 * One-shot, in-process handoff of an assistant INVOCATION from
 * VestaVoiceActivity to the JS layer.
 *
 * Why not an Intent extra: MainActivity is exported (it is the launcher), and
 * the `vesta://` deep link is BROWSABLE, so anything on the device — or a web
 * page — can hand the app a string. The existing deep-link path deliberately
 * only PRE-FILLS the chat input for that reason. An assistant invocation
 * executes the parsed action instead, so its payload must come from a channel
 * nothing outside this process can write to: a static set by our own activity
 * after the system recognizer returned.
 *
 * Every offer carries a monotonic id. That id is the assistant SESSION
 * identity all the way up into JS: the surface, the persistence record and the
 * TTS utterance all belong to one invocation, and anything still in flight
 * from an earlier one is recognisably stale rather than merely "previous".
 *
 * `consume()` clears as it reads, so a transcript is acted on exactly once even
 * if the app is relaunched or the event and the cold-start read race. It also
 * EXPIRES: this object lives in the same process as the launcher activity, so
 * an offer whose MainActivity never arrived (the start was refused, the user
 * backed straight out) would otherwise sit here indefinitely and be picked up
 * by an unrelated launch from the app icon minutes later.
 */
object VestaAssistBridge {

    /** How long an offered transcript stays actionable. */
    private const val MAX_AGE_MS = 60_000L

    private val invocations = AtomicLong(0)

    @Volatile
    private var pending: Invocation? = null

    @Volatile
    private var offeredAt: Long = 0

    /** Set by SystemActionsModule while a React context is alive. */
    @Volatile
    var onOffer: (() -> Unit)? = null

    /** One assistant invocation: what was said, and which invocation it is. */
    data class Invocation(val text: String, val id: Long)

    fun offer(text: String) {
        pending = Invocation(text, invocations.incrementAndGet())
        offeredAt = SystemClock.elapsedRealtime()
        // Only a signal — the payload is read back through consume(), so a warm
        // app and a cold start take exactly the same path.
        onOffer?.invoke()
    }

    fun consume(): Invocation? {
        val invocation = pending ?: return null
        val age = SystemClock.elapsedRealtime() - offeredAt
        clear()
        return if (age > MAX_AGE_MS) null else invocation
    }

    fun clear() {
        pending = null
        offeredAt = 0
    }
}
