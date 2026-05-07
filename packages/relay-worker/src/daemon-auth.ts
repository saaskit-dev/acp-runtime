export type AcpDaemonRegistrationProofInput = {
  accountId: string;
  daemonId: string;
  nonce: string;
  timestamp: string;
};

export type AcpDaemonRegistrationVerificationOptions =
  AcpDaemonRegistrationProofInput & {
    now?: Date;
    publicKey?: string;
    publicKeys?: readonly string[];
    signature: string;
  };

export type AcpDaemonRegistrationVerificationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

const MAX_DAEMON_PROOF_SKEW_MS = 5 * 60 * 1000;

export type AcpDaemonRegistrationKeyPair = {
  privateKey: CryptoKey;
  publicKey: string;
};

export async function createDaemonRegistrationKeyPair(): Promise<AcpDaemonRegistrationKeyPair> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
  };
}

export async function createDaemonRegistrationKeySignature(
  input: AcpDaemonRegistrationProofInput & {
    privateKey: CryptoKey;
  },
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    toArrayBuffer(new TextEncoder().encode(daemonRegistrationPayload(input))),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyDaemonRegistrationProof(
  options: AcpDaemonRegistrationVerificationOptions,
): Promise<AcpDaemonRegistrationVerificationResult> {
  if (!options.nonce) {
    return { ok: false, reason: "Missing daemon registration nonce." };
  }
  const timestamp = Number(options.timestamp);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: "Invalid daemon registration timestamp." };
  }
  const now = options.now?.getTime() ?? Date.now();
  if (Math.abs(now - timestamp) > MAX_DAEMON_PROOF_SKEW_MS) {
    return { ok: false, reason: "Daemon registration proof expired." };
  }

  const publicKeys = [
    ...(options.publicKey ? [options.publicKey] : []),
    ...(options.publicKeys ?? []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  if (publicKeys.length > 0) {
    for (const publicKey of publicKeys) {
      const valid = await verifyDaemonRegistrationKeySignature({
        ...options,
        publicKey,
      });
      if (valid) {
        return { ok: true };
      }
    }
    return { ok: false, reason: "Invalid daemon registration signature." };
  }

  return { ok: false, reason: "Daemon registration proof key is not configured." };
}

async function verifyDaemonRegistrationKeySignature(
  input: AcpDaemonRegistrationProofInput & {
    publicKey: string;
    signature: string;
  },
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlToBytes(input.publicKey)),
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      toArrayBuffer(base64UrlToBytes(input.signature)),
      toArrayBuffer(new TextEncoder().encode(daemonRegistrationPayload(input))),
    );
  } catch {
    return false;
  }
}

function daemonRegistrationPayload(
  input: AcpDaemonRegistrationProofInput,
): string {
  return [
    input.accountId,
    input.daemonId,
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
