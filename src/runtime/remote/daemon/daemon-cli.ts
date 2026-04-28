import type {
  AcpRemoteDaemonConnectionOptions,
} from "./relay-connection.js";
import {
  connectAcpRemoteDaemonRelay,
  type AcpRemoteDaemonSocketFactory,
  type ConnectedAcpRemoteDaemonRelay,
} from "./relay-client.js";

export const ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR =
  "ACP_REMOTE_DAEMON_ACCOUNT_ID" as const;
export const ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR =
  "ACP_REMOTE_DAEMON_HOST_ID" as const;
export const ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR =
  "ACP_REMOTE_DAEMON_IDENTITY_PATH" as const;
export const ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR =
  "ACP_REMOTE_DAEMON_RELAY_URL" as const;

export type AcpRemoteDaemonCliEnvironment = Record<string, string | undefined>;

export type AcpRemoteDaemonCliConfig = {
  accountId: string;
  hostId: string;
  identityPath?: string;
  relayUrl: string;
};

export type ConnectAcpRemoteDaemonCliOptions = Omit<
  AcpRemoteDaemonConnectionOptions,
  "hostId" | "socket"
> & {
  config: AcpRemoteDaemonCliConfig;
  socketFactory: AcpRemoteDaemonSocketFactory;
};

export async function connectAcpRemoteDaemonRelayFromCliConfig(
  options: ConnectAcpRemoteDaemonCliOptions,
): Promise<ConnectedAcpRemoteDaemonRelay> {
  const { config, socketFactory, ...connectionOptions } = options;
  return connectAcpRemoteDaemonRelay({
    ...connectionOptions,
    accountId: config.accountId,
    hostId: config.hostId,
    identityPath: config.identityPath,
    relayUrl: config.relayUrl,
    socketFactory,
  });
}

export function parseAcpRemoteDaemonCliConfig(input: {
  argv: readonly string[];
  env?: AcpRemoteDaemonCliEnvironment;
}): AcpRemoteDaemonCliConfig {
  const values = parseNamedArgs(input.argv);
  const env = input.env ?? process.env;
  const accountId =
    values.accountId ?? env[ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR];
  const hostId = values.hostId ?? env[ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR];
  const relayUrl = values.relayUrl ?? env[ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR];
  const identityPath =
    values.identityPath ?? env[ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR];

  if (!accountId) {
    throw new Error("Missing remote daemon account id.");
  }
  if (!hostId) {
    throw new Error("Missing remote daemon host id.");
  }
  if (!relayUrl) {
    throw new Error("Missing remote daemon relay URL.");
  }

  return {
    accountId,
    hostId,
    identityPath,
    relayUrl,
  };
}

function parseNamedArgs(argv: readonly string[]): Partial<AcpRemoteDaemonCliConfig> {
  const values: Partial<AcpRemoteDaemonCliConfig> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--account-id":
        values.accountId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--host-id":
        values.hostId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--identity-path":
        values.identityPath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--relay-url":
        values.relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown remote daemon option: ${arg}`);
    }
  }
  return values;
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
