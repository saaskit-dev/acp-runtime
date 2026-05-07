import {
  createAcpRemoteRelayUrl,
  createAcpRemoteWebSocketFactory,
  type AcpRemoteSocketFactory,
  type AcpRemoteWebSocketConstructor,
} from "../shared/index.js";
import {
  createAcpRemoteDaemonConnection,
  type AcpRemoteDaemonConnectionHandle,
  type AcpRemoteDaemonConnectionOptions,
} from "./relay-connection.js";
import {
  createAcpRemoteDaemonRegistrationHeaders,
  loadOrCreateAcpRemoteDaemonIdentity,
  loadOrCreateDaemonMachineIdentity,
  type AcpRemoteDaemonIdentity,
} from "./host-identity.js";
import type { AcpWebSocketLike } from "../protocol/websocket-stream.js";

export type DaemonMetadata = {
  agentTypes: readonly {
    command?: string;
    id?: string;
    type?: string;
    label: string;
  }[];
  machine?: string;
  workspaceRoots: readonly { path: string; label?: string }[];
};

export type AcpRemoteDaemonSocketFactory = AcpRemoteSocketFactory;
export type AcpRemoteDaemonWebSocketConstructor = AcpRemoteWebSocketConstructor;

export type ConnectAcpRemoteDaemonRelayOptions = Omit<
  AcpRemoteDaemonConnectionOptions,
  "socket"
> & {
  accountId?: string;
  accountSession?: string;
  daemonId?: string;
  daemonMetadata?: DaemonMetadata;
  identity?: AcpRemoteDaemonIdentity;
  identityPath?: string;
  relayUrl: string | URL;
  socketFactory: AcpRemoteSocketFactory;
};

export type ConnectedAcpRemoteDaemonRelay =
  AcpRemoteDaemonConnectionHandle & {
    headers: Record<string, string>;
    daemonId: string;
    identity: AcpRemoteDaemonIdentity;
    socket: AcpWebSocketLike;
    url: string;
  };

export async function connectAcpRemoteDaemonRelay(
  options: ConnectAcpRemoteDaemonRelayOptions,
): Promise<ConnectedAcpRemoteDaemonRelay> {
  const machine = await loadOrCreateDaemonMachineIdentity();
  const daemonId = options.daemonId ?? machine.daemonId;
  const accountId = options.accountId ?? "default";

  const identity =
    options.identity ??
    (options.identityPath
      ? await loadOrCreateAcpRemoteDaemonIdentity({
          accountId,
          daemonId,
          path: options.identityPath,
        })
      : machine.identity);

  const url = createAcpRemoteDaemonRelayUrl({
    accountId,
    daemonId,
    relayUrl: options.relayUrl,
  });
  const headers = await createAcpRemoteDaemonRegistrationHeaders({
    accountId,
    daemonId,
    identity,
  });
  if (options.accountSession) {
    headers["Authorization"] = `Bearer ${options.accountSession}`;
  }
  if (options.daemonMetadata) {
    headers["x-acp-daemon-metadata"] = JSON.stringify(options.daemonMetadata);
  }
  const socket = options.socketFactory({
    headers,
    url,
  });
  const handle = createAcpRemoteDaemonConnection({
    ...options,
    daemonId,
    socket,
  });
  return {
    ...handle,
    headers,
    daemonId,
    identity,
    socket,
    url,
  };
}

export const createAcpRemoteDaemonWebSocketFactory = createAcpRemoteWebSocketFactory;

export function createAcpRemoteDaemonRelayUrl(input: {
  accountId: string;
  daemonId: string;
  relayUrl: string | URL;
}): string {
  return createAcpRemoteRelayUrl({
    endpointPath: "/daemon",
    params: {
      accountId: input.accountId,
      daemonId: input.daemonId,
    },
    relayUrl: input.relayUrl,
  });
}
