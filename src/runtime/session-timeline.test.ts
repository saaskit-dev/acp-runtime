import { describe, expect, it } from "vitest";

import { AcpProtocolError } from "./core/errors.js";
import { AcpRuntimeSessionTimeline } from "./core/session-timeline.js";

describe("AcpRuntimeSessionTimeline", () => {
  it("records prompt/history entries and drains sealed history replay", () => {
    const timeline = new AcpRuntimeSessionTimeline();

    timeline.appendHistoryUser("loaded user");
    timeline.appendPrompt("live prompt", "turn-live");
    timeline.sealHistoryReplay();
    timeline.appendAssistantText("turn-live", "hello");
    timeline.appendTimelineEntry({
      text: "hello",
      turnId: "turn-live",
      type: "text",
    });

    expect(timeline.drainHistoryEntries()).toEqual([
      { text: "loaded user", type: "user" },
    ]);
    expect(timeline.drainHistoryEntries()).toEqual([]);
    expect(timeline.entries).toEqual([
      {
        id: "user-1",
        kind: "user_message",
        text: "loaded user",
      },
      {
        id: "user-2",
        kind: "user_message",
        text: "live prompt",
        turnId: "turn-live",
      },
      {
        id: "assistant-3",
        kind: "assistant_message",
        output: undefined,
        status: "streaming",
        text: "hello",
        turnId: "turn-live",
      },
    ]);
  });

  it("tracks tool call entries with diff and terminal content", () => {
    const timeline = new AcpRuntimeSessionTimeline();
    const updates: string[] = [];

    const stopWatching = timeline.watch((update) => {
      switch (update.type) {
        case "thread_entry_added":
        case "thread_entry_updated":
          updates.push(`${update.type}:${update.entry.kind}`);
          break;
        case "diff_updated":
          updates.push(`${update.type}:${update.diff.path}`);
          break;
        case "terminal_updated":
          updates.push(`${update.type}:${update.terminal.terminalId}`);
          break;
      }
    });

    timeline.upsertToolCall({
      content: [
        {
          changeType: "update",
          id: "diff-1",
          kind: "diff",
          newText: "new",
          oldText: "old",
          path: "/tmp/file.txt",
        },
        {
          command: "npm test",
          cwd: "/tmp",
          exitCode: 0,
          id: "terminal-1",
          kind: "terminal",
          output: "ok",
          status: "completed",
          terminalId: "term-1",
          truncated: false,
        },
      ],
      locations: [
        {
          line: 7,
          path: "/tmp/file.txt",
        },
      ],
      rawInput: { path: "/tmp/file.txt" },
      status: "in_progress",
      title: "Write file",
      toolCallId: "tool-1",
      toolKind: "edit",
      turnId: "turn-1",
    });

    timeline.upsertToolCall({
      rawOutput: { ok: true },
      status: "completed",
      toolCallId: "tool-1",
      turnId: "turn-1",
    });
    stopWatching();

    expect(timeline.entries).toEqual([
      {
        content: [
          {
            changeType: "update",
            id: "diff-1",
            kind: "diff",
            newText: "new",
            oldText: "old",
            path: "/tmp/file.txt",
          },
          {
            command: "npm test",
            cwd: "/tmp",
            exitCode: 0,
            id: "terminal-1",
            kind: "terminal",
            output: "ok",
            status: "completed",
            terminalId: "term-1",
            truncated: false,
          },
        ],
        id: "tool-call-1",
        kind: "tool_call",
        locations: [
          {
            line: 7,
            path: "/tmp/file.txt",
          },
        ],
        rawInput: { path: "/tmp/file.txt" },
        rawOutput: { ok: true },
        status: "completed",
        title: "Write file",
        toolCallId: "tool-1",
        toolKind: "edit",
        turnId: "turn-1",
      },
    ]);

    expect(timeline.diffs).toEqual([
      expect.objectContaining({
        changeType: "update",
        newLineCount: 1,
        newText: "new",
        oldLineCount: 1,
        oldText: "old",
        path: "/tmp/file.txt",
        revision: 1,
        toolCallId: "tool-1",
      }),
    ]);
    expect(timeline.terminals).toEqual([
      expect.objectContaining({
        command: "npm test",
        cwd: "/tmp",
        exitCode: 0,
        outputLength: 2,
        outputLineCount: 1,
        output: "ok",
        revision: 1,
        status: "completed",
        terminalId: "term-1",
        toolCallId: "tool-1",
        truncated: false,
      }),
    ]);
    expect(timeline.diff("/tmp/file.txt")).toEqual(
      expect.objectContaining({
        path: "/tmp/file.txt",
        revision: 1,
        toolCallId: "tool-1",
      }),
    );
    expect(timeline.terminal("term-1")).toEqual(
      expect.objectContaining({
        terminalId: "term-1",
        revision: 1,
        toolCallId: "tool-1",
      }),
    );
    expect(updates).toEqual([
      "diff_updated:/tmp/file.txt",
      "terminal_updated:term-1",
      "thread_entry_added:tool_call",
      "thread_entry_updated:tool_call",
    ]);
  });

  it("keeps terminal and diff lifecycle metadata across repeated updates", () => {
    const timeline = new AcpRuntimeSessionTimeline();
    const diffUpdates: string[] = [];
    const terminalUpdates: string[] = [];
    const toolObjectUpdates: string[] = [];
    const toolCallUpdates: string[] = [];

    const stopDiff = timeline.watchDiff("/tmp/notes.md", (diff) => {
      diffUpdates.push(`${diff.path}:${diff.revision}`);
    });
    const stopTerminal = timeline.watchTerminal("term-1", (terminal) => {
      terminalUpdates.push(`${terminal.terminalId}:${terminal.revision}:${terminal.status}`);
    });
    const stopToolObjects = timeline.watchToolCallObjects("tool-1", (update) => {
      if (update.type === "diff_updated") {
        toolObjectUpdates.push(`diff:${update.diff.path}:${update.diff.revision}`);
      } else {
        toolObjectUpdates.push(
          `terminal:${update.terminal.terminalId}:${update.terminal.revision}`,
        );
      }
    });
    const stopToolCall = timeline.watchToolCall("tool-1", (bundle) => {
      toolCallUpdates.push(
        `${bundle.toolCall.toolCallId}:${bundle.diffs.length}:${bundle.terminals.length}:${bundle.toolCall.status}`,
      );
    });

    timeline.upsertToolCall({
      content: [
        {
          id: "diff-1",
          kind: "diff",
          changeType: "write",
          newText: "hello",
          path: "/tmp/notes.md",
        },
        {
          id: "terminal-1",
          kind: "terminal",
          terminalId: "term-1",
          status: "running",
          command: "npm test",
          cwd: "/tmp/project",
          output: "running",
        },
      ],
      toolCallId: "tool-1",
      turnId: "turn-1",
    });

    const firstDiff = timeline.diff("/tmp/notes.md");
    const firstTerminal = timeline.terminal("term-1");

    timeline.upsertToolCall({
      content: [
        {
          id: "diff-1",
          kind: "diff",
          changeType: "update",
          newText: "hello world",
          oldText: "hello",
          path: "/tmp/notes.md",
        },
        {
          id: "terminal-1",
          kind: "terminal",
          terminalId: "term-1",
          status: "completed",
          exitCode: 0,
          output: "done",
        },
      ],
      toolCallId: "tool-1",
      turnId: "turn-1",
    });
    stopDiff();
    stopTerminal();
    stopToolObjects();
    stopToolCall();

    const secondDiff = timeline.diff("/tmp/notes.md");
    const secondTerminal = timeline.terminal("term-1");

    expect(firstDiff).toEqual(
      expect.objectContaining({
        path: "/tmp/notes.md",
        revision: 1,
      }),
    );
    expect(secondDiff).toEqual(
      expect.objectContaining({
        changeType: "update",
        newLineCount: 1,
        newText: "hello world",
        oldLineCount: 1,
        oldText: "hello",
        path: "/tmp/notes.md",
        revision: 2,
        toolCallId: "tool-1",
      }),
    );
    expect(secondDiff?.createdAt).toBe(firstDiff?.createdAt);
    expect(secondDiff?.revision).toBeGreaterThan(firstDiff?.revision ?? 0);

    expect(firstTerminal).toEqual(
      expect.objectContaining({
        terminalId: "term-1",
        status: "running",
        revision: 1,
      }),
    );
    expect(secondTerminal).toEqual(
      expect.objectContaining({
        terminalId: "term-1",
        status: "completed",
        command: "npm test",
        cwd: "/tmp/project",
        output: "done",
        outputLength: 4,
        outputLineCount: 1,
        exitCode: 0,
        revision: 2,
        toolCallId: "tool-1",
      }),
    );
    expect(secondTerminal?.createdAt).toBe(firstTerminal?.createdAt);
    expect(secondTerminal?.revision).toBeGreaterThan(firstTerminal?.revision ?? 0);
    expect(secondTerminal?.completedAt).toBeDefined();
    expect(timeline.diffPaths()).toEqual(["/tmp/notes.md"]);
    expect(timeline.terminalIds()).toEqual(["term-1"]);
    expect(timeline.toolCallIds()).toEqual(["tool-1"]);
    expect(timeline.getToolCall("tool-1")).toEqual(
      expect.objectContaining({
        toolCallId: "tool-1",
        status: "pending",
      }),
    );
    expect(timeline.toolCalls()).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        status: "pending",
      }),
    ]);
    expect(timeline.toolCallBundle("tool-1")).toEqual({
      diffs: [
        expect.objectContaining({
          path: "/tmp/notes.md",
          toolCallId: "tool-1",
        }),
      ],
      terminals: [
        expect.objectContaining({
          terminalId: "term-1",
          toolCallId: "tool-1",
        }),
      ],
      toolCall: expect.objectContaining({
        toolCallId: "tool-1",
        status: "pending",
      }),
    });
    expect(timeline.toolCallBundles()).toEqual([
      {
        diffs: [
          expect.objectContaining({
            path: "/tmp/notes.md",
            toolCallId: "tool-1",
          }),
        ],
        terminals: [
          expect.objectContaining({
            terminalId: "term-1",
            toolCallId: "tool-1",
          }),
        ],
        toolCall: expect.objectContaining({
          toolCallId: "tool-1",
          status: "pending",
        }),
      },
    ]);
    expect(timeline.toolCallDiffs("tool-1")).toEqual([
      expect.objectContaining({
        path: "/tmp/notes.md",
        toolCallId: "tool-1",
      }),
    ]);
    expect(timeline.toolCallTerminals("tool-1")).toEqual([
      expect.objectContaining({
        terminalId: "term-1",
        toolCallId: "tool-1",
      }),
    ]);
    expect(diffUpdates).toEqual([
      "/tmp/notes.md:1",
      "/tmp/notes.md:2",
    ]);
    expect(terminalUpdates).toEqual([
      "term-1:1:running",
      "term-1:2:completed",
    ]);
    expect(toolObjectUpdates).toEqual([
      "diff:/tmp/notes.md:1",
      "terminal:term-1:1",
      "diff:/tmp/notes.md:2",
      "terminal:term-1:2",
    ]);
    expect(toolCallUpdates).toEqual([
      "tool-1:1:0:pending",
      "tool-1:1:1:pending",
      "tool-1:1:1:pending",
      "tool-1:1:1:pending",
      "tool-1:1:1:pending",
      "tool-1:1:1:pending",
    ]);
  });

  it("tracks operation, permission, metadata, and usage projection state", () => {
    const timeline = new AcpRuntimeSessionTimeline();
    const updates: string[] = [];
    const operationUpdates: string[] = [];
    const permissionUpdates: string[] = [];
    const bundleUpdates: string[] = [];

    const stopWatching = timeline.watchProjection((update) => {
      switch (update.type) {
        case "metadata_projection_updated":
          updates.push(`metadata:${update.metadata.id}`);
          break;
        case "usage_projection_updated":
          updates.push(`usage:${update.usage.totalTokens ?? 0}`);
          break;
        case "operation_projection_updated":
          updates.push(
            `operation:${update.operation.id}:${update.lifecycle}:${update.operation.phase}`,
          );
          break;
        case "permission_projection_updated":
          updates.push(
            `permission:${update.request.id}:${update.lifecycle}:${update.request.phase}:${update.decision ?? "pending"}`,
          );
          break;
      }
    });
    const stopWatchingOperation = timeline.watchOperation("op-1", (operation) => {
      operationUpdates.push(`${operation.id}:${operation.phase}`);
    });
    const stopWatchingPermission = timeline.watchPermissionRequest(
      "perm-1",
      (request) => {
        permissionUpdates.push(`${request.id}:${request.phase}`);
      },
    );
    const stopWatchingBundle = timeline.watchOperationBundle(
      "op-1",
      (bundle) => {
        bundleUpdates.push(
          `${bundle.operation.id}:${bundle.operation.phase}:${bundle.permissionRequests.length}`,
        );
      },
    );

    timeline.appendTimelineEntry({
      metadata: {
        currentModeId: "default",
        id: "session-1",
        title: "Session 1",
      },
      turnId: "turn-1",
      type: "metadata_updated",
    });
    timeline.appendTimelineEntry({
      turnId: "turn-1",
      type: "usage_updated",
      usage: {
        totalTokens: 42,
      },
    });
    timeline.appendTimelineEntry({
      operation: {
        id: "op-1",
        kind: "read_file",
        phase: "running",
        title: "Read notes.md",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      type: "operation_started",
    });
    timeline.appendTimelineEntry({
      operation: {
        id: "op-1",
        kind: "read_file",
        phase: "awaiting_permission",
        permission: {
          requestId: "perm-1",
          requested: true,
        },
        title: "Read notes.md",
        turnId: "turn-1",
      },
      request: {
        id: "perm-1",
        kind: "filesystem",
        operationId: "op-1",
        phase: "pending",
        scopeOptions: ["once", "session"],
        title: "Read notes.md",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      type: "permission_requested",
    });
    timeline.appendTimelineEntry({
      decision: "allowed",
      operation: {
        id: "op-1",
        kind: "read_file",
        phase: "running",
        permission: {
          decision: "allowed",
          requestId: "perm-1",
          requested: true,
        },
        title: "Read notes.md",
        turnId: "turn-1",
      },
      request: {
        id: "perm-1",
        kind: "filesystem",
        operationId: "op-1",
        phase: "allowed",
        scopeOptions: ["once", "session"],
        title: "Read notes.md",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      type: "permission_resolved",
    });
    timeline.appendTimelineEntry({
      operation: {
        id: "op-1",
        kind: "read_file",
        phase: "failed",
        title: "Read notes.md",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      type: "operation_failed",
      error: new AcpProtocolError("permission denied"),
    });
    stopWatching();
    stopWatchingOperation();
    stopWatchingPermission();
    stopWatchingBundle();

    expect(timeline.operationIds()).toEqual(["op-1"]);
    expect(timeline.operation("op-1")).toEqual(
      expect.objectContaining({
        id: "op-1",
        kind: "read_file",
        phase: "failed",
        turnId: "turn-1",
      }),
    );
    expect(timeline.operations).toEqual([
      expect.objectContaining({
        id: "op-1",
        phase: "failed",
      }),
    ]);
    expect(timeline.operationPermissionRequests("op-1")).toEqual([
      expect.objectContaining({
        id: "perm-1",
        operationId: "op-1",
        phase: "allowed",
      }),
    ]);
    expect(timeline.operationBundle("op-1")).toEqual({
      operation: expect.objectContaining({
        id: "op-1",
        phase: "failed",
      }),
      permissionRequests: [
        expect.objectContaining({
          id: "perm-1",
          operationId: "op-1",
          phase: "allowed",
        }),
      ],
    });
    expect(timeline.operationBundles()).toEqual([
      {
        operation: expect.objectContaining({
          id: "op-1",
          phase: "failed",
        }),
        permissionRequests: [
          expect.objectContaining({
            id: "perm-1",
            operationId: "op-1",
            phase: "allowed",
          }),
        ],
      },
    ]);
    expect(timeline.permissionRequestIds()).toEqual(["perm-1"]);
    expect(timeline.permissionRequest("perm-1")).toEqual(
      expect.objectContaining({
        id: "perm-1",
        operationId: "op-1",
        phase: "allowed",
      }),
    );
    expect(timeline.permissionRequests).toEqual([
      expect.objectContaining({
        id: "perm-1",
        phase: "allowed",
      }),
    ]);
    expect(timeline.projectionMetadata).toEqual({
      currentModeId: "default",
      id: "session-1",
      title: "Session 1",
    });
    expect(timeline.projectionUsage).toEqual({
      totalTokens: 42,
    });
    expect(updates).toEqual([
      "metadata:session-1",
      "usage:42",
      "operation:op-1:started:running",
      "permission:perm-1:requested:pending:pending",
      "permission:perm-1:resolved:allowed:allowed",
      "operation:op-1:failed:failed",
    ]);
    expect(operationUpdates).toEqual([
      "op-1:running",
      "op-1:failed",
    ]);
    expect(permissionUpdates).toEqual([
      "perm-1:pending",
      "perm-1:allowed",
    ]);
    expect(bundleUpdates).toEqual([
      "op-1:running:0",
      "op-1:awaiting_permission:1",
      "op-1:running:1",
      "op-1:failed:1",
    ]);
  });
});
