import { describe, expect, it } from "vitest";

import { parseAcpRuntimeAuthCommand } from "./auth-bin.js";

describe("remote auth CLI", () => {
  it("parses login with defaults", () => {
    expect(parseAcpRuntimeAuthCommand(["login"])).toEqual({
      ensureDaemon: true,
      force: false,
      name: "login",
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("parses login relay URL and force refresh", () => {
    expect(
      parseAcpRuntimeAuthCommand([
        "login",
        "--relay-url",
        "ws://127.0.0.1:8787",
        "--force",
      ]),
    ).toEqual({
      ensureDaemon: true,
      force: true,
      name: "login",
      relayUrl: "ws://127.0.0.1:8787",
    });
  });

  it("parses login without daemon install", () => {
    expect(parseAcpRuntimeAuthCommand(["login", "--no-daemon"])).toEqual({
      ensureDaemon: false,
      force: false,
      name: "login",
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("parses status and logout", () => {
    expect(parseAcpRuntimeAuthCommand(["status"])).toEqual({ name: "status" });
    expect(parseAcpRuntimeAuthCommand(["logout"])).toEqual({ name: "logout" });
  });

  it("rejects unknown auth commands", () => {
    expect(() => parseAcpRuntimeAuthCommand(["whoami"])).toThrow(
      "Unknown acp-runtime auth command: whoami",
    );
  });
});
