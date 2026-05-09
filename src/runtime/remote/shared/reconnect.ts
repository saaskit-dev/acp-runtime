export type AcpRemoteReconnectBackoffOptions = {
  maxDelayMs?: number;
  minDelayMs?: number;
};

export type AcpRemoteReconnectBackoff = {
  nextDelayMs(): number;
  reset(): void;
};

export type AcpRemoteReconnectLoopOptions<TConnection> =
  AcpRemoteReconnectBackoffOptions & {
    connect(): Promise<TConnection> | TConnection;
    isStopping(): boolean;
    onConnected?(connection: TConnection): void;
    onConnectError?(error: unknown): void;
    onDisconnected?(connection: TConnection): void;
    onRetry?(delayMs: number): void;
    waitForDisconnect(connection: TConnection): Promise<void>;
  };

const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

export function createAcpRemoteReconnectBackoff(
  options: AcpRemoteReconnectBackoffOptions = {},
): AcpRemoteReconnectBackoff {
  const minDelayMs = options.minDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  let currentDelayMs = minDelayMs;

  return {
    nextDelayMs() {
      const delayMs = currentDelayMs;
      currentDelayMs = Math.min(currentDelayMs * 2, maxDelayMs);
      return delayMs;
    },
    reset() {
      currentDelayMs = minDelayMs;
    },
  };
}

export async function runAcpRemoteReconnectLoop<TConnection>(
  options: AcpRemoteReconnectLoopOptions<TConnection>,
): Promise<void> {
  const backoff = createAcpRemoteReconnectBackoff(options);

  while (!options.isStopping()) {
    try {
      const connection = await options.connect();
      backoff.reset();
      options.onConnected?.(connection);
      await options.waitForDisconnect(connection);
      if (!options.isStopping()) {
        options.onDisconnected?.(connection);
      }
    } catch (error) {
      if (!options.isStopping()) {
        options.onConnectError?.(error);
      }
    }

    if (options.isStopping()) {
      return;
    }

    const delayMs = backoff.nextDelayMs();
    options.onRetry?.(delayMs);
    await delay(delayMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
