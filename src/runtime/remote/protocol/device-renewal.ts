export type AcpRemoteDeviceRenewalProofInput = {
  accountId: string;
  clientId: string;
  connectionId: string;
  daemonId: string;
  nonce: string;
  ticketJti: string;
  timestamp: string;
};

export type AcpRemoteSignedDeviceRenewalProof =
  AcpRemoteDeviceRenewalProofInput & {
    signature: string;
  };

type AcpRemoteDevicePrivateKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;

export type AcpRemoteDeviceKeyPair = {
  privateKey: AcpRemoteDevicePrivateKey;
  publicKey: string;
};

export type AcpRemoteDeviceRenewalVerificationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

const MAX_DEVICE_RENEWAL_PROOF_SKEW_MS = 5 * 60 * 1000;

export async function createAcpRemoteDeviceKeyPair(): Promise<AcpRemoteDeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as {
    privateKey: AcpRemoteDevicePrivateKey;
    publicKey: AcpRemoteDevicePrivateKey;
  };
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
  };
}

export async function createAcpRemoteDeviceRenewalSignature(
  input: AcpRemoteDeviceRenewalProofInput & {
    privateKey: AcpRemoteDevicePrivateKey;
  },
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    toArrayBuffer(new TextEncoder().encode(deviceRenewalPayload(input))),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyAcpRemoteDeviceRenewalProof(input: {
  now?: Date;
  proof: AcpRemoteSignedDeviceRenewalProof;
  publicKey: string;
}): Promise<AcpRemoteDeviceRenewalVerificationResult> {
  if (!input.proof.nonce) {
    return { ok: false, reason: "Missing ACP remote renewal nonce." };
  }
  if (
    input.proof.nonce.length < 16 ||
    input.proof.nonce.length > 128 ||
    !/^[0-9a-zA-Z_-]+$/.test(input.proof.nonce)
  ) {
    return {
      ok: false,
      reason:
        "ACP remote renewal nonce must be 16-128 base64url or hex characters.",
    };
  }
  const timestamp = Number(input.proof.timestamp);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "Invalid ACP remote renewal timestamp." };
  }
  const now = input.now?.getTime() ?? Date.now();
  if (Math.abs(now - timestamp) > MAX_DEVICE_RENEWAL_PROOF_SKEW_MS) {
    return { ok: false, reason: "ACP remote renewal proof expired." };
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlToBytes(input.publicKey)),
      "Ed25519",
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      toArrayBuffer(base64UrlToBytes(input.proof.signature)),
      toArrayBuffer(new TextEncoder().encode(deviceRenewalPayload(input.proof))),
    );
    return valid
      ? { ok: true }
      : { ok: false, reason: "Invalid ACP remote renewal signature." };
  } catch {
    return { ok: false, reason: "Invalid ACP remote renewal signature." };
  }
}

function deviceRenewalPayload(input: AcpRemoteDeviceRenewalProofInput): string {
  return [
    input.accountId,
    input.clientId,
    input.connectionId,
    input.daemonId,
    input.ticketJti,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
