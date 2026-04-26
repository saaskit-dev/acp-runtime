import type {
  AuthenticateRequest,
  AuthenticateResponse,
  Client,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpRuntimeAgent } from "../core/types.js";
import type { AcpRuntimeObservabilityOptions } from "../core/types.js";

export type AcpConnection = {
  readonly closed: Promise<void>;
  readonly signal: AbortSignal;
  authenticate(
    params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void>;
  cancel(params: { sessionId: string }): Promise<void>;
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  listSessions?(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  setSessionConfigOption?(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;
  setSessionMode?(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void>;
  closeSession?(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse | void>;
  resumeSession?(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse>;
};

export type AcpConnectionHandle = {
  connection: AcpConnection;
  dispose?: (() => Promise<void> | void) | undefined;
};

export type AcpConnectionFactory = (input: {
  agent: AcpRuntimeAgent;
  client: Client;
  cwd: string;
  observability?: AcpRuntimeObservabilityOptions;
  traceContext?: import("@opentelemetry/api").Context;
}) => Promise<AcpConnectionHandle>;

export type AcpClientInfo = {
  name: string;
  version: string;
};

export type AcpOptions = {
  clientInfo?: AcpClientInfo;
};

export type AcpSessionResponse =
  | LoadSessionResponse
  | NewSessionResponse
  | ResumeSessionResponse;

export type AcpSessionBootstrap = {
  agent: import("../core/types.js").AcpRuntimeAgent;
  connection: AcpConnection;
  cwd: string;
  dispose?: (() => Promise<void> | void) | undefined;
  mcpServers: readonly import("../core/types.js").AcpRuntimeMcpServer[];
  response: AcpSessionResponse;
  sessionId: string;
};

export function mapMcpServersToAcp(
  servers: readonly import("../core/types.js").AcpRuntimeMcpServer[],
): McpServer[] {
  return servers.map<McpServer>((server) => {
    if (server.transport.type === "stdio") {
      return {
        command: server.transport.command,
        args: server.transport.args ?? [],
        cwd: server.transport.cwd,
        env: mapEnvRecordToAcp(server.transport.env) ?? [],
        name: server.name,
      } as McpServer;
    }

    return {
      headers: mapHeadersRecordToAcp(
        "headers" in server ? server.headers : undefined,
      ),
      name: server.name,
      type: server.transport.type,
      url: server.transport.url,
    } as McpServer;
  });
}

export function mapEnvRecordToAcp(
  env: Record<string, string | undefined> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (!env) {
    return undefined;
  }

  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: value as string }));

  return entries.length > 0 ? entries : undefined;
}

function mapHeadersRecordToAcp(
  headers: Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
  if (!headers) {
    return [];
  }

  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}
