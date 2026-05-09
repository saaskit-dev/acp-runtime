import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";

export type AcpRelayBridgeConfigOptions = {
  args?: readonly string[];
  command?: string;
  format?: AcpRelayBridgeConfigFormat;
  relayUrl?: string;
};

export type AcpRelayBridgeConfigFormat = "generic" | "zed" | "all";

export function createAcpRelayBridgeStdioConfig(
  options: AcpRelayBridgeConfigOptions,
): {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
} {
  const baseArgs = options.args ?? (options.command ? undefined : ["bridge", "run"]);
  const args =
    baseArgs && options.relayUrl
      ? [...baseArgs, "--relay-url", options.relayUrl]
      : baseArgs;
  const env =
    !args && options.relayUrl ? { ACP_RELAY_URL: options.relayUrl } : undefined;
  return {
    ...(args ? { args } : {}),
    command: options.command ?? resolveInstalledAcpRuntimeCommand(),
    ...(env ? { env } : {}),
  };
}

export function createAcpRelayBridgeZedConfig(
  options: AcpRelayBridgeConfigOptions,
): {
  type: "custom";
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
} {
  return {
    type: "custom",
    ...createAcpRelayBridgeStdioConfig(options),
  };
}

export function parseAcpRelayBridgeConfigArgs(argv: readonly string[]): {
  args?: readonly string[];
  command?: string;
  format: AcpRelayBridgeConfigFormat;
  relayUrl?: string;
} {
  let args: readonly string[] | undefined;
  let command: string | undefined;
  let format: AcpRelayBridgeConfigFormat = "generic";
  let legacyCommand = false;
  let relayUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--command":
        command = readArgValue(argv, index, arg);
        args = ["bridge", "run"];
        legacyCommand = false;
        index += 1;
        break;
      case "--legacy-command":
        command = readArgValue(argv, index, arg);
        args = undefined;
        legacyCommand = true;
        index += 1;
        break;
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--format":
        format = readConfigFormat(readArgValue(argv, index, arg));
        index += 1;
        break;
      case "--zed":
        format = "zed";
        break;
      case "--all":
        format = "all";
        break;
      default:
        throw new Error(`Unknown bridge config option: ${arg}`);
    }
  }
  return {
    args: args ?? (legacyCommand ? undefined : ["bridge", "run"]),
    command,
    format,
    relayUrl,
  };
}

export function parseAcpRelayBridgeRunArgs(input: {
  argv: readonly string[];
  env?: Record<string, string | undefined>;
}): {
  relayUrl: string;
} {
  const env = input.env ?? process.env;
  let relayUrl: string | undefined;
  for (let index = 0; index < input.argv.length; index += 1) {
    const arg = input.argv[index];
    switch (arg) {
      case "--relay-url":
        relayUrl = readArgValue(input.argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown bridge run option: ${arg}`);
    }
  }
  return {
    relayUrl: relayUrl ?? env.ACP_RELAY_URL ?? ACP_REMOTE_DEFAULT_RELAY_URL,
  };
}

export function resolveInstalledAcpRuntimeCommand(): string {
  try {
    const output = execFileSync("/bin/sh", ["-lc", "command -v acp-runtime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const command = output.split("\n")[0]?.trim();
    if (command && isAbsolute(command)) {
      return command;
    }
  } catch {
    // Fall back to PATH lookup at runtime when the CLI is not installed globally.
  }
  return "acp-runtime";
}

function readArgValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function readConfigFormat(value: string): AcpRelayBridgeConfigFormat {
  if (value === "generic" || value === "zed" || value === "all") {
    return value;
  }
  throw new Error(`Invalid --format value: ${value}. Expected generic, zed, or all.`);
}
