import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState, useEffect } from "react";
import {
  View,
  ActivityIndicator,
  AppState,
  NativeEventEmitter,
  NativeModules,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useChatStore } from "../lib/store/chat-store";
import { useAssistStore } from "../lib/store/assist-store";
import { AssistOverlay } from "../components/AssistOverlay";
import {
  consumeAssistRequest,
  onAssistRequest,
  getProcessStartMillis,
} from "../lib/native/assist";
import { finishTrace, recordNativeToJs } from "../lib/dev/startup-trace";
import { unloadEmbeddingModel, isEmbeddingLoaded } from "../lib/llm/embed-engine";
import { colors } from "../lib/theme";

export default function RootLayout() {
  const init = useChatStore((s) => s.init);
  const [ready, setReady] = useState(false);
  const assistActive = useAssistStore((s) => s.active);
  const assistLeaving = useAssistStore((s) => s.leaving);

  useEffect(() => {
    (async () => {
      // Assistant invocation? The transcript is waiting in the native bridge.
      // Reading it BEFORE init decides whether this launch loads the model at
      // all: a spoken timer is handled by the parser, so an assistant boot
      // skips the GGUF (and the keep-alive service) entirely.
      const startedAt = Date.now();
      // The part of the wait that happened before any JS ran. Recorded, not
      // guessed: it is the half Vesta cannot shorten.
      getProcessStartMillis().then(recordNativeToJs).catch(() => {});

      const assist = await consumeAssistRequest();
      // The launch origin is what decides whether the assistant surface is
      // allowed on screen at all. The store is module state and the React root
      // is rebuilt per Activity, so without this an abandoned turn — Android
      // does not reliably kill the process on a swipe from Recents — would put
      // its overlay back up on an ordinary launch from the app icon. No
      // pending invocation means this launch is not an assistant invocation,
      // and anything left over from an earlier one ends here. It is transient
      // state only: a model answer already written to the database is
      // untouched, and still in the chat list.
      if (!assist) useAssistStore.getState().endSession();
      try {
        await init({ loadModel: assist === null });
      } catch (err) {
        console.error("Init failed:", err);
      }
      finishTrace(Date.now() - startedAt);
      setReady(true);
      if (assist) useAssistStore.getState().handle(assist.text, assist.invocationId);
    })();
  }, []);

  useEffect(() => {
    // A later invocation while the app is already running. The event is only a
    // signal; the transcript is read back the same way as on a cold start, so
    // it is acted on exactly once.
    return onAssistRequest(() => {
      consumeAssistRequest().then((assist) => {
        if (assist) useAssistStore.getState().handle(assist.text, assist.invocationId);
      });
    });
  }, []);

  useEffect(() => {
    // Reclaim the embedding model's RAM when the app is backgrounded; it
    // lazy-reloads on the next document import/query.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        unloadEmbeddingModel().catch(() => {});
      }
      // A settled assistant turn does not survive the app leaving the
      // foreground, and does not come back with it. Checked on the way out AND
      // on the way in because the Activity is not always destroyed in between:
      // a resume without a remount skips the launch-origin gate above.
      // Turns that are legitimately waiting on something off-screen (the
      // system recognizer is its own Activity) are left alone.
      if (state === "background" || state === "active") {
        useAssistStore.getState().endIfSettled();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // Android low-memory pressure. RN's AppState `memoryWarning` never fires on
    // Android, so SystemActionsModule hooks native onTrimMemory and forwards it
    // here (already filtered to real pressure). We drop only the cheap-to-rebuild
    // embedding context (~1s to reload); the chat model stays resident by design
    // (ADR-016) — if the OS still kills us, the foreground service restarts and
    // the prefix session cache makes the cold start cheap.
    const mod = NativeModules.SystemActionsModule;
    if (!mod) return;
    const emitter = new NativeEventEmitter(mod);
    const sub = emitter.addListener("memoryWarning", (level: number) => {
      if (isEmbeddingLoaded()) {
        console.log(`[MemoryPressure] releasing embed context (trim level ${level})`);
      }
      unloadEmbeddingModel().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Back or Done, with the Activity on its way out. Rendering the navigator
  // here would mount the whole chat screen — and start loading the model —
  // for the moments before the Activity actually goes, which is exactly the
  // stutter that made Back feel unresponsive. A bare background instead, so
  // the surface disappears on the very next frame. The store arms a fallback
  // that clears this if the finish never lands.
  if (assistLeaving) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  // The assistant surface replaces the navigator rather than sitting on top of
  // it: the chat screen never mounts, so nothing in it can pull the model in.
  // Leaving it (Open chat) loads the model in the background, since the chat is
  // useless without one.
  if (assistActive) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AssistOverlay
          onOpenChat={(chatId) => {
            const chat = useChatStore.getState();
            // Open the conversation this assistant turn produced. Without this
            // the chat screen would show whatever was open before the
            // assistant was invoked, which has nothing to do with what the
            // user just asked.
            if (chatId) {
              chat.loadConversation(chatId, null).catch(() => {});
            }
            chat.ensureModelLoaded().catch(() => {});
          }}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { fontWeight: "600", fontSize: 17 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen
          name="index"
          options={{ title: "Vesta" }}
        />
        <Stack.Screen
          name="history"
          options={{ title: "Conversations" }}
        />
        <Stack.Screen
          name="settings"
          options={{ title: "Settings" }}
        />
        <Stack.Screen
          name="models"
          options={{ title: "Models" }}
        />
        <Stack.Screen
          name="documents"
          options={{ title: "Documents" }}
        />
        <Stack.Screen
          name="diagnostics"
          options={{ title: "Diagnostics" }}
        />
        <Stack.Screen name="mcp" options={{ title: "MCP Server" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
