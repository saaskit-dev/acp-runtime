import {
  type AcpRemoteConnectionTicket,
  type AcpRemoteGrant,
  type AcpRemoteScope,
  type AcpRemoteSignedConnectionTicket,
} from "./types.js";
import {
  isConnectionTicketExpired,
  requireAcpRemoteScopes,
} from "./validation.js";

type AcpRemoteTicketCryptoKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;

export const ACP_REMOTE_TICKET_ALGORITHM = "Ed25519" as const;
export const ACP_REMOTE_LEGACY_TICKET_ALGORITHM = "HS256" as const;

export type AcpRemoteTicketSigningKey = {
  alg?: typeof ACP_REMOTE_TICKET_ALGORITHM | typeof ACP_REMOTE_LEGACY_TICKET_ALGORITHM;
  kid: string;
  privateKey?: AcpRemoteTicketCryptoKey | string;
  secret?: string | Uint8Array;
};

export type AcpRemoteTicketVerificationKey = {
  alg?: typeof ACP_REMOTE_TICKET_ALGORITHM | typeof ACP_REMOTE_LEGACY_TICKET_ALGORITHM;
  kid: string;
  publicKey?: AcpRemoteTicketCryptoKey | string;
  secret?: string | Uint8Array;
};

export type AcpRemoteTicketVerificationOptions = {
  connectionId?: string;
  daemonId?: string;
  now?: Date;
  policyVersion?: number;
  requiredScopes?: readonly AcpRemoteScope[];
};

export type CreateAcpRemoteConnectionTicketOptions = {
  connectionId: string;
  grant: AcpRemoteGrant;
  jti?: string;
  now?: Date;
  ttlMs?: number;
};

const DEFAULT_CONNECTION_TICKET_TTL_MS = 60 * 60 * 1000;

export const ACP_REMOTE_DEFAULT_TICKET_PUBLIC_KEYS = [
  {
    alg: ACP_REMOTE_TICKET_ALGORITHM,
    kid: "relay-production",
    publicKey: "HEvsutPKGSF_zpCHyoAOo-IehsIcm8reYtr5z7lbt-E",
  },
] as const satisfies readonly [
  AcpRemoteTicketVerificationKey,
  ...AcpRemoteTicketVerificationKey[],
];

export function createAcpRemoteConnectionTicket(
  options: CreateAcpRemoteConnectionTicketOptions,
): AcpRemoteConnectionTicket {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CONNECTION_TICKET_TTL_MS;
  return {
    ...options.grant,
    connectionId: options.connectionId,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    issuedAt: now.toISOString(),
    jti: options.jti ?? crypto.randomUUID(),
  };
}

export async function signAcpRemoteConnectionTicket(
  ticket: AcpRemoteConnectionTicket,
  key: AcpRemoteTicketSigningKey,
): Promise<AcpRemoteSignedConnectionTicket> {
  const alg = key.privateKey
    ? ACP_REMOTE_TICKET_ALGORITHM
    : (key.alg ?? ACP_REMOTE_LEGACY_TICKET_ALGORITHM);
  return {
    alg,
    kid: key.kid,
    payload: ticket,
    signature: await signTicketPayload(ticket, key),
  };
}

export async function createAcpRemoteSignedConnectionTicket(
  options: CreateAcpRemoteConnectionTicketOptions & {
    key: AcpRemoteTicketSigningKey;
  },
): Promise<AcpRemoteSignedConnectionTicket> {
  return signAcpRemoteConnectionTicket(
    createAcpRemoteConnectionTicket(options),
    options.key,
  );
}

export async function verifyAcpRemoteSignedConnectionTicket(
  ticket: AcpRemoteSignedConnectionTicket,
  keys:
    | AcpRemoteTicketVerificationKey
    | readonly AcpRemoteTicketVerificationKey[],
  options: AcpRemoteTicketVerificationOptions = {},
): Promise<AcpRemoteConnectionTicket> {
  if (
    ticket.alg !== ACP_REMOTE_TICKET_ALGORITHM &&
    ticket.alg !== ACP_REMOTE_LEGACY_TICKET_ALGORITHM
  ) {
    throw new Error(`Unsupported ACP remote ticket algorithm: ${ticket.alg}`);
  }

  const key = (Array.isArray(keys) ? keys : [keys]).find(
    (candidate) => candidate.kid === ticket.kid,
  );
  if (!key) {
    throw new Error(`Unknown ACP remote ticket key: ${ticket.kid}`);
  }

  const signatureValid = await verifyTicketPayload(ticket, key);
  if (!signatureValid) {
    throw new Error("Invalid ACP remote ticket signature.");
  }

  if (isConnectionTicketExpired(ticket.payload, options.now)) {
    throw new Error("ACP remote ticket expired.");
  }
  if (
    options.connectionId !== undefined &&
    ticket.payload.connectionId !== options.connectionId
  ) {
    throw new Error("ACP remote ticket connection mismatch.");
  }
  if (options.daemonId !== undefined && ticket.payload.daemonId !== options.daemonId) {
    throw new Error("ACP remote ticket host mismatch.");
  }
  if (
    options.policyVersion !== undefined &&
    ticket.payload.policyVersion !== options.policyVersion
  ) {
    throw new Error("ACP remote ticket policy version mismatch.");
  }
  if (options.requiredScopes?.length) {
    requireAcpRemoteScopes(ticket.payload, options.requiredScopes);
  }

  return ticket.payload;
}

function canonicalizeTicketPayload(ticket: AcpRemoteConnectionTicket): string {
  return stableStringify(ticket);
}

async function signTicketPayload(
  ticket: AcpRemoteConnectionTicket,
  key: AcpRemoteTicketSigningKey,
): Promise<string> {
  if (key.privateKey) {
    const cryptoKey =
      typeof key.privateKey === "string"
        ? await importEd25519PrivateKey(key.privateKey)
        : key.privateKey;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      cryptoKey,
      toArrayBuffer(
        new TextEncoder().encode(canonicalizeTicketPayload(ticket)),
      ),
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }
  if (!key.secret) {
    throw new Error("ACP remote ticket signing key is missing private material.");
  }
  const secretBytes =
    typeof key.secret === "string"
      ? new TextEncoder().encode(key.secret)
      : key.secret;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretBytes),
    {
      hash: "SHA-256",
      name: "HMAC",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(canonicalizeTicketPayload(ticket))),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyTicketPayload(
  ticket: AcpRemoteSignedConnectionTicket,
  key: AcpRemoteTicketVerificationKey,
): Promise<boolean> {
  if (ticket.alg === ACP_REMOTE_TICKET_ALGORITHM) {
    if (!key.publicKey) {
      return false;
    }
    const cryptoKey =
      typeof key.publicKey === "string"
        ? await importEd25519PublicKey(key.publicKey)
        : key.publicKey;
    return crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      toArrayBuffer(base64UrlToBytes(ticket.signature)),
      toArrayBuffer(
        new TextEncoder().encode(canonicalizeTicketPayload(ticket.payload)),
      ),
    );
  }

  if (!key.secret) {
    return false;
  }
  const expectedSignature = await signTicketPayload(ticket.payload, {
    alg: ACP_REMOTE_LEGACY_TICKET_ALGORITHM,
    kid: key.kid,
    secret: key.secret,
  });
  return constantTimeEqual(ticket.signature, expectedSignature);
}

async function importEd25519PrivateKey(
  privateKey: string,
): Promise<AcpRemoteTicketCryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64UrlToBytes(privateKey)),
    "Ed25519",
    false,
    ["sign"],
  );
}

async function importEd25519PublicKey(
  publicKey: string,
): Promise<AcpRemoteTicketCryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64UrlToBytes(publicKey)),
    "Ed25519",
    false,
    ["verify"],
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => (entry === undefined ? "null" : stableStringify(entry)))
      .join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
