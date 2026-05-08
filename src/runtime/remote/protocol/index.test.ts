import { describe, expect, it } from "vitest";

import { createMemoryWebSocketPair } from "../shared/test-helpers.js";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteDeviceKeyPair,
  createAcpRemoteDeviceRenewalSignature,
  createAcpRemoteConnectionTicket,
  createAcpRemoteSignedConnectionTicket,
  hasAcpRemoteScope,
  isAcpRemoteFrame,
  isConnectionTicketExpired,
  requireAcpRemoteScopes,
  verifyAcpRemoteDeviceRenewalProof,
  verifyAcpRemoteSignedConnectionTicket,
  type AcpRemoteConnectionTicket,
} from "./index.js";
import { createAcpJsonRpcWebSocketStream } from "./websocket-stream.js";

describe("remote ACP protocol", () => {
  it("validates typed remote frames", () => {
    const frame = {
      connectionId: "conn-1",
      endpoint: AcpRemoteEndpointKind.Client,
      frameType: AcpRemoteFrameType.Hello,
      protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
    };

    expect(isAcpRemoteFrame(frame)).toBe(true);
    expect(assertAcpRemoteFrame(frame)).toEqual(frame);
    expect(
      isAcpRemoteFrame({
        ...frame,
        protocolVersion: 999,
      }),
    ).toBe(false);
  });

  it("validates data frame routing metadata", () => {
    expect(
      isAcpRemoteFrame({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-1",
        frameType: AcpRemoteFrameType.Data,
        payload: { jsonrpc: "2.0" },
        seq: 1,
      }),
    ).toBe(true);
  });

  it("checks ticket expiration and scopes", () => {
    const ticket: AcpRemoteConnectionTicket = {
      accountId: "acct-1",
      clientId: "client-1",
      connectionId: "conn-1",
      expiresAt: "2026-04-27T00:10:00.000Z",
      daemonId: "host-1",
      issuedAt: "2026-04-27T00:00:00.000Z",
      jti: "ticket-1",
      policyVersion: 1,
      scopes: ["acp:connect", "acp:turn:send"],
    };

    expect(
      isConnectionTicketExpired(ticket, new Date("2026-04-27T00:09:00.000Z")),
    ).toBe(false);
    expect(
      isConnectionTicketExpired(ticket, new Date("2026-04-27T00:11:00.000Z")),
    ).toBe(true);
    expect(hasAcpRemoteScope(ticket, "acp:connect")).toBe(true);
    expect(() => requireAcpRemoteScopes(ticket, ["fs:write"])).toThrow(
      "missing scopes",
    );
  });

  it("creates one-hour connection tickets by default", () => {
    const ticket = createAcpRemoteConnectionTicket({
      connectionId: "conn-default-ttl",
      grant: {
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        policyVersion: 1,
        scopes: ["acp:connect"],
      },
      jti: "ticket-default-ttl",
      now: new Date("2026-04-27T00:00:00.000Z"),
    });

    expect(ticket.expiresAt).toBe("2026-04-27T01:00:00.000Z");
  });

  it("signs and verifies connection tickets", async () => {
    const key = {
      kid: "test-key",
      secret: "relay-ticket-secret",
    };
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-1",
      grant: {
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        policyVersion: 1,
        scopes: ["acp:connect", "acp:turn:send"],
      },
      jti: "ticket-1",
      key,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    await expect(
      verifyAcpRemoteSignedConnectionTicket(ticket, key, {
        connectionId: "conn-1",
        daemonId: "host-1",
        now: new Date("2026-04-27T00:00:30.000Z"),
        requiredScopes: ["acp:connect"],
      }),
    ).resolves.toMatchObject({
      accountId: "acct-1",
      connectionId: "conn-1",
      daemonId: "host-1",
    });
    await expect(
      verifyAcpRemoteSignedConnectionTicket(
        {
          ...ticket,
          payload: {
            ...ticket.payload,
            daemonId: "host-2",
          },
        },
        key,
      ),
    ).rejects.toThrow("signature");
    await expect(
      verifyAcpRemoteSignedConnectionTicket(ticket, key, {
        now: new Date("2026-04-27T00:02:00.000Z"),
      }),
    ).rejects.toThrow("expired");
  });

  it("signs and verifies connection tickets with Ed25519 public keys", async () => {
    const keyPair = await createAcpRemoteDeviceKeyPair();
    const signingKey = {
      kid: "relay-test-ed25519",
      privateKey: keyPair.privateKey,
    };
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-ed25519",
      grant: {
        accountId: "acct-1",
        clientId: "client-1",
        daemonId: "host-1",
        policyVersion: 1,
        scopes: ["acp:connect"],
      },
      jti: "ticket-ed25519",
      key: signingKey,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    expect(ticket).toMatchObject({
      alg: "Ed25519",
      kid: "relay-test-ed25519",
    });
    await expect(
      verifyAcpRemoteSignedConnectionTicket(
        ticket,
        [
          {
            alg: "Ed25519",
            kid: "relay-test-ed25519",
            publicKey: keyPair.publicKey,
          },
        ],
        {
          connectionId: "conn-ed25519",
          daemonId: "host-1",
          now: new Date("2026-04-27T00:00:30.000Z"),
          requiredScopes: ["acp:connect"],
        },
      ),
    ).resolves.toMatchObject({
      accountId: "acct-1",
      connectionId: "conn-ed25519",
      daemonId: "host-1",
    });
  });

  it("verifies tickets after JSON transport drops undefined optional fields", async () => {
    const key = {
      kid: "test-key",
      secret: "relay-ticket-secret",
    };
    const ticket = await createAcpRemoteSignedConnectionTicket({
      connectionId: "conn-undefined",
      grant: {
        accountId: "acct-1",
        clientId: undefined,
        daemonId: "host-1",
        policyVersion: 1,
        scopes: ["acp:connect"],
        workspaceId: undefined,
      },
      jti: "ticket-undefined",
      key,
      now: new Date("2026-04-27T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    const transported = JSON.parse(
      JSON.stringify(ticket),
    ) as typeof ticket;

    await expect(
      verifyAcpRemoteSignedConnectionTicket(transported, key, {
        connectionId: "conn-undefined",
        daemonId: "host-1",
        now: new Date("2026-04-27T00:00:30.000Z"),
        requiredScopes: ["acp:connect"],
      }),
    ).resolves.toMatchObject({
      accountId: "acct-1",
      connectionId: "conn-undefined",
      daemonId: "host-1",
    });
  });

  it("signs and verifies device renewal proofs", async () => {
    const keyPair = await createAcpRemoteDeviceKeyPair();
    const proofInput = {
      accountId: "acct-1",
      clientId: "client-1",
      connectionId: "conn-1",
      daemonId: "host-1",
      nonce: "a1b2c3d4e5f6g7h8",
      ticketJti: "ticket-1",
      timestamp: String(Date.parse("2026-04-27T00:00:00.000Z")),
    };
    const proof = {
      ...proofInput,
      signature: await createAcpRemoteDeviceRenewalSignature({
        ...proofInput,
        privateKey: keyPair.privateKey,
      }),
    };

    await expect(
      verifyAcpRemoteDeviceRenewalProof({
        now: new Date("2026-04-27T00:00:30.000Z"),
        proof,
        publicKey: keyPair.publicKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyAcpRemoteDeviceRenewalProof({
        now: new Date("2026-04-27T00:00:30.000Z"),
        proof: {
          ...proof,
          daemonId: "host-2",
        },
        publicKey: keyPair.publicKey,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Invalid ACP remote renewal signature.",
    });
    await expect(
      verifyAcpRemoteDeviceRenewalProof({
        now: new Date("2026-04-27T00:10:00.000Z"),
        proof,
        publicKey: keyPair.publicKey,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "ACP remote renewal proof expired.",
    });
  });

  it("creates JSON-RPC streams over WebSocket-like transports", async () => {
    const [left, right] = createMemoryWebSocketPair();
    const leftStream = createAcpJsonRpcWebSocketStream(left);
    const rightStream = createAcpJsonRpcWebSocketStream(right);

    const writer = leftStream.writable.getWriter();
    const reader = rightStream.readable.getReader();
    await writer.write({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
    });

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
      },
    });

    reader.releaseLock();
    writer.releaseLock();
  });
});
