package com.cosmico.vesta

import android.app.ActivityManager
import android.app.role.RoleManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.provider.AlarmClock
import android.provider.Settings
import android.provider.CalendarContract
import com.facebook.react.bridge.*
import java.io.File
import java.net.URLDecoder
import java.security.MessageDigest
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeParseException

class SystemActionsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ComponentCallbacks2 {

    override fun getName(): String = "SystemActionsModule"

    // ── Memory-pressure bridge ───────────────────────────────────────────
    // Android signals low memory through ComponentCallbacks2.onTrimMemory, NOT
    // through React Native's AppState: its `memoryWarning` event is emitted only
    // on iOS (AppStateModule never fires it on Android). We register on the
    // application context and forward a device event to JS, which drops the
    // cheap-to-rebuild embedding context. The chat model stays resident by
    // design — if the OS still kills us, the foreground service is START_STICKY
    // and the prefix session cache makes the restart cheap (~3s). See ADR-016.

    override fun initialize() {
        super.initialize()
        reactApplicationContext.applicationContext.registerComponentCallbacks(this)
        // Wake JS when the assistant hands over a transcript while the app is
        // already running. The event carries no payload: JS reads it back with
        // consumeAssistRequest() either way, so warm and cold starts share one
        // path and the transcript can only be consumed once.
        VestaAssistBridge.onOffer = {
            if (reactApplicationContext.hasActiveReactInstance()) {
                reactApplicationContext.emitDeviceEvent("vestaAssist", null)
            }
        }
    }

    override fun invalidate() {
        VestaAssistBridge.onOffer = null
        reactApplicationContext.applicationContext.unregisterComponentCallbacks(this)
        super.invalidate()
    }

    override fun onTrimMemory(level: Int) {
        // Forward only real pressure. RUNNING_LOW/CRITICAL mean "free non-critical
        // memory now" while foregrounded; UI_HIDDEN and the background levels are
        // all >= this and also worth reclaiming the embed context for. Below
        // RUNNING_LOW (RUNNING_MODERATE) Android is merely informational.
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            emitMemoryWarning(level)
        }
    }

    // Legacy pre-API-34 path; some devices still call this on severe pressure.
    override fun onLowMemory() {
        emitMemoryWarning(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        // No config-driven behavior here; required by ComponentCallbacks.
    }

    private fun emitMemoryWarning(level: Int) {
        // A trim can arrive while the app is backgrounded and the instance is
        // being torn down — guard exactly as RN's own AppStateModule does.
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext.emitDeviceEvent("memoryWarning", level)
    }

    // Required so the JS-side NativeEventEmitter(SystemActionsModule) doesn't
    // warn about a missing listener interface. No bookkeeping needed — the
    // native trim callback fires regardless of JS subscriber count.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    // Device capabilities — used by the model manager to recommend models that
    // actually fit this phone's RAM (e.g. a 16 GB Pixel runs every catalog model;
    // a 4 GB device should be steered away from 8B).
    @ReactMethod
    fun getDeviceInfo(promise: Promise) {
        try {
            val am = reactApplicationContext
                .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mem = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mem)
            val map = Arguments.createMap()
            map.putDouble("totalMemMb", mem.totalMem / (1024.0 * 1024.0))
            map.putDouble("availMemMb", mem.availMem / (1024.0 * 1024.0))
            map.putBoolean("lowRam", am.isLowRamDevice)
            map.putString("model", Build.MODEL)
            map.putString("manufacturer", Build.MANUFACTURER)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("DEVICE_INFO_ERROR", e.message, e)
        }
    }

    // ── Assistant role ───────────────────────────────────────────────────
    // Vesta qualifies for ROLE_ASSISTANT by handling ACTION_ASSIST (see
    // VestaVoiceActivity and the manifest). These methods only report and
    // REQUEST — the default assistant is the user's choice to make, and
    // nothing here changes it silently.

    /** The pending assistant transcript, consumed. Null when there isn't one. */
    @ReactMethod
    fun consumeAssistRequest(promise: Promise) {
        promise.resolve(VestaAssistBridge.consume())
    }

    /**
     * Re-opens the system recognizer for a follow-up turn (answering a
     * clarification). ACTION_ASSIST so the transcript comes back through the
     * assistant bridge and is handled exactly like the first turn.
     */
    @ReactMethod
    fun startAssistCapture(promise: Promise) {
        val intent = Intent(reactApplicationContext, VestaVoiceActivity::class.java)
            .setAction(Intent.ACTION_ASSIST)
        if (launch(intent)) promise.resolve(null)
        else promise.reject("ASSIST_CAPTURE_ERROR", "Could not start voice capture")
    }

    /** Whether Vesta currently holds the assistant role. */
    @ReactMethod
    fun isDefaultAssistant(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                promise.resolve(false)
                return
            }
            val roles = reactApplicationContext.getSystemService(RoleManager::class.java)
            promise.resolve(roles?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * Opens the system UI for choosing the digital assistant.
     *
     * ROLE_ASSISTANT is not a role an app can pop a "grant?" dialog for on
     * every Android build — it is exclusive and some versions mark it
     * non-requestable — so this tries the role request first and falls back to
     * the voice-input settings screen. Either way the user makes the choice in
     * a system screen; there is no path here that sets the default itself.
     *
     * Resolves "held", "requested", "settings" or "unavailable" so the UI can
     * say something accurate.
     */
    @ReactMethod
    fun requestAssistantRole(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val roles = reactApplicationContext.getSystemService(RoleManager::class.java)
                if (roles != null && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
                    promise.resolve("held")
                    return
                }
                if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
                    try {
                        val intent = roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)
                        if (launch(intent)) {
                            promise.resolve("requested")
                            return
                        }
                    } catch (e: Exception) {
                        // Non-requestable on this build — fall through.
                    }
                }
            }
            val settings = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
            if (launch(settings)) {
                promise.resolve("settings")
                return
            }
            promise.resolve("unavailable")
        } catch (e: Exception) {
            promise.reject("ASSISTANT_ROLE_ERROR", e.message, e)
        }
    }

    // Prefers the current activity so the chooser lands on top of Vesta; falls
    // back to a new task when the app has no foreground activity.
    private fun launch(intent: Intent): Boolean {
        return try {
            val activity = currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    // ── File integrity ───────────────────────────────────────────────────
    // Streaming SHA-256 of a local file. Used by the model downloader to verify
    // a finished .gguf against HuggingFace's LFS oid BEFORE it is promoted to
    // the usable model path. A model file is multi-GB, so this must never
    // materialize the bytes in JS: we digest in 1 MB chunks on a worker thread
    // (the native-modules thread must stay free — a 4 GB file takes seconds).
    @ReactMethod
    fun sha256File(path: String, promise: Promise) {
        Thread {
            try {
                val file = File(toFilePath(path))
                if (!file.isFile) {
                    promise.reject("SHA256_ERROR", "No such file: $path")
                    return@Thread
                }
                val digest = MessageDigest.getInstance("SHA-256")
                file.inputStream().use { input ->
                    val buffer = ByteArray(1 shl 20)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        digest.update(buffer, 0, read)
                    }
                }
                promise.resolve(digest.digest().joinToString("") { "%02x".format(it) })
            } catch (e: Exception) {
                promise.reject("SHA256_ERROR", e.message, e)
            }
        }.start()
    }

    // expo-file-system hands JS `file:///...` URIs with percent-encoded
    // segments; java.io.File wants a decoded filesystem path.
    private fun toFilePath(path: String): String {
        val raw = if (path.startsWith("file://")) path.removePrefix("file://") else path
        return URLDecoder.decode(raw, "UTF-8")
    }

    private fun parseToMillis(dateStr: String): Long {
        return try {
            // Try timezone-aware format first (e.g., 2026-03-10T15:00:00+01:00)
            ZonedDateTime.parse(dateStr).toInstant().toEpochMilli()
        } catch (e: DateTimeParseException) {
            // Fall back to local datetime (e.g., 2026-03-10T15:00:00)
            LocalDateTime.parse(dateStr)
                .atZone(ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli()
        }
    }

    @ReactMethod
    fun setAlarm(hours: Int, minutes: Int, label: String, date: String, promise: Promise) {
        try {
            // NOTE: Android's AlarmClock.ACTION_SET_ALARM does NOT support scheduling on
            // specific future dates. The `date` parameter is accepted but ignored in MVP.
            // Alarms are always set for the next occurrence of the given time.
            // For future-dated alarms, AlarmManager would be needed (Fase 2 scope).
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hours)
                putExtra(AlarmClock.EXTRA_MINUTES, minutes)
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (label.isNotEmpty()) {
                    putExtra(AlarmClock.EXTRA_MESSAGE, label)
                }
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SET_ALARM_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setTimer(seconds: Int, label: String, promise: Promise) {
        try {
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (label.isNotEmpty()) {
                    putExtra(AlarmClock.EXTRA_MESSAGE, label)
                }
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SET_TIMER_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun createCalendarEvent(title: String, start: String, end: String, location: String, promise: Promise) {
        try {
            val startMillis = parseToMillis(start)
            val endMillis = if (end.isNotEmpty()) {
                parseToMillis(end)
            } else {
                startMillis + 3600000 // default 1 hour duration
            }

            val intent = Intent(Intent.ACTION_INSERT).apply {
                data = CalendarContract.Events.CONTENT_URI
                putExtra(CalendarContract.Events.TITLE, title)
                putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
                putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMillis)
                if (location.isNotEmpty()) {
                    putExtra(CalendarContract.Events.EVENT_LOCATION, location)
                }
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: DateTimeParseException) {
            promise.reject("CREATE_EVENT_ERROR", "Invalid date format: ${e.message}", e)
        } catch (e: Exception) {
            promise.reject("CREATE_EVENT_ERROR", e.message, e)
        }
    }
}
