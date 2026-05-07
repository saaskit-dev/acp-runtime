import {
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
  type AcpRemoteFrame,
  type AcpRemoteScope,
} from "../protocol/types.js";
import {
  assertAcpRemoteFrame,
} from "../protocol/validation.js";

export function parseFrame(text: string): AcpRemoteFrame | undefined {
  try {
    return assertAcpRemoteFrame(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export const ACP_METHOD_SCOPE_BY_METHOD = {
  "session/close": "acp:session:resume",
  "session/set_config_option": "acp:session:resume",
  "session/set_mode": "acp:session:resume",
  "session/fork": "acp:session:resume",
  "session/list": "acp:session:list",
  "session/load": "acp:session:resume",
  "session/new": "acp:session:create",
  "session/prompt": "acp:turn:send",
  "session/resume": "acp:session:resume",
} as const satisfies Record<string, AcpRemoteScope>;

export const ACP_NOTIFICATION_SCOPE_BY_METHOD = {
  "session/cancel": "acp:turn:cancel",
} as const satisfies Record<string, AcpRemoteScope>;

export function requiredScopeForAcpPayload(payload: unknown): AcpRemoteScope | undefined {
  if (!isJsonRpcMessage(payload)) {
    return undefined;
  }
  if (isJsonRpcRequest(payload)) {
    return readScope(ACP_METHOD_SCOPE_BY_METHOD, payload.method);
  }
  return readScope(ACP_NOTIFICATION_SCOPE_BY_METHOD, payload.method);
}

export type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest;

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
};

export type JsonRpcRequest = JsonRpcNotification & {
  id: number | string | null;
};

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "method" in value &&
    typeof value.method === "string"
  );
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isJsonRpcMessage(value) &&
    "id" in value &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null)
  );
}

export function readScope<const T extends Record<string, AcpRemoteScope>>(
  scopes: T,
  method: string,
): AcpRemoteScope | undefined {
  return Object.hasOwn(scopes, method)
    ? scopes[method as keyof T]
    : undefined;
}

export type OutboundFrameTracker = {
  nextSeq(connectionId: string): number;
  pendingOutboundFrames: Map<string, Map<number, AcpRemoteDataFrame>>;
  trackOutbound(connectionId: string, frame: AcpRemoteDataFrame): void;
  handleAck(frame: AcpRemoteAckFrame): void;
  getPendingCount(connectionId: string): number;
};

export function createOutboundFrameTracker(): OutboundFrameTracker {
  const seqCounters = new Map<string, number>();
  const pendingOutboundFrames = new Map<string, Map<number, AcpRemoteDataFrame>>();

  return {
    pendingOutboundFrames,
    nextSeq(connectionId) {
      const seq = (seqCounters.get(connectionId) ?? 0) + 1;
      seqCounters.set(connectionId, seq);
      return seq;
    },
    trackOutbound(connectionId, frame) {
      let pending = pendingOutboundFrames.get(connectionId);
      if (!pending) {
        pending = new Map();
        pendingOutboundFrames.set(connectionId, pending);
      }
      pending.set(frame.seq, frame);
    },
    handleAck(frame) {
      const pending = pendingOutboundFrames.get(frame.connectionId);
      if (!pending) return;
      for (const seq of [...pending.keys()].sort((a, b) => a - b)) {
        if (seq > frame.ack) break;
        pending.delete(seq);
      }
    },
    getPendingCount(connectionId) {
      return pendingOutboundFrames.get(connectionId)?.size ?? 0;
    },
  };
}
