import { describe, expect, it } from "vitest";

import {
  createAcpRemoteReconnectBackoff,
  runAcpRemoteReconnectLoop,
} from "./reconnect.js";

describe("remote reconnect helpers", () => {
  it("advances and resets reconnect backoff", () => {
    const backoff = createAcpRemoteReconnectBackoff({
      maxDelayMs: 8,
      minDelayMs: 2,
    });

    expect(backoff.nextDelayMs()).toBe(2);
    expect(backoff.nextDelayMs()).toBe(4);
    expect(backoff.nextDelayMs()).toBe(8);
    expect(backoff.nextDelayMs()).toBe(8);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(2);
  });

  it("runs connect, disconnect, and retry through one loop", async () => {
    let stopping = false;
    const events: string[] = [];

    await runAcpRemoteReconnectLoop({
      async connect() {
        events.push("connect");
        return { id: "conn-1" };
      },
      isStopping: () => stopping,
      maxDelayMs: 1,
      minDelayMs: 1,
      onConnected(connection) {
        events.push(`connected:${connection.id}`);
      },
      onDisconnected(connection) {
        events.push(`disconnected:${connection.id}`);
        stopping = true;
      },
      onRetry(delayMs) {
        events.push(`retry:${delayMs}`);
      },
      async waitForDisconnect(connection) {
        events.push(`wait:${connection.id}`);
      },
    });

    expect(events).toEqual([
      "connect",
      "connected:conn-1",
      "wait:conn-1",
      "disconnected:conn-1",
    ]);
  });
});
