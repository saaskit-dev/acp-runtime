declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare interface WebSocket {
  accept(): void;
}

declare interface DurableObjectId {}

declare interface DurableObjectNamespace {
  get(id: DurableObjectId): DurableObjectStub;
  idFromName(name: string): DurableObjectId;
}

declare interface DurableObjectState {
  storage: DurableObjectStorage;
}

declare interface DurableObjectStorage {
  setAlarm(scheduledTime: Date | number): Promise<void>;
}

declare interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

type D1Value = ArrayBuffer | null | number | string | Uint8Array;

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

declare interface D1PreparedStatement {
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
  }>;
  bind(...values: readonly D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{
    success: boolean;
  }>;
}
