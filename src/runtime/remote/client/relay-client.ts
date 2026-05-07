import {
  createAcpRemoteRelayUrl,
  type AcpRemoteSocketFactory,
} from "../shared/index.js";
import {
  createAcpRemoteClientConnection,
} from "./relay-connection.js";

export type ConnectAcpRemoteClientRelayOptions = {
  accountSession?: string;
  clientId?: string;
  connectionId?: string;
  daemonId?: string;
  nativeClientAck?: boolean;
  relayUrl: string | URL;
  socketFactory: AcpRemoteSocketFactory;
  transport?: "native-acp" | "remote-frame";
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
};

export type AcpRemoteClientCloseEvent = {
  code?: number;
  reason?: string;
};

export type ConnectedAcpRemoteClientRelay = {
  close(): void;
  send(message: string): void;
  connectionId: string;
};

export function createAcpRemoteClientRelayUrl(input: {
  clientId: string;
  connectionId: string;
  daemonId?: string;
  nativeClientAck?: boolean;
  relayUrl: string | URL;
  transport?: "native-acp" | "remote-frame";
}): string {
  const params: Record<string, string> = {
    clientId: input.clientId,
    connectionId: input.connectionId,
  };
  if (input.daemonId) {
    params.daemonId = input.daemonId;
  }
  if (input.nativeClientAck) {
    params.nativeClientAck = "1";
  }
  return createAcpRemoteRelayUrl({
    endpointPath: input.transport === "remote-frame" ? "/client" : "/acp",
    params,
    relayUrl: input.relayUrl,
  });
}

export function connectAcpRemoteClientRelay(
  options: ConnectAcpRemoteClientRelayOptions,
): ConnectedAcpRemoteClientRelay {
  const transport = options.transport ?? "native-acp";
  const clientId = options.clientId ?? "editor-bridge";
  const connectionId = options.connectionId ?? crypto.randomUUID();

  const url = createAcpRemoteClientRelayUrl({
    clientId,
    connectionId,
    daemonId: options.daemonId,
    nativeClientAck: options.nativeClientAck,
    relayUrl: options.relayUrl,
    transport,
  });

  const headers: Record<string, string> = {};
  if (options.accountSession) {
    headers["Authorization"] = `Bearer ${options.accountSession}`;
  }
  const socket = options.socketFactory({
    headers,
    url,
  });

  const handle = createAcpRemoteClientConnection({
    connectionId,
    socket,
    transport,
    onMessage: options.onMessage,
    onClose: options.onClose,
    onError: options.onError,
  });

  return {
    close() { handle.close(); },
    send(message: string) { handle.send(message); },
    connectionId,
  };
}
