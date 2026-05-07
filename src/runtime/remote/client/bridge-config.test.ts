import { describe, expect, it } from "vitest";

import {
  createAcpRelayBridgeStdioConfig,
  parseAcpRelayBridgeConfigArgs,
} from "./bridge-config.js";

describe("ACP relay bridge config", () => {
  it("creates generic stdio client config", () => {
    expect(
      createAcpRelayBridgeStdioConfig({
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      args: ["bridge", "run"],
      command: "acp-runtime",
      env: {
        ACP_RELAY_URL: "wss://relay.example.com",
      },
    });
  });

  it("defaults generic stdio client config to the hosted relay", () => {
    expect(createAcpRelayBridgeStdioConfig({})).toEqual({
      args: ["bridge", "run"],
      command: "acp-runtime",
      env: {
        ACP_RELAY_URL: "wss://relay.saaskit.app",
      },
    });
    expect(parseAcpRelayBridgeConfigArgs([])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("parses config command arguments", () => {
    expect(
      parseAcpRelayBridgeConfigArgs([
        "--relay-url",
        "wss://relay.example.com",
        "--command",
        "/opt/bin/acp-runtime",
      ]),
    ).toEqual({
      args: undefined,
      command: "/opt/bin/acp-runtime",
      relayUrl: "wss://relay.example.com",
    });
  });

  it("rejects incomplete config command arguments", () => {
    expect(() => parseAcpRelayBridgeConfigArgs(["--relay-url"])).toThrow(
      "Missing value for --relay-url.",
    );
  });
});
