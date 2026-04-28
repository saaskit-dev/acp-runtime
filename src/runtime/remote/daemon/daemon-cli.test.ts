import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR,
  ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR,
  ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR,
  ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR,
  parseAcpRemoteDaemonCliConfig,
} from "./daemon-cli.js";

describe("remote daemon CLI connector", () => {
  it("parses relay connection config from CLI args", () => {
    expect(
      parseAcpRemoteDaemonCliConfig({
        argv: [
          "--account-id",
          "acct-1",
          "--host-id",
          "host-1",
          "--relay-url",
          "wss://relay.test",
          "--identity-path",
          "/tmp/identity.json",
        ],
        env: {},
      }),
    ).toEqual({
      accountId: "acct-1",
      hostId: "host-1",
      identityPath: "/tmp/identity.json",
      relayUrl: "wss://relay.test",
    });
  });

  it("parses relay connection config from environment", () => {
    expect(
      parseAcpRemoteDaemonCliConfig({
        argv: [],
        env: {
          [ACP_REMOTE_DAEMON_ACCOUNT_ID_ENV_VAR]: "acct-1",
          [ACP_REMOTE_DAEMON_HOST_ID_ENV_VAR]: "host-1",
          [ACP_REMOTE_DAEMON_IDENTITY_PATH_ENV_VAR]: "/tmp/identity.json",
          [ACP_REMOTE_DAEMON_RELAY_URL_ENV_VAR]: "wss://relay.test",
        },
      }),
    ).toEqual({
      accountId: "acct-1",
      hostId: "host-1",
      identityPath: "/tmp/identity.json",
      relayUrl: "wss://relay.test",
    });
  });

  it("rejects incomplete relay connection config", () => {
    expect(() =>
      parseAcpRemoteDaemonCliConfig({
        argv: ["--account-id", "acct-1"],
        env: {},
      }),
    ).toThrow("Missing remote daemon host id.");
    expect(() =>
      parseAcpRemoteDaemonCliConfig({
        argv: ["--unknown"],
        env: {},
      }),
    ).toThrow("Unknown remote daemon option: --unknown");
  });
});
