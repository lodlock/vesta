package com.cosmico.vesta

/**
 * One-shot, in-process handoff of an assistant transcript from
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
 * `consume()` clears as it reads, so a transcript is acted on exactly once even
 * if the app is relaunched or the event and the cold-start read race.
 */
object VestaAssistBridge {

    @Volatile
    private var pending: String? = null

    /** Set by SystemActionsModule while a React context is alive. */
    @Volatile
    var onOffer: (() -> Unit)? = null

    fun offer(text: String) {
        pending = text
        // Only a signal — the payload is read back through consume(), so a warm
        // app and a cold start take exactly the same path.
        onOffer?.invoke()
    }

    fun consume(): String? {
        val text = pending
        pending = null
        return text
    }
}
