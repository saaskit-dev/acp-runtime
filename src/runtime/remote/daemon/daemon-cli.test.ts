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
      daemonId: "host-1",
      forceLogin: undefined,
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
      daemonId: "host-1",
      forceLogin: undefined,
      identityPath: "/tmp/identity.json",
      relayUrl: "wss://relay.test",
    });
  });

  it("defaults accountId and daemonId to undefined", () => {
    expect(
      parseAcpRemoteDaemonCliConfig({
        argv: ["--relay-url", "wss://relay.test"],
        env: {},
      }),
    ).toEqual({
      accountId: undefined,
      daemonId: undefined,
      forceLogin: undefined,
      identityPath: undefined,
      relayUrl: "wss://relay.test",
    });
  });

  it("parses force-login without requiring a value", () => {
    expect(
      parseAcpRemoteDaemonCliConfig({
        argv: ["--force-login"],
        env: {},
      }),
    ).toMatchObject({
      forceLogin: true,
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("defaults relay URL to the hosted relay", () => {
    expect(
      parseAcpRemoteDaemonCliConfig({
        argv: [],
        env: {},
      }),
    ).toMatchObject({
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("rejects unknown relay connection config", () => {
    expect(() =>
      parseAcpRemoteDaemonCliConfig({
        argv: ["--unknown"],
        env: {},
      }),
    ).toThrow("Unknown remote daemon option: --unknown");
  });
});
