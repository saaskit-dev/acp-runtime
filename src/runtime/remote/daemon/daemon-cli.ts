import type {
  AcpRemoteDaemonConnectionOptions,
} from "./relay-connection.js";
import {
  connectAcpRemoteDaemonRelay,
  type AcpRemoteDaemonSocketFactory,
  type ConnectedAcpRemoteDaemonRelay,
  type DaemonMetadata,
} from "./relay-client.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";

export type AcpRemoteDaemonCliEnvironment = Record<string, string | undefined>;

export const ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR =
  "ACP_REMOTE_DAEMON_ACCOUNT_ID" as const;
export const ACP_REMOTE_DAEMON_ACCOUNT_SESSION_ENV_VAR =
  "ACP_REMOTE_DAEMON_ACCOUNT_SESSION" as const;
export const ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR =
  "ACP_REMOTE_DAEMON_DAEMON_ID" as const;
export const ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR =
  "ACP_REMOTE_DAEMON_IDENTITY_PATH" as const;
export const ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR =
  "ACP_REMOTE_DAEMON_RELAY_URL" as const;

export type AcpRemoteDaemonCliConfig = {
  accountId?: string;
  accountSession?: string;
  daemonId?: string;
  forceLogin?: boolean;
  daemonMetadata?: DaemonMetadata;
  identityPath?: string;
  relayUrl: string;
};

export type ConnectAcpRemoteDaemonCliOptions = Omit<
  AcpRemoteDaemonConnectionOptions,
  "daemonId" | "socket"
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
    accountSession: config.accountSession,
    daemonId: config.daemonId as string | undefined,
    daemonMetadata: config.daemonMetadata,
    identityPath: config.identityPath,
    remoteMachineName: config.daemonMetadata?.machine,
    relayUrl: config.relayUrl,
    socketFactory,
  } as Parameters<typeof connectAcpRemoteDaemonRelay>[0]);
}

export function parseAcpRemoteDaemonCliConfig(input: {
  argv: readonly string[];
  env?: AcpRemoteDaemonCliEnvironment;
}): AcpRemoteDaemonCliConfig {
  const values = parseNamedArgs(input.argv);
  const env = input.env ?? process.env;
  const accountId = values.accountId ?? env[ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR];
  const accountSession =
    values.accountSession ?? env[ACP_REMOTE_DAEMON_ACCOUNT_SESSION_ENV_VAR];
  const daemonId = values.daemonId ?? env[ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR];
  const relayUrl =
    values.relayUrl ??
    env[ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR] ??
    ACP_REMOTE_DEFAULT_RELAY_URL;
  const identityPath =
    values.identityPath ?? env[ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR];

  return {
    accountId,
    accountSession,
    daemonId,
    forceLogin: values.forceLogin,
    identityPath,
    relayUrl,
  };
}

const EXTRA_ARG_KEYS = new Set(["--agent-command", "--workspace-root"]);

function parseNamedArgs(argv: readonly string[]): Partial<AcpRemoteDaemonCliConfig> {
  const values: Partial<AcpRemoteDaemonCliConfig> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--account-id":
        values.accountId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--account-session":
        values.accountSession = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--host-id":
        values.daemonId = readArgValue(argv, index, arg);
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
      case "--force-login":
        values.forceLogin = true;
        break;
      default:
        if (EXTRA_ARG_KEYS.has(arg)) {
          index += 1;
          break;
        }
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
