package com.cosmico.vesta

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

class SystemActionsPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        // Typed as NativeModule, which is what ReactPackage actually returns.
        // Left to inference this became a List<ReactContextBaseJavaModule> —
        // the nearest common supertype of the three literals — and the optional
        // NPU module, which is only known to be a NativeModule, no longer fit.
        // The element type is the fix; casting the module down to the list's
        // accidental type would be inventing a guarantee we do not have.
        val modules = mutableListOf<NativeModule>(
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
                .newInstance(reactContext) as? NativeModule
        } catch (e: ClassNotFoundException) {
            // The ordinary case: a build made without VESTA_ENABLE_NPU has no
            // such class. Not worth a line in logcat on every launch.
            null
        } catch (e: Throwable) {
            // This one IS worth shouting about: the class was built in and
            // still could not be constructed — a missing .so, a failed static
            // initializer. JS will correctly report the NPU as unavailable, so
            // nothing lies to the user, but the reason must not vanish.
            android.util.Log.e("VestaNpu", "NPU module present but not constructible", e)
            null
        }
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<View, ReactShadowNode<*>>> {
        return emptyList()
    }
}
