// apps/mobile/lib/native/mcp-server.ts
// TS wrapper over the native McpServerModule + the request event bridge. The
// native HTTP thread blocks on a CompletableFuture keyed by `id`; we run the
// JSON-RPC engine and call respondMcp(id, ...) to release it. Mirrors the
// memoryWarning bridge (NativeEventEmitter over emitDeviceEvent). The native
// module is read lazily per call — it registers before JS on device, and lazy
// access keeps this module unit-testable (the module ref is never captured at
// import time).

import { NativeModules, NativeEventEmitter } from "react-native";
import { handleJsonRpc } from "../mcp/mcp-server";

interface McpNativeModule {
  startServer(port: number, bindLan: boolean): Promise<string>;
  stopServer(): Promise<void>;
  setActiveTokens(tokens: string[]): void;
  respondMcp(id: string, status: number, body: string): void;
}

function getMod(): McpNativeModule {
  return NativeModules.McpServerModule as McpNativeModule;
}

// `bindLan` defaults to false: the native server binds 127.0.0.1 so the
// plaintext bearer token never crosses the network. Callers pass true only
// when the user has explicitly opted into LAN exposure (see mcp-lifecycle).
export async function startMcpServer(
  port: number,
  bindLan = false,
): Promise<{ ip: string; port: number; lan: boolean }> {
  const ip = await getMod().startServer(port, bindLan);
  return { ip, port, lan: bindLan };
}

export function stopMcpServer(): Promise<void> {
  return getMod().stopServer();
}

export function setActiveTokens(tokens: string[]): void {
  getMod().setActiveTokens(tokens);
}

export function installMcpRequestListener(): () => void {
  const emitter = new NativeEventEmitter(NativeModules.McpServerModule);
  const sub = emitter.addListener(
    "mcpRequest",
    (e: { id: string; token: string; body: string }) => {
      handleJsonRpc(e.body, e.token)
        .then((body) => getMod().respondMcp(e.id, 200, body))
        .catch(() => getMod().respondMcp(e.id, 500, ""));
    },
  );
  return () => sub.remove();
}
