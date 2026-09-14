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
 * Transparent activity launched from the widget's mic button.
 * Starts Android's speech recognizer, then forwards the transcribed text
 * to MainActivity via a deep link intent (vesta://chat?voice_text=...).
 *
 * Deliberately the SYSTEM recognizer (RecognizerIntent.ACTION_RECOGNIZE_SPEECH),
 * not a bundled engine: whatever the user has set as their recognizer handles
 * the audio, so an offline one such as FUTO Voice Input works unchanged and
 * Vesta never ships its own STT. Do not replace this with Whisper or route it
 * through a service — offline-first is the point, and the system recognizer is
 * already warm when the user taps.
 */
class VestaVoiceActivity : Activity() {

    companion object {
        private const val REQUEST_SPEECH = 1001
        private const val REQUEST_MIC_PERMISSION = 1002
    }

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
                    // Launch MainActivity with the transcribed text
                    val launchIntent = Intent(this, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        this.data = Uri.parse("vesta://chat?voice_text=${Uri.encode(spokenText)}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    }
                    startActivity(launchIntent)
                }
            }
            finish()
        }
    }
}
