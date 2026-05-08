import { describe, expect, it } from "vitest";

import {
  createAcpRelayLogUploadUrl,
  createAcpRelayLogUploader,
  createAcpRelayLogUploaderFromEnv,
} from "./relay-log-upload.js";

describe("relay log upload", () => {
  it("derives the HTTP log endpoint from relay WebSocket URLs", () => {
    expect(createAcpRelayLogUploadUrl("wss://relay.test/client?daemonId=host-1")).toBe(
      "https://relay.test/api/logs",
    );
    expect(createAcpRelayLogUploadUrl("ws://localhost:8787/daemon")).toBe(
      "http://localhost:8787/api/logs",
    );
  });

  it("batches records and sends account session authorization", async () => {
    const requests: Request[] = [];
    const uploader = createAcpRelayLogUploader({
      accountSession: "session-token",
      batchSize: 2,
      context: {
        "acp.remote.daemon_id": "host-1",
      },
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "daemon",
    });

    uploader.writeText(
      "connected",
      {
        "acp.remote.component": "daemon",
      },
      {
        spanId: "span-1",
        traceId: "trace-1",
      },
    );
    uploader.emit({
      eventName: "acp.session.start",
      kind: "otel_span",
      observedAt: "2026-05-06T00:00:00.000Z",
      spanContext: {
        traceId: "trace-1",
      },
    });
    await uploader.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer session-token",
    );
    await expect(requests[0].json()).resolves.toMatchObject({
      context: {
        "acp.remote.daemon_id": "host-1",
      },
      records: [
        {
          body: "connected",
          kind: "text",
          spanId: "span-1",
          traceId: "trace-1",
        },
        {
          eventName: "acp.session.start",
          kind: "otel_span",
          traceId: "trace-1",
        },
      ],
      source: "daemon",
      version: 1,
    });
  });

  it("uses env configuration and supports an emergency disable switch", () => {
    expect(
      createAcpRelayLogUploaderFromEnv({
        env: {
          ACP_ACCOUNT_SESSION: "session-token",
          ACP_RELAY_LOG_UPLOAD: "0",
          ACP_RELAY_URL: "wss://relay.test/client",
        },
        source: "bridge",
      }),
    ).toBeUndefined();

    expect(
      createAcpRelayLogUploaderFromEnv({
        env: {
          ACP_ACCOUNT_SESSION: "session-token",
          ACP_RELAY_URL: "wss://relay.test/client",
        },
        source: "bridge",
      }),
    ).toBeTruthy();
  });

  it("splits oversized batches before uploading", async () => {
    const requests: Request[] = [];
    const uploader = createAcpRelayLogUploader({
      accountSession: "session-token",
      batchSize: 100,
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "daemon",
    });

    for (let index = 0; index < 40; index += 1) {
      uploader.writeText(`${index}:${"x".repeat(20_000)}`);
    }
    await uploader.flush();

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(Buffer.byteLength(await request.text(), "utf8")).toBeLessThan(
        512 * 1024,
      );
    }
  });

  it("keeps queued records for retry after transient upload failure", async () => {
    const requests: Request[] = [];
    let fail = true;
    const uploader = createAcpRelayLogUploader({
      accountSession: "session-token",
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        if (fail) {
          throw new Error("fetch failed");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "bridge",
    });

    uploader.writeText("connected");
    await uploader.flush();
    fail = false;
    await uploader.flush();

    expect(requests).toHaveLength(2);
    await expect(requests[1].json()).resolves.toMatchObject({
      records: [
        {
          body: "connected",
          kind: "text",
        },
      ],
    });
  });
});
