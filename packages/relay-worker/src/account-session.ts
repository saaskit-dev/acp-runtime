export type AcpRelayAccountSession = {
  accountId: string;
  clientId?: string;
  expiresAt: string;
  sessionId: string;
};

export type AcpRelayAccountSessionVerificationResult =
  | {
      ok: true;
      session: AcpRelayAccountSession;
    }
  | {
      ok: false;
      reason: string;
    };

const ACCOUNT_SESSION_TOKEN_VERSION = "v1";

export async function createAcpRelayAccountSessionToken(input: {
  secret: string;
  session: AcpRelayAccountSession;
}): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(stableStringify(input.session)),
  );
  return [
    ACCOUNT_SESSION_TOKEN_VERSION,
    payload,
    await signAccountSessionPayload(payload, input.secret),
  ].join(".");
}

export async function verifyAcpRelayAccountSessionToken(input: {
  now?: Date;
  secret: string;
  token: string;
}): Promise<AcpRelayAccountSessionVerificationResult> {
  const [version, payload, signature, extra] = input.token.split(".");
  if (
    version !== ACCOUNT_SESSION_TOKEN_VERSION ||
    !payload ||
    !signature ||
    extra !== undefined
  ) {
    return { ok: false, reason: "Invalid ACP relay account session token." };
  }

  const expectedSignature = await signAccountSessionPayload(
    payload,
    input.secret,
  );
  if (!constantTimeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "Invalid ACP relay account session signature." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload)),
    ) as unknown;
  } catch {
    return { ok: false, reason: "Invalid ACP relay account session payload." };
  }

  if (!isAccountSession(parsed)) {
    return { ok: false, reason: "Invalid ACP relay account session payload." };
  }

  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? new Date()).getTime()) {
    return { ok: false, reason: "ACP relay account session expired." };
  }

  return {
    ok: true,
    session: parsed,
  };
}

function isAccountSession(value: unknown): value is AcpRelayAccountSession {
  return (
    isRecord(value) &&
    isNonEmptyString(value.accountId) &&
    isNonEmptyString(value.expiresAt) &&
    isNonEmptyString(value.sessionId) &&
    (value.clientId === undefined ||
      isNonEmptyString(value.clientId))
  );
}

async function signAccountSessionPayload(
  payload: string,
  secret: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
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
    toArrayBuffer(new TextEncoder().encode(payload)),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
