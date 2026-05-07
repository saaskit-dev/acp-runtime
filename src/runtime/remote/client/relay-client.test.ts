import { describe, expect, it } from "vitest";

import { createAcpRemoteClientRelayUrl } from "./relay-client.js";

describe("ACP remote client relay client", () => {
  it("builds native ACP client relay urls", () => {
    expect(
      createAcpRemoteClientRelayUrl({
        clientId: "client-1",
        connectionId: "conn-1",
        daemonId: "host-1",
        relayUrl: "https://relay.example.com/acp?foo=bar",
      }),
    ).toBe(
      "https://relay.example.com/acp?foo=bar&clientId=client-1&connectionId=conn-1&daemonId=host-1",
    );
  });

  it("routes remote-frame clients to the client endpoint", () => {
    expect(
      createAcpRemoteClientRelayUrl({
        clientId: "client-1",
        connectionId: "conn-1",
        relayUrl: "https://relay.example.com/acp",
        transport: "remote-frame",
      }),
    ).toBe(
      "https://relay.example.com/client?clientId=client-1&connectionId=conn-1",
    );
  });
});
