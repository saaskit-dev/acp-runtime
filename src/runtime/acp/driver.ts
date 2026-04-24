import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import { AcpProcessError, AcpProtocolError } from "../core/errors.js";
import type { AcpSessionDriver } from "../core/session-driver.js";
import {
  type AcpRuntimeDiagnostics,
  type AcpRuntimePrompt,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeSessionStatus,
  type AcpRuntimeSnapshot,
  type AcpRuntimeStreamOptions,
  type AcpRuntimeTurnEvent,
  type AcpRuntimeAuthorityHandlers,
} from "../core/types.js";
import { ACP_RUNTIME_SNAPSHOT_VERSION } from "../core/constants.js";
import type { AcpSessionBootstrap } from "./connection-types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import {
  createInitialMetadata,
  extractRuntimeConfig,
  mapInitializeResponseToCapabilities,
  mapSessionConfigOptions,
} from "./capability-mapper.js";
import type { AcpAgentProfile } from "./profiles/index.js";
import {
  applyPermissionDecision,
  finalizePromptResponse,
  mapPermissionDecisionToAcp,
  mapPermissionRequest,
  mapSessionUpdateToRuntimeEvents,
  mapUsage,
} from "./session-update-mapper.js";
import { mapPromptToAcp } from "./prompt-mapper.js";
import { createTurnState, type AcpRuntimeTurnState } from "./turn-state.js";

class AsyncEventQueue<T> {
  private closed = false;
  private pendingResolves: Array<(value: IteratorResult<T>) => void> = [];
  private values: T[] = [];

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.pendingResolves.length > 0) {
      const resolve = this.pendingResolves.shift();
      resolve?.({ done: true, value: undefined });
    }
  }

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolve = this.pendingResolves.shift();
    if (resolve) {
      resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return {
        done: false,
        value: this.values.shift() as T,
      };
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.pendingResolves.push(resolve);
    });
  }
}

type ActiveTurn = {
  queue: AsyncEventQueue<AcpRuntimeTurnEvent>;
  state: AcpRuntimeTurnState;
};

export class AcpSdkSessionDriver implements AcpSessionDriver {
  private currentTurn: ActiveTurn | undefined;
  private readonly diagnosticsValue: AcpRuntimeDiagnostics = {};
  private readonly metadataValue: AcpRuntimeSessionMetadata;
  private statusValue: AcpRuntimeSessionStatus = "ready";

  readonly capabilities;

  constructor(
    private readonly bridge: AcpClientBridge,
    private readonly bootstrap: AcpSessionBootstrap & {
      handlers?: AcpRuntimeAuthorityHandlers;
      initializeResponse: import("@agentclientprotocol/sdk").InitializeResponse;
      profile: AcpAgentProfile;
    },
  ) {
    this.capabilities = mapInitializeResponseToCapabilities({
      handlers: bootstrap.handlers,
      response: bootstrap.initializeResponse,
    });
    this.metadataValue = createInitialMetadata({
      configOptions: bootstrap.response.configOptions,
      modes: bootstrap.response.modes,
      sessionId: bootstrap.sessionId,
    });
    this.bridge.setPermissionHandler((params) =>
      this.handlePermissionRequest(params),
    );
    this.bridge.setSessionUpdateHandler((params) =>
      this.handleSessionUpdate(params),
    );
  }

  get diagnostics(): Readonly<AcpRuntimeDiagnostics> {
    return this.diagnosticsValue;
  }

  get metadata(): Readonly<AcpRuntimeSessionMetadata> {
    return this.metadataValue;
  }

  get status(): AcpRuntimeSessionStatus {
    return this.statusValue;
  }

  listAgentConfigOptions() {
    return this.metadataValue.agentConfigOptions ?? [];
  }

  listAgentModes() {
    return this.metadataValue.agentModes ?? [];
  }

  async cancel(): Promise<void> {
    await this.bootstrap.connection.cancel({
      sessionId: this.bootstrap.sessionId,
    });
  }

  async close(): Promise<void> {
    if (this.statusValue === "closed") {
      return;
    }

    this.statusValue = "closed";
    this.currentTurn?.queue.close();
    if (this.bootstrap.connection.unstable_closeSession) {
      await Promise.race([
        this.bootstrap.connection
          .unstable_closeSession({
            sessionId: this.bootstrap.sessionId,
          })
          .catch(() => {}),
        waitFor(1_000),
      ]);
    }
    await this.bootstrap.dispose?.();
  }

  async setAgentConfigOption(
    id: string,
    value: string,
  ): Promise<void> {
    if (!this.bootstrap.connection.setSessionConfigOption) {
      throw new AcpProtocolError(
        "ACP agent does not support session config option updates.",
      );
    }

    await this.bootstrap.connection.setSessionConfigOption({
      configId: id,
      sessionId: this.bootstrap.sessionId,
      value,
    });
    this.updateConfigOptionValue(id, value);
  }

  async setAgentMode(modeId: string): Promise<void> {
    if (!this.bootstrap.connection.setSessionMode) {
      throw new AcpProtocolError("ACP agent does not support session mode updates.");
    }

    await this.bootstrap.connection.setSessionMode({
      modeId,
      sessionId: this.bootstrap.sessionId,
    });
    this.metadataValue.currentModeId = modeId;
  }

  snapshot(): AcpRuntimeSnapshot {
    return {
      agent: this.bootstrap.agent,
      config: this.metadataValue.config,
      currentModeId: this.metadataValue.currentModeId,
      cwd: this.bootstrap.cwd,
      mcpServers: [...this.bootstrap.mcpServers],
      session: {
        id: this.bootstrap.sessionId,
      },
      version: ACP_RUNTIME_SNAPSHOT_VERSION,
    };
  }

  async *stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    if (this.statusValue === "closed") {
      throw new AcpProcessError("Session is closed.");
    }
    if (this.currentTurn) {
      throw new AcpProtocolError("Session already has an active turn.");
    }

    const activeTurn: ActiveTurn = {
      queue: new AsyncEventQueue<AcpRuntimeTurnEvent>(),
      state: createTurnState(),
    };
    this.currentTurn = activeTurn;
    this.statusValue = "running";

    const cleanupAbort = this.installAbortHandlers(activeTurn, options);
    activeTurn.queue.push({
      turnId: activeTurn.state.turnId,
      type: "started",
    });

    void this.startPrompt(activeTurn, prompt);

    try {
      while (true) {
        const next = await activeTurn.queue.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      cleanupAbort();
      this.currentTurn = undefined;
      this.restoreReadyStatus();
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (!this.currentTurn) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    const mapped = mapPermissionRequest({
      params,
      profile: this.bootstrap.profile,
      turn: this.currentTurn.state,
    });
    this.currentTurn.queue.push({
      operation: mapped.operation,
      turnId: this.currentTurn.state.turnId,
      type: "operation_updated",
    });
    this.currentTurn.queue.push({
      operation: mapped.operation,
      request: mapped.request,
      turnId: this.currentTurn.state.turnId,
      type: "permission_requested",
    });

    const decision = await this.resolvePermissionDecision(mapped.request);
    mapped.request.phase = decision.decision === "allow" ? "allowed" : "denied";
    if (decision.decision === "deny") {
      this.currentTurn.state.deniedOperationIds.add(mapped.operation.id);
    }
    const resolvedOperation = applyPermissionDecision({
      decision,
      operationId: mapped.operation.id,
      turn: this.currentTurn.state,
    });

    this.currentTurn.queue.push({
      decision: decision.decision === "allow" ? "allowed" : "denied",
      operation: resolvedOperation,
      request: mapped.request,
      turnId: this.currentTurn.state.turnId,
      type: "permission_resolved",
    });

    return mapPermissionDecisionToAcp(params.options, decision);
  }

  private async handleSessionUpdate(
    params: SessionNotification,
  ): Promise<void> {
    if (params.sessionId !== this.bootstrap.sessionId) {
      return;
    }

    if (!this.currentTurn) {
      if (params.update.sessionUpdate === "session_info_update") {
        if (params.update.title !== undefined) {
          this.metadataValue.title = params.update.title ?? undefined;
        }
      } else if (params.update.sessionUpdate === "available_commands_update") {
        this.metadataValue.availableCommands =
          params.update.availableCommands.map((command) => ({
            description: command.description,
            name: command.name,
          }));
      } else if (params.update.sessionUpdate === "current_mode_update") {
        this.metadataValue.currentModeId = params.update.currentModeId;
      } else if (params.update.sessionUpdate === "config_option_update") {
        this.metadataValue.agentConfigOptions = mapSessionConfigOptions(
          params.update.configOptions,
        );
        this.metadataValue.config = extractRuntimeConfig(
          params.update.configOptions,
        );
      } else if (params.update.sessionUpdate === "usage_update") {
        this.diagnosticsValue.lastUsage = {
          costUsd:
            params.update.cost?.currency === "USD"
              ? params.update.cost.amount
              : undefined,
          totalTokens: params.update.used,
        };
      }
      return;
    }

    const events = mapSessionUpdateToRuntimeEvents({
      diagnostics: this.diagnosticsValue,
      metadata: this.metadataValue,
      notification: params,
      profile: this.bootstrap.profile,
      turn: this.currentTurn.state,
    });
    for (const event of events) {
      this.currentTurn.queue.push(event);
    }
  }

  private installAbortHandlers(
    activeTurn: ActiveTurn,
    options: AcpRuntimeStreamOptions | undefined,
  ): () => void {
    const onAbort = () => {
      void this.cancel();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = options?.timeoutMs
      ? setTimeout(() => {
          activeTurn.state.timedOut = true;
          void this.cancel();
        }, options.timeoutMs)
      : undefined;

    return () => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }

  private async startPrompt(
    activeTurn: ActiveTurn,
    prompt: AcpRuntimePrompt,
  ): Promise<void> {
    let response: PromptResponse;
    try {
      response = await this.bootstrap.connection.prompt({
        prompt: mapPromptToAcp(prompt),
        sessionId: this.bootstrap.sessionId,
      });
    } catch (error) {
      this.diagnosticsValue.lastError = {
        code: "PROCESS_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
      activeTurn.queue.push({
        error: new AcpProcessError("ACP prompt request failed.", error),
        turnId: activeTurn.state.turnId,
        type: "failed",
      });
      activeTurn.queue.close();
      return;
    }

    const usage = mapUsage(response.usage ?? undefined);
    if (usage) {
      this.diagnosticsValue.lastUsage = usage;
    }

    for (const event of finalizePromptResponse({
      response,
      turn: activeTurn.state,
    })) {
      activeTurn.queue.push(event);
    }
    activeTurn.queue.close();
  }

  private async resolvePermissionDecision(
    request: import("../core/types.js").AcpRuntimePermissionRequest,
  ): Promise<import("../core/types.js").AcpRuntimePermissionDecision> {
    if (this.bootstrap.handlers?.permission) {
      return this.bootstrap.handlers.permission(request);
    }
    return {
      decision: "deny",
    };
  }

  private updateConfigOptionValue(
    id: string,
    value: string,
  ): void {
    this.metadataValue.config = {
      ...(this.metadataValue.config ?? {}),
      [id]: value,
    };
    this.metadataValue.agentConfigOptions = (
      this.metadataValue.agentConfigOptions ?? []
    ).map((option) =>
      option.id === id
        ? {
            ...option,
            value,
          }
        : option,
    );
  }

  private restoreReadyStatus(): void {
    if (this.statusValue !== "closed") {
      this.statusValue = "ready";
    }
  }
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
