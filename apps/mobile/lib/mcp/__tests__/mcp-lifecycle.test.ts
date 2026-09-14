jest.mock("../../native/mcp-server", () => ({
  startMcpServer: jest.fn(async (port: number, lan = false) => ({
    ip: lan ? "10.0.0.2" : "127.0.0.1",
    port,
    lan,
  })),
  stopMcpServer: jest.fn(async () => {}),
  installMcpRequestListener: jest.fn(() => jest.fn()),
}));
jest.mock("../pairing-store", () => ({ pushActiveTokens: jest.fn(async () => {}) }));
jest.mock("../../storage/database", () => ({
  getConfig: jest.fn(async () => "false"),
  setConfig: jest.fn(async () => {}),
}));
import {
  enableMcpServer,
  disableMcpServer,
  isMcpEnabled,
  isMcpLanBindEnabled,
  setMcpLanBind,
  MCP_PORT,
} from "../mcp-lifecycle";
import { startMcpServer, stopMcpServer, installMcpRequestListener } from "../../native/mcp-server";
import { pushActiveTokens } from "../pairing-store";
import { setConfig, getConfig } from "../../storage/database";

beforeEach(() => jest.clearAllMocks());

it("enable installs the listener, pushes tokens, starts on LOOPBACK, and persists", async () => {
  // getConfig is mocked to "false", i.e. mcp_bind_lan unset/off — the default.
  const res = await enableMcpServer();
  expect(res).toEqual({ ip: "127.0.0.1", port: 8420, lan: false });
  expect(installMcpRequestListener).toHaveBeenCalled();
  expect(pushActiveTokens).toHaveBeenCalled();
  // The security-relevant assertion: never bind the LAN without the opt-in.
  expect(startMcpServer).toHaveBeenCalledWith(MCP_PORT, false);
  expect(setConfig).toHaveBeenCalledWith("mcp_enabled", "true");
});

it("binds the LAN only when mcp_bind_lan is explicitly true", async () => {
  (getConfig as jest.Mock).mockImplementation(async (key: string) =>
    key === "mcp_bind_lan" ? "true" : "false",
  );
  const res = await enableMcpServer();
  expect(startMcpServer).toHaveBeenCalledWith(MCP_PORT, true);
  expect(res).toEqual({ ip: "10.0.0.2", port: 8420, lan: true });
});

it("isMcpLanBindEnabled defaults to false for any non-\"true\" value", async () => {
  (getConfig as jest.Mock).mockResolvedValue(null);
  expect(await isMcpLanBindEnabled()).toBe(false);
  (getConfig as jest.Mock).mockResolvedValue("1");
  expect(await isMcpLanBindEnabled()).toBe(false);
  (getConfig as jest.Mock).mockResolvedValue("true");
  expect(await isMcpLanBindEnabled()).toBe(true);
});

it("setMcpLanBind persists the choice and rebinds a running server", async () => {
  (getConfig as jest.Mock).mockImplementation(async (key: string) =>
    key === "mcp_enabled" ? "true" : "false",
  );
  const res = await setMcpLanBind(true);
  expect(setConfig).toHaveBeenCalledWith("mcp_bind_lan", "true");
  expect(startMcpServer).toHaveBeenCalledWith(MCP_PORT, true);
  expect(res).toMatchObject({ lan: true });
});

it("setMcpLanBind does not start a server that is turned off", async () => {
  (getConfig as jest.Mock).mockResolvedValue("false");
  expect(await setMcpLanBind(true)).toBeNull();
  expect(startMcpServer).not.toHaveBeenCalled();
});

it("disable stops the server, removes the listener, and persists", async () => {
  const unsub = jest.fn();
  (installMcpRequestListener as jest.Mock).mockReturnValue(unsub);
  await enableMcpServer();
  await disableMcpServer();
  expect(stopMcpServer).toHaveBeenCalled();
  expect(unsub).toHaveBeenCalled();
  expect(setConfig).toHaveBeenCalledWith("mcp_enabled", "false");
});

it("isMcpEnabled reads config", async () => {
  (getConfig as jest.Mock).mockResolvedValue("true");
  expect(await isMcpEnabled()).toBe(true);
});
