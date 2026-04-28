import {
  createAcpRemoteDaemonConnection,
  type AcpRemoteDaemonConnectionHandle,
  type AcpRemoteDaemonConnectionOptions,
} from "./relay-connection.js";
import {
  createAcpRemoteDaemonRegistrationHeaders,
  loadOrCreateAcpRemoteDaemonIdentity,
  type AcpRemoteDaemonIdentity,
} from "./host-identity.js";
import type { AcpWebSocketLike } from "../protocol/websocket-stream.js";

export type AcpRemoteDaemonSocketFactory = (input: {
  headers: Record<string, string>;
  url: string;
}) => AcpWebSocketLike;

export type AcpRemoteDaemonWebSocketConstructor = new (
  url: string,
  protocols?: readonly string[] | string,
  options?: {
    headers?: Record<string, string>;
  },
) => AcpWebSocketLike;

export type ConnectAcpRemoteDaemonRelayOptions = Omit<
  AcpRemoteDaemonConnectionOptions,
  "socket"
> & {
  accountId: string;
  identity?: AcpRemoteDaemonIdentity;
  identityPath?: string;
  relayUrl: string | URL;
  socketFactory: AcpRemoteDaemonSocketFactory;
};

export type ConnectedAcpRemoteDaemonRelay =
  AcpRemoteDaemonConnectionHandle & {
    headers: Record<string, string>;
    identity: AcpRemoteDaemonIdentity;
    socket: AcpWebSocketLike;
    url: string;
  };

export async function connectAcpRemoteDaemonRelay(
  options: ConnectAcpRemoteDaemonRelayOptions,
): Promise<ConnectedAcpRemoteDaemonRelay> {
  const identity =
    options.identity ??
    (await loadOrCreateAcpRemoteDaemonIdentity({
      accountId: options.accountId,
      hostId: options.hostId,
      path: options.identityPath,
    }));
  const url = createAcpRemoteDaemonRelayUrl({
    accountId: options.accountId,
    hostId: options.hostId,
    relayUrl: options.relayUrl,
  });
  const headers = await createAcpRemoteDaemonRegistrationHeaders({
    accountId: options.accountId,
    hostId: options.hostId,
    identity,
  });
  const socket = options.socketFactory({
    headers,
    url,
  });
  const handle = createAcpRemoteDaemonConnection({
    ...options,
    socket,
  });
  return {
    ...handle,
    headers,
    identity,
    socket,
    url,
  };
}

export function createAcpRemoteDaemonWebSocketFactory(
  WebSocketConstructor: AcpRemoteDaemonWebSocketConstructor,
): AcpRemoteDaemonSocketFactory {
  return ({ headers, url }) =>
    new WebSocketConstructor(url, undefined, {
      headers,
    });
}

export function createAcpRemoteDaemonRelayUrl(input: {
  accountId: string;
  hostId: string;
  relayUrl: string | URL;
}): string {
  const relayUrl = new URL(input.relayUrl);
  relayUrl.pathname = "/daemon";
  relayUrl.searchParams.set("accountId", input.accountId);
  relayUrl.searchParams.set("hostId", input.hostId);
  return relayUrl.toString();
}
