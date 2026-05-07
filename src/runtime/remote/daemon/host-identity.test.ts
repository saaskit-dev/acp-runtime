import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { verifyDaemonRegistrationProof } from "../../../../packages/relay-worker/src/daemon-auth.js";
import { resolveRuntimeHomePath } from "../../paths.js";
import {
  createAcpRemoteDaemonIdentity,
  createAcpRemoteDaemonHostRegistrationRecord,
  createAcpRemoteDaemonIdentityRecord,
  createAcpRemoteDaemonRegistrationHeaders,
  loadAcpRemoteDaemonIdentity,
  loadOrCreateAcpRemoteDaemonIdentity,
  resolveAcpRemoteDaemonIdentityPath,
  rotateAcpRemoteDaemonIdentity,
  saveAcpRemoteDaemonIdentity,
} from "./host-identity.js";

describe("ACP remote daemon host identity", () => {
  it("creates, saves, and reloads a daemon identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");
    const identity = await createAcpRemoteDaemonIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );

    await saveAcpRemoteDaemonIdentity(path, identity);

    await expect(loadAcpRemoteDaemonIdentity(path)).resolves.toEqual(identity);
  });

  it("reuses an existing identity via loadOrCreate", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");

    const first = await loadOrCreateAcpRemoteDaemonIdentity({
      accountId: "acct-1",
      daemonId: "host-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
      path,
    });
    const second = await loadOrCreateAcpRemoteDaemonIdentity({
      accountId: "acct-1",
      daemonId: "host-1",
      now: new Date("2026-04-27T00:01:00.000Z"),
      path,
    });

    expect(second).toEqual(first);
  });

  it("rotates identity keys and preserves previous public key", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");
    const first = await loadOrCreateAcpRemoteDaemonIdentity({
      accountId: "acct-1",
      daemonId: "host-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
      path,
    });

    const rotated = await rotateAcpRemoteDaemonIdentity({
      accountId: "acct-1",
      daemonId: "host-1",
      now: new Date("2026-04-27T00:05:00.000Z"),
      path,
    });

    expect(rotated.publicKey).not.toBe(first.publicKey);
    expect(rotated.previousPublicKey).toBe(first.publicKey);
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.updatedAt).toBe("2026-04-27T00:05:00.000Z");
    await expect(loadAcpRemoteDaemonIdentity(path)).resolves.toEqual(rotated);
  });

  it("creates relay registration headers that verify against the host public key", async () => {
    const identity = await createAcpRemoteDaemonIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );
    const headers = await createAcpRemoteDaemonRegistrationHeaders({
      accountId: "acct-1",
      daemonId: "host-1",
      identity,
      nonce: "nonce-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
    });

    await expect(
      verifyDaemonRegistrationProof({
        accountId: "acct-1",
        daemonId: "host-1",
        nonce: headers["x-acp-daemon-nonce"],
        now: new Date("2026-04-27T00:00:00.000Z"),
        publicKey: identity.publicKey,
        signature: headers["x-acp-daemon-signature"],
        timestamp: headers["x-acp-daemon-timestamp"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(headers["x-acp-daemon-public-key"]).toBe(identity.publicKey);
  });

  it("derives a host registration record from stored identity", async () => {
    const identity = await createAcpRemoteDaemonIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );

    expect(createAcpRemoteDaemonIdentityRecord(identity)).toEqual({
      previousPublicKey: undefined,
      publicKey: identity.publicKey,
    });
    expect(
      createAcpRemoteDaemonHostRegistrationRecord({
        accountId: "acct-1",
        daemonId: "host-1",
        identity,
      }),
    ).toEqual({
      accountId: "acct-1",
      daemonId: "host-1",
      previousPublicKey: undefined,
      publicKey: identity.publicKey,
    });
  });

  it("encodes account and host ids in the default runtime-home path", async () => {
    expect(resolveAcpRemoteDaemonIdentityPath("acct/a", "host b")).toBe(
      resolveRuntimeHomePath("remote", "hosts", "acct%2Fa", "host%20b.json"),
    );
  });
});
