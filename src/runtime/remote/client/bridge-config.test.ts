import { describe, expect, it } from "vitest";

import {
  createAcpRelayBridgeStdioConfig,
  createAcpRelayBridgeZedConfig,
  parseAcpRelayBridgeConfigArgs,
  parseAcpRelayBridgeRunArgs,
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
      args: ["bridge", "run", "--relay-url", "wss://relay.example.com"],
      command: "/usr/local/bin/acp-runtime",
    });
  });

  it("omits relay configuration when using the built-in hosted relay default", () => {
    expect(createAcpRelayBridgeStdioConfig({})).toEqual({
      args: ["bridge", "run"],
      command: expect.any(String),
    });
    expect(parseAcpRelayBridgeConfigArgs([])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      format: "generic",
      relayUrl: undefined,
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
      args: ["bridge", "run", "--relay-url", "wss://relay.example.com"],
      command: "/opt/bin/acp-runtime",
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
      relayUrl: undefined,
    });
  });

  it("keeps relay url in env when legacy command configs cannot pass args", () => {
    expect(
      createAcpRelayBridgeStdioConfig({
        command: "/opt/bin/acp-runtime-bridge",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      command: "/opt/bin/acp-runtime-bridge",
      env: {
        ACP_RELAY_URL: "wss://relay.example.com",
      },
    });
  });

  it("parses bridge run relay url from args, env, or the built-in default", () => {
    expect(
      parseAcpRelayBridgeRunArgs({
        argv: ["--relay-url", "wss://relay.arg.example.com"],
        env: { ACP_RELAY_URL: "wss://relay.env.example.com" },
      }),
    ).toEqual({ relayUrl: "wss://relay.arg.example.com" });
    expect(
      parseAcpRelayBridgeRunArgs({
        argv: [],
        env: { ACP_RELAY_URL: "wss://relay.env.example.com" },
      }),
    ).toEqual({ relayUrl: "wss://relay.env.example.com" });
    expect(parseAcpRelayBridgeRunArgs({ argv: [], env: {} })).toEqual({
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
    expect(() => parseAcpRelayBridgeRunArgs({ argv: ["--relay-url"] })).toThrow(
      "Missing value for --relay-url.",
    );
  });
});
