import { describe, expect, it } from "vitest";

import {
  createAcpRelayBridgeStdioConfig,
  createAcpRelayBridgeZedConfig,
  parseAcpRelayBridgeConfigArgs,
} from "./bridge-config.js";

describe("ACP relay bridge config", () => {
  it("creates generic stdio client config", () => {
    expect(
      createAcpRelayBridgeStdioConfig({
        args: ["bridge", "run"],
        command: "/usr/local/bin/acp-runtime",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      args: ["bridge", "run"],
      command: "/usr/local/bin/acp-runtime",
      env: {
        ACP_RELAY_URL: "wss://relay.example.com",
      },
    });
  });

  it("defaults generic stdio client config to the hosted relay", () => {
    expect(createAcpRelayBridgeStdioConfig({})).toMatchObject({
      args: ["bridge", "run"],
      env: {
        ACP_RELAY_URL: "wss://relay.saaskit.app",
      },
    });
    expect(parseAcpRelayBridgeConfigArgs([])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      format: "generic",
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
      args: ["bridge", "run"],
      command: "/opt/bin/acp-runtime",
      format: "generic",
      relayUrl: "wss://relay.example.com",
    });
  });

  it("creates Zed custom agent config", () => {
    expect(
      createAcpRelayBridgeZedConfig({
        args: ["bridge", "run"],
        command: "/opt/bin/acp-runtime",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      type: "custom",
      args: ["bridge", "run"],
      command: "/opt/bin/acp-runtime",
      env: {
        ACP_RELAY_URL: "wss://relay.example.com",
      },
    });
  });

  it("supports legacy command-only config", () => {
    expect(
      parseAcpRelayBridgeConfigArgs([
        "--legacy-command",
        "/opt/bin/acp-runtime-bridge",
      ]),
    ).toEqual({
      args: undefined,
      command: "/opt/bin/acp-runtime-bridge",
      format: "generic",
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("parses Zed and all output formats", () => {
    expect(parseAcpRelayBridgeConfigArgs(["--zed"])).toMatchObject({
      format: "zed",
    });
    expect(parseAcpRelayBridgeConfigArgs(["--all"])).toMatchObject({
      format: "all",
    });
    expect(parseAcpRelayBridgeConfigArgs(["--format", "all"])).toMatchObject({
      format: "all",
    });
  });

  it("rejects unknown output formats", () => {
    expect(() => parseAcpRelayBridgeConfigArgs(["--format", "zed-json"])).toThrow(
      "Invalid --format value: zed-json. Expected generic, zed, or all.",
    );
  });

  it("rejects incomplete config command arguments", () => {
    expect(() => parseAcpRelayBridgeConfigArgs(["--relay-url"])).toThrow(
      "Missing value for --relay-url.",
    );
  });
});
