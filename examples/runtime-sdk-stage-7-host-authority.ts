import type {
  AcpRuntimeAuthenticationHandler,
  AcpRuntimeAuthenticationMethod,
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeFilesystemHandler,
  AcpRuntimePermissionHandler,
  AcpRuntimeTerminalAuthenticationRequest,
  AcpRuntimeTerminalHandler,
} from "@saaskit-dev/acp-runtime";
import { resolveRuntimeTerminalAuthenticationRequest } from "@saaskit-dev/acp-runtime";

import { createExampleHandlers } from "./runtime-sdk-example-helpers.js";

export function stage7AuthorityHandlersExample(): AcpRuntimeAuthorityHandlers {
  const baseHandlers = createExampleHandlers();

  const authentication: AcpRuntimeAuthenticationHandler = ({ methods }) => {
    const preferred = methods.find((method) => method.type === "terminal");
    return preferred ? { methodId: preferred.id } : { cancel: true };
  };

  const filesystem: AcpRuntimeFilesystemHandler = baseHandlers.filesystem!;
  const permission: AcpRuntimePermissionHandler = (request) => {
    if (request.kind === "filesystem") {
      return { decision: "allow", scope: "session" };
    }
    return { decision: "allow", scope: "once" };
  };
  const terminal: AcpRuntimeTerminalHandler = baseHandlers.terminal!;

  return {
    authentication,
    filesystem,
    permission,
    terminal,
  };
}

export function stage7ResolveTerminalAuthenticationExample(input: {
  agent: Parameters<NonNullable<AcpRuntimeAuthenticationHandler>>[0]["agent"];
  method: AcpRuntimeAuthenticationMethod;
}): AcpRuntimeTerminalAuthenticationRequest | undefined {
  return resolveRuntimeTerminalAuthenticationRequest(input);
}
