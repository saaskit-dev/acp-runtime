import type { AcpWebSocketLike } from "../protocol/websocket-stream.js";

export type AcpRemoteSocketFactory = (input: {
  headers: Record<string, string>;
  url: string;
}) => AcpWebSocketLike;

export type AcpRemoteWebSocketConstructor = new (
  url: string,
  protocols?: readonly string[] | string,
  options?: {
    headers?: Record<string, string>;
  },
) => AcpWebSocketLike;

export function createAcpRemoteWebSocketFactory(
  WebSocketConstructor: AcpRemoteWebSocketConstructor,
): AcpRemoteSocketFactory {
  return ({ headers, url }) =>
    new WebSocketConstructor(url, undefined, {
      headers,
    });
}
