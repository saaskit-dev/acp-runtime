import { describe, expect, it } from "vitest";

import { AcpPermissionDeniedError } from "../core/errors.js";
import type { AcpRuntimeSessionMetadata } from "../core/types.js";
import { createClaudeCodeAgentProfile } from "./profiles/claude-code.js";
import { createAgentProfile } from "./profiles/profile.js";
import {
  applyPermissionDecision,
  finalizePromptResponse,
  mapPermissionRequest,
  mapSessionUpdateToRuntimeEvents,
} from "./session-update-mapper.js";
import { createTurnState } from "./turn-state.js";

const profile = createAgentProfile({});

function createMetadata(): AcpRuntimeSessionMetadata {
  return {
    id: "session-1",
  };
}

describe("session update mapper permission evidence", () => {
  it("preserves request -> cancelled evidence on denied permissions", () => {
    const turn = createTurnState();
    const mapped = mapPermissionRequest({
      params: {
        options: [
          {
            kind: "reject_once",
            name: "Reject",
            optionId: "reject-1",
          },
        ],
        toolCall: {
          kind: "edit",
          rawInput: {
            path: "/tmp/file.txt",
          },
          status: "pending",
          title: "Write file",
          toolCallId: "tool-1",
        },
      } as never,
      profile,
      turn,
    });

    const resolvedOperation = applyPermissionDecision({
      decision: {
        decision: "deny",
      },
      operationId: mapped.operation.id,
      turn,
    });
    turn.deniedOperationIds.add(mapped.operation.id);

    expect(resolvedOperation.permission).toMatchObject({
      decision: "denied",
      requestId: mapped.request.id,
      requested: true,
    });

    const events = finalizePromptResponse({
      response: {
        stopReason: "cancelled",
      } as never,
      turn,
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      operation: {
        failureReason: "permission_denied",
        permission: {
          decision: "denied",
          family: "permission_request_cancelled",
          requestId: mapped.request.id,
          requested: true,
        },
        phase: "cancelled",
      },
      type: "operation_updated",
    });
    expect(events[1]?.type).toBe("failed");
    expect((events[1] as { error: unknown }).error).toBeInstanceOf(
      AcpPermissionDeniedError,
    );
  });

  it("marks failed tool updates after denial as permission_request_end_turn", () => {
    const turn = createTurnState();
    const mapped = mapPermissionRequest({
      params: {
        options: [
          {
            kind: "reject_once",
            name: "Reject",
            optionId: "reject-1",
          },
        ],
        toolCall: {
          kind: "edit",
          rawInput: {
            path: "/tmp/file.txt",
          },
          status: "pending",
          title: "Write file",
          toolCallId: "tool-1",
        },
      } as never,
      profile,
      turn,
    });
    applyPermissionDecision({
      decision: {
        decision: "deny",
      },
      operationId: mapped.operation.id,
      turn,
    });
    turn.deniedOperationIds.add(mapped.operation.id);

    const events = mapSessionUpdateToRuntimeEvents({
      diagnostics: {},
      metadata: createMetadata(),
      notification: {
        sessionId: "session-1",
        update: {
          content: [],
          sessionUpdate: "tool_call_update",
          status: "failed",
          title: "Write blocked",
          toolCallId: "tool-1",
        },
      } as never,
      profile,
      turn,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: {
        failureReason: "permission_denied",
        permission: {
          decision: "denied",
          family: "permission_request_end_turn",
          requestId: mapped.request.id,
          requested: true,
        },
        phase: "failed",
      },
      type: "operation_failed",
    });
    expect((events[0] as { error: unknown }).error).toBeInstanceOf(
      AcpPermissionDeniedError,
    );
  });

  it("classifies mode-denied failures without permission requests", () => {
    const turn = createTurnState();
    const initialEvents = mapSessionUpdateToRuntimeEvents({
      diagnostics: {},
      metadata: {
        ...createMetadata(),
        currentModeId: "dontAsk",
      },
      notification: {
        sessionId: "session-1",
        update: {
          locations: [
            {
              path: "/tmp/file.txt",
            },
          ],
          rawInput: {
            path: "/tmp/file.txt",
          },
          sessionUpdate: "tool_call",
          status: "pending",
          title: "Write file",
          toolCallId: "tool-1",
          kind: "edit",
        },
      } as never,
      profile: createClaudeCodeAgentProfile({
        command: "claude-agent-acp",
        type: "claude-acp",
      }),
      turn,
    });

    expect(initialEvents).toHaveLength(1);
    expect(initialEvents[0]?.type).toBe("operation_started");

    const failedEvents = mapSessionUpdateToRuntimeEvents({
      diagnostics: {},
      metadata: {
        ...createMetadata(),
        currentModeId: "dontAsk",
      },
      notification: {
        sessionId: "session-1",
        update: {
          content: [],
          sessionUpdate: "tool_call_update",
          status: "failed",
          title: "Write blocked by mode",
          toolCallId: "tool-1",
        },
      } as never,
      profile: createClaudeCodeAgentProfile({
        command: "claude-agent-acp",
        type: "claude-acp",
      }),
      turn,
    });

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      operation: {
        failureReason: "permission_denied",
        permission: {
          decision: "denied",
          family: "mode_denied",
          requested: false,
        },
        phase: "failed",
      },
      type: "operation_failed",
    });
    expect(turn.deniedOperationIds.size).toBe(1);

    const terminalEvents = finalizePromptResponse({
      response: {
        stopReason: "end_turn",
      } as never,
      turn,
    });

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe("failed");
    expect((terminalEvents[0] as { error: unknown }).error).toBeInstanceOf(
      AcpPermissionDeniedError,
    );
  });
});
