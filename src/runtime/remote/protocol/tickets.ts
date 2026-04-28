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

export const ACP_REMOTE_TICKET_ALGORITHM = "HS256" as const;

export type AcpRemoteTicketSigningKey = {
  kid: string;
  secret: string | Uint8Array;
};

export type AcpRemoteTicketVerificationOptions = {
  connectionId?: string;
  hostId?: string;
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

const DEFAULT_CONNECTION_TICKET_TTL_MS = 5 * 60 * 1000;

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
  return {
    alg: ACP_REMOTE_TICKET_ALGORITHM,
    kid: key.kid,
    payload: ticket,
    signature: await signTicketPayload(ticket, key.secret),
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
  keys: AcpRemoteTicketSigningKey | readonly AcpRemoteTicketSigningKey[],
  options: AcpRemoteTicketVerificationOptions = {},
): Promise<AcpRemoteConnectionTicket> {
  if (ticket.alg !== ACP_REMOTE_TICKET_ALGORITHM) {
    throw new Error(`Unsupported ACP remote ticket algorithm: ${ticket.alg}`);
  }

  const key = (Array.isArray(keys) ? keys : [keys]).find(
    (candidate) => candidate.kid === ticket.kid,
  );
  if (!key) {
    throw new Error(`Unknown ACP remote ticket key: ${ticket.kid}`);
  }

  const expectedSignature = await signTicketPayload(ticket.payload, key.secret);
  if (!constantTimeEqual(ticket.signature, expectedSignature)) {
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
  if (options.hostId !== undefined && ticket.payload.hostId !== options.hostId) {
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
  secret: string | Uint8Array,
): Promise<string> {
  const secretBytes =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
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
