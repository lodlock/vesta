// Enable/disable the MCP server: token push → listener → native start. The
// on/off flag is persisted; the running server is restored when the MCP settings
// screen is opened (app/mcp.tsx re-enables it if the flag is set), not at app
// launch. Server is OFF by default. Boot-time auto-restore is a documented
// follow-up (slice 1 assumes Vesta is foregrounded during MCP use).
//
// BINDING: loopback (127.0.0.1) by default. The transport is plaintext HTTP and
// the exposed read tools return calendar, contacts and document content, so
// binding every interface would put a cleartext bearer token and private data on
// the Wi-Fi. A desktop client reaches the loopback server over
// `adb reverse tcp:8420 tcp:8420`. LAN binding stays available as a second,
// explicit opt-in (`mcp_bind_lan`), independent of the on/off flag.

import {
  startMcpServer,
  stopMcpServer,
  installMcpRequestListener,
} from "../native/mcp-server";
import { pushActiveTokens } from "./pairing-store";
import { getConfig, setConfig } from "../storage/database";

export const MCP_PORT = 8420;
export const MCP_LOOPBACK = "127.0.0.1";

let removeListener: (() => void) | null = null;

export async function enableMcpServer(): Promise<{
  ip: string;
  port: number;
  lan: boolean;
}> {
  removeListener?.();
  removeListener = installMcpRequestListener();
  await pushActiveTokens();
  const res = await startMcpServer(MCP_PORT, await isMcpLanBindEnabled());
  await setConfig("mcp_enabled", "true");
  return res;
}

export async function disableMcpServer(): Promise<void> {
  await stopMcpServer();
  removeListener?.();
  removeListener = null;
  await setConfig("mcp_enabled", "false");
}

export async function isMcpEnabled(): Promise<boolean> {
  return (await getConfig("mcp_enabled")) === "true";
}

// LAN exposure is opt-in and defaults to OFF: an unset (or any non-"true")
// config value means loopback.
export async function isMcpLanBindEnabled(): Promise<boolean> {
  return (await getConfig("mcp_bind_lan")) === "true";
}

// Persist the binding choice. If the server is currently running, rebind it now
// so the change takes effect immediately instead of at the next enable — the
// native side tears the old socket down when the binding differs.
export async function setMcpLanBind(on: boolean): Promise<{
  ip: string;
  port: number;
  lan: boolean;
} | null> {
  await setConfig("mcp_bind_lan", on ? "true" : "false");
  if (!(await isMcpEnabled())) return null;
  return startMcpServer(MCP_PORT, on);
}
