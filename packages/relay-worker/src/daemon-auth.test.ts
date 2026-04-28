import { describe, expect, it } from "vitest";

import {
  createDaemonRegistrationKeyPair,
  createDaemonRegistrationKeySignature,
  verifyDaemonRegistrationProof,
} from "./daemon-auth.js";

describe("daemon registration proof", () => {
  it("verifies per-host public key daemon registration payloads", async () => {
    const keyPair = await createDaemonRegistrationKeyPair();
    const input = {
      accountId: "acct-1",
      hostId: "host-1",
      nonce: "nonce-1",
      timestamp: "1777248000000",
    };

    const signature = await createDaemonRegistrationKeySignature({
      ...input,
      privateKey: keyPair.privateKey,
    });

    await expect(
      verifyDaemonRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature,
      }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyDaemonRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature: "bad-signature",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Invalid daemon registration signature.",
    });
  });

  it("rejects stale or invalid daemon registration payloads", async () => {
    const keyPair = await createDaemonRegistrationKeyPair();
    const input = {
      accountId: "acct-1",
      hostId: "host-1",
      nonce: "nonce-1",
      timestamp: "1777248000000",
    };
    const signature = await createDaemonRegistrationKeySignature({
      ...input,
      privateKey: keyPair.privateKey,
    });

    await expect(
      verifyDaemonRegistrationProof({
        ...input,
        now: new Date(1777248600001),
        publicKey: keyPair.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Daemon registration proof expired.",
    });
    await expect(
      verifyDaemonRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature: "bad-signature",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Invalid daemon registration signature.",
    });
  });
});
