import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";

export type AcpRelayBridgeConfigOptions = {
  args?: readonly string[];
  command?: string;
  relayUrl?: string;
};

export function createAcpRelayBridgeStdioConfig(
  options: AcpRelayBridgeConfigOptions,
): {
  command: string;
  args?: readonly string[];
  env: Record<string, string>;
} {
  const args = options.args ?? (options.command ? undefined : ["bridge", "run"]);
  return {
    ...(args ? { args } : {}),
    command: options.command ?? "acp-runtime",
    env: {
      ACP_RELAY_URL: options.relayUrl ?? ACP_REMOTE_DEFAULT_RELAY_URL,
    },
  };
}

export function parseAcpRelayBridgeConfigArgs(argv: readonly string[]): {
  args?: readonly string[];
  command?: string;
  relayUrl: string;
} {
  let args: readonly string[] | undefined;
  let command: string | undefined;
  let relayUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--command":
        command = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--legacy-command":
        command = readArgValue(argv, index, arg);
        args = undefined;
        index += 1;
        break;
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown bridge config option: ${arg}`);
    }
  }
  return {
    args: args ?? (command ? undefined : ["bridge", "run"]),
    command,
    relayUrl: relayUrl ?? ACP_REMOTE_DEFAULT_RELAY_URL,
  };
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
