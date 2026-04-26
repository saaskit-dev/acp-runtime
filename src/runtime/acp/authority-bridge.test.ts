import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpClientBridge } from "./authority-bridge.js";

describe("AcpClientBridge", () => {
  it("serializes concurrent session updates in arrival order", async () => {
    const bridge = new AcpClientBridge();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    bridge.setSessionUpdateHandler(async (params) => {
      const label = (
        params.update.sessionUpdate === "agent_message_chunk"
          ? params.update.content.text
          : "unknown"
      ) ?? "unknown";
      order.push(`start:${label}`);
      if (label === "first") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push(`end:${label}`);
    });

    const first = bridge.sessionUpdate(messageUpdate("first"));
    const second = bridge.sessionUpdate(messageUpdate("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(["start:first"]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });
});

function messageUpdate(text: string): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      content: {
        text,
        type: "text",
      },
      sessionUpdate: "agent_message_chunk",
    },
  } satisfies SessionNotification;
}
