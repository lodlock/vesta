package com.cosmico.vesta

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * Transparent activity that runs one round of speech input. It is the entry
 * point for BOTH ways Vesta is spoken to:
 *
 *  - the widget's mic button (no action set), which pre-fills the chat input
 *    over a `vesta://chat?voice_text=...` deep link, and
 *  - the system assistant button/gesture (ACTION_ASSIST / ACTION_VOICE_COMMAND),
 *    which hands the transcript to the scheduling fast path to be ACTED ON.
 *
 * The two differ only in what happens to the transcript, and they must: the
 * deep link is a BROWSABLE URI that any app or web page can fire, so it only
 * ever pre-fills. The assistant path executes, so its transcript travels
 * through VestaAssistBridge — an in-process static nothing outside this app can
 * write — rather than through an Intent extra.
 *
 * Deliberately the SYSTEM recognizer (RecognizerIntent.ACTION_RECOGNIZE_SPEECH),
 * not a bundled engine: whatever the user has set as their recognizer handles
 * the audio, so an offline one such as FUTO Voice Input works unchanged and
 * Vesta never ships its own STT. Do not replace this with Whisper or route it
 * through a service — offline-first is the point, and the system recognizer is
 * already warm when the user taps. There is no hotword and no background
 * capture anywhere in this path: the microphone opens only inside the
 * recognizer the user explicitly invoked.
 */
class VestaVoiceActivity : Activity() {

    companion object {
        private const val REQUEST_SPEECH = 1001
        private const val REQUEST_MIC_PERMISSION = 1002
    }

    // True when the system assistant invoked us, rather than the widget.
    private val fromAssistant: Boolean
        get() = intent?.action == Intent.ACTION_ASSIST ||
            intent?.action == "android.intent.action.VOICE_COMMAND"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Check mic permission
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_MIC_PERMISSION
            )
        } else {
            startSpeechRecognition()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_MIC_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startSpeechRecognition()
            } else {
                Toast.makeText(this, "Microphone permission required for voice input", Toast.LENGTH_SHORT).show()
                finish()
            }
        }
    }

    private fun startSpeechRecognition() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            // EXTRA_LANGUAGE is read with getStringExtra: it must be an IETF
            // language tag ("en-US"), not a Locale. Passing the Locale object
            // stored a Serializable that every recognizer read back as null and
            // silently fell back to its own default language.
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Talk to Vesta...")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Scheduling commands are short: stop listening promptly after the
            // user stops talking instead of waiting out the recognizer's
            // default silence window. Both are hints — a recognizer that
            // ignores them (FUTO does) behaves exactly as before.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1000L)
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                1000L,
            )
        }

        try {
            startActivityForResult(intent, REQUEST_SPEECH)
        } catch (e: Exception) {
            Toast.makeText(this, "Speech recognition not available", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    @Deprecated("Using deprecated API for broad compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == REQUEST_SPEECH) {
            if (resultCode == RESULT_OK && data != null) {
                val results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                val spokenText = results?.firstOrNull()

                if (!spokenText.isNullOrBlank()) {
                    if (fromAssistant) {
                        // Assistant invocation: hand the transcript over
                        // in-process and just bring the app up. JS reads it back
                        // through SystemActionsModule.consumeAssistRequest() —
                        // the same call for a cold start and for a warm one, so
                        // there is one code path and the text is consumed once.
                        VestaAssistBridge.offer(spokenText)
                        startActivity(
                            Intent(this, MainActivity::class.java).addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                            )
                        )
                    } else {
                        // Widget: pre-fill the chat input, never auto-send.
                        val launchIntent = Intent(this, MainActivity::class.java).apply {
                            action = Intent.ACTION_VIEW
                            this.data = Uri.parse("vesta://chat?voice_text=${Uri.encode(spokenText)}")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        }
                        startActivity(launchIntent)
                    }
                }
            }
            finish()
        }
    }
}
