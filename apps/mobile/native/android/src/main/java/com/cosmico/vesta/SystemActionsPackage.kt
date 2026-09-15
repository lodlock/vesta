package com.cosmico.vesta

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

class SystemActionsPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        val modules = mutableListOf(
            SystemActionsModule(reactContext),
            VestaServiceModule(reactContext),
            McpServerModule(reactContext),
        )
        npuModule(reactContext)?.let { modules.add(it) }
        return modules
    }

    /**
     * The Qualcomm NPU module, when this build has one.
     *
     * Looked up by name rather than referenced directly: the class is only
     * copied in by the config plugin for a VESTA_ENABLE_NPU build, and a direct
     * reference would stop a normal build from compiling. Absent means absent —
     * JS sees no module and the NPU backend reports unavailable.
     */
    private fun npuModule(reactContext: ReactApplicationContext): NativeModule? {
        return try {
            Class.forName("com.cosmico.vesta.VestaNpuModule")
                .getConstructor(ReactApplicationContext::class.java)
                .newInstance(reactContext) as NativeModule
        } catch (e: Throwable) {
            null
        }
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<View, ReactShadowNode<*>>> {
        return emptyList()
    }
}
