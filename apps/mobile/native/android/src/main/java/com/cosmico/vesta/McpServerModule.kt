package com.cosmico.vesta

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import fi.iki.elonen.NanoHTTPD
import java.net.Inet4Address
import java.net.NetworkInterface

class McpServerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "McpServerModule"

    companion object {
        const val LOOPBACK = "127.0.0.1"
        const val ANY = "0.0.0.0"
    }

    @Volatile private var activeTokens: Set<String> = emptySet()
    private var server: McpHttpServer? = null
    // Which interface the running server is bound to, so a binding change
    // actually rebinds instead of silently reusing the old socket.
    private var boundLan: Boolean = false

    @ReactMethod
    fun setActiveTokens(tokens: ReadableArray) {
        val set = HashSet<String>()
        for (i in 0 until tokens.size()) tokens.getString(i)?.let { set.add(it) }
        activeTokens = set
    }

    /**
     * Starts the MCP transport. `bindLan` false (the default everywhere in TS)
     * binds 127.0.0.1: reachable only from this device, so the plaintext bearer
     * token never crosses the network. A desktop client reaches a loopback
     * server over `adb reverse tcp:8420 tcp:8420`. `bindLan` true is the user's
     * explicit opt-in and binds every interface.
     */
    @ReactMethod
    fun startServer(port: Int, bindLan: Boolean, promise: Promise) {
        try {
            if (server != null) {
                if (boundLan == bindLan) { promise.resolve(address(bindLan)); return }
                // Binding changed — tear the old socket down before rebinding.
                server?.stop()
                server = null
            }
            val s = McpHttpServer(if (bindLan) ANY else LOOPBACK, port, { activeTokens }, ::emitRequest)
            s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            server = s
            boundLan = bindLan
            promise.resolve(address(bindLan))
        } catch (e: Exception) {
            promise.reject("MCP_START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        server?.stop()
        server = null
        promise.resolve(null)
    }

    @ReactMethod
    fun respondMcp(id: String, status: Int, body: String) {
        server?.complete(id, status, body)
    }

    // NativeEventEmitter contract.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    private fun emitRequest(id: String, token: String, body: String) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        val map = com.facebook.react.bridge.Arguments.createMap()
        map.putString("id", id)
        map.putString("token", token)
        map.putString("body", body)
        reactApplicationContext.emitDeviceEvent("mcpRequest", map)
    }

    // The address the UI should show for the running server: the LAN IP only
    // when we actually bound the LAN, otherwise loopback.
    private fun address(bindLan: Boolean): String = if (bindLan) lanIp() else LOOPBACK

    private fun lanIp(): String {
        for (nif in NetworkInterface.getNetworkInterfaces()) {
            if (!nif.isUp || nif.isLoopback) continue
            for (addr in nif.inetAddresses) {
                if (addr is Inet4Address && !addr.isLoopbackAddress) return addr.hostAddress ?: ""
            }
        }
        return ""
    }
}
