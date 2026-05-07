import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  type AcpRemoteConnectionTicket,
  type AcpRemoteFrame,
  type AcpRemoteScope,
} from "./types.js";

export function isAcpRemoteFrame(value: unknown): value is AcpRemoteFrame {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.frameType) {
    case AcpRemoteFrameType.Hello:
      return (
        value.protocolVersion === ACP_REMOTE_PROTOCOL_VERSION &&
        isString(value.connectionId) &&
        isEndpointKind(value.endpoint) &&
        optionalString(value.daemonId) &&
        optionalSignedTicket(value.ticket)
      );
    case AcpRemoteFrameType.Data:
      return (
        isString(value.connectionId) &&
        isString(value.channelId) &&
        isChannelKind(value.channelKind) &&
        Number.isSafeInteger(value.seq) &&
        (value.ack === undefined || Number.isSafeInteger(value.ack))
      );
    case AcpRemoteFrameType.Ack:
      return (
        isString(value.connectionId) &&
        isString(value.channelId) &&
        Number.isSafeInteger(value.ack)
      );
    case AcpRemoteFrameType.Ping:
    case AcpRemoteFrameType.Pong:
      return isString(value.connectionId) && isString(value.nonce);
    case AcpRemoteFrameType.Renew:
      return isString(value.connectionId) && isSignedTicket(value.ticket);
    case AcpRemoteFrameType.Close:
      return (
        isString(value.connectionId) &&
        optionalString(value.code) &&
        optionalString(value.reason)
      );

    default:
      return false;
  }
}

export function assertAcpRemoteFrame(value: unknown): AcpRemoteFrame {
  if (!isAcpRemoteFrame(value)) {
    throw new Error("Invalid ACP remote frame.");
  }
  return value;
}

export function isConnectionTicketExpired(
  ticket: Pick<AcpRemoteConnectionTicket, "expiresAt">,
  now: Date = new Date(),
): boolean {
  const expiresAt = Date.parse(ticket.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function hasAcpRemoteScope(
  ticket: Pick<AcpRemoteConnectionTicket, "scopes">,
  scope: AcpRemoteScope,
): boolean {
  return ticket.scopes.includes(scope);
}

export function requireAcpRemoteScopes(
  ticket: Pick<AcpRemoteConnectionTicket, "scopes">,
  scopes: readonly AcpRemoteScope[],
): void {
  const missing = scopes.filter((scope) => !hasAcpRemoteScope(ticket, scope));
  if (missing.length > 0) {
    throw new Error(`ACP remote ticket missing scopes: ${missing.join(", ")}`);
  }
}

function isEndpointKind(value: unknown): value is AcpRemoteEndpointKind {
  return value === AcpRemoteEndpointKind.Client || value === AcpRemoteEndpointKind.Daemon;
}

function isChannelKind(value: unknown): value is AcpRemoteChannelKind {
  return Object.values(AcpRemoteChannelKind).includes(
    value as AcpRemoteChannelKind,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalSignedTicket(value: unknown): boolean {
  return value === undefined || isSignedTicket(value);
}

function isSignedTicket(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.alg) &&
    isString(value.kid) &&
    isRecord(value.payload) &&
    isString(value.signature)
  );
}
