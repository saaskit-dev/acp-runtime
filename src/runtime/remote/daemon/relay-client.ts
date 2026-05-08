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
  runtimeInstanceId?: string;
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
  try {
    await waitForAcpRemoteDaemonSocketOpen(socket);
  } catch (error) {
    socket.close(1000, "ACP remote daemon relay failed before opening.");
    throw error;
  }
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

const WEBSOCKET_OPEN_READY_STATE = 1;
const DEFAULT_SOCKET_OPEN_TIMEOUT_MS = 30_000;

function waitForAcpRemoteDaemonSocketOpen(
  socket: AcpWebSocketLike,
  timeoutMs = DEFAULT_SOCKET_OPEN_TIMEOUT_MS,
): Promise<void> {
  const candidate = socket as AcpWebSocketLike & {
    addEventListener?(type: "open", listener: () => void): void;
    readyState?: number;
    removeEventListener?(type: "open", listener: () => void): void;
  };
  if (
    typeof candidate.readyState !== "number" ||
    candidate.readyState === WEBSOCKET_OPEN_READY_STATE
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      candidate.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("close", onClose);
      socket.removeEventListener?.("error", onError);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onOpen = () => {
      settle(resolve);
    };
    const onClose = (event?: unknown) => {
      const details = normalizeDaemonSocketCloseEvent(event);
      settle(() => {
        reject(
          new Error(
            `ACP remote daemon relay closed before opening${details ? ` (${details})` : ""}.`,
          ),
        );
      });
    };
    const onError = (event?: unknown) => {
      const details = normalizeDaemonSocketErrorEvent(event);
      settle(() => {
        reject(
          new Error(
            `ACP remote daemon relay failed before opening${details ? ` (${details})` : ""}.`,
          ),
        );
      });
    };
    const timeout = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `ACP remote daemon relay did not open within ${timeoutMs}ms.`,
          ),
        );
      });
    }, timeoutMs);

    candidate.addEventListener?.("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function normalizeDaemonSocketCloseEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { code?: unknown; reason?: unknown };
  const parts: string[] = [];
  if (typeof candidate.code === "number") {
    parts.push(`code=${candidate.code}`);
  }
  if (typeof candidate.reason === "string" && candidate.reason) {
    parts.push(`reason=${candidate.reason}`);
  } else if (candidate.reason instanceof Uint8Array && candidate.reason.length) {
    parts.push(`reason=${new TextDecoder().decode(candidate.reason)}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function normalizeDaemonSocketErrorEvent(event: unknown): string | undefined {
  if (event instanceof Error) {
    return formatDaemonSocketErrorMessage(event.message);
  }
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { error?: unknown; message?: unknown };
  if (candidate.error instanceof Error) {
    return formatDaemonSocketErrorMessage(candidate.error.message);
  }
  if (typeof candidate.message === "string" && candidate.message) {
    return formatDaemonSocketErrorMessage(candidate.message);
  }
  return undefined;
}

function formatDaemonSocketErrorMessage(message: string): string {
  if (/unexpected server response:\s*401/i.test(message)) {
    return "relay login expired or invalid (HTTP 401); run `acp-runtime auth login --force` and restart the daemon";
  }
  return message;
}
