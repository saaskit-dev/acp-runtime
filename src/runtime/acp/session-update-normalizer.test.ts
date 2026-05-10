import { describe, expect, it } from "vitest";

import { normalizeSessionNotification } from "./session-update-normalizer.js";

describe("normalizeSessionNotification", () => {
  it("filters invalid vector entries and keeps valid protocol entries", () => {
    const normalized = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        entries: [
          {
            content: "Inspect logs",
            priority: "high",
            status: "pending",
          },
          {
            content: "Bad status",
            priority: "medium",
            status: "unknown",
          },
          null,
        ],
        sessionUpdate: "plan",
      },
    } as never);

    expect(normalized?.update).toEqual({
      entries: [
        {
          content: "Inspect logs",
          priority: "high",
          status: "pending",
        },
      ],
      sessionUpdate: "plan",
    });
  });

  it("defaults malformed vector fields to empty arrays", () => {
    const normalized = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        availableCommands: "bad",
        sessionUpdate: "available_commands_update",
      },
    } as never);

    expect(normalized?.update).toEqual({
      availableCommands: [],
      sessionUpdate: "available_commands_update",
    });
  });

  it("normalizes config options and skips invalid choices", () => {
    const normalized = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        configOptions: [
          {
            currentValue: "gpt-5.5",
            id: "model",
            name: "Model",
            options: [
              {
                name: "GPT-5.5",
                value: "gpt-5.5",
              },
              {
                name: "missing value",
              },
              {
                group: "legacy",
                name: "Legacy",
                options: [
                  {
                    name: "GPT-4",
                    value: "gpt-4",
                  },
                  {
                    value: "bad",
                  },
                ],
              },
            ],
            type: "select",
          },
          {
            currentValue: "yes",
            id: "bad-boolean",
            name: "Bad Boolean",
            type: "boolean",
          },
        ],
        sessionUpdate: "config_option_update",
      },
    } as never);

    expect(normalized?.update).toEqual({
      configOptions: [
        {
          currentValue: "gpt-5.5",
          id: "model",
          name: "Model",
          options: [
            {
              description: undefined,
              name: "GPT-5.5",
              value: "gpt-5.5",
            },
            {
              group: "legacy",
              name: "Legacy",
              options: [
                {
                  description: undefined,
                  name: "GPT-4",
                  value: "gpt-4",
                },
              ],
            },
          ],
          type: "select",
        },
      ],
      sessionUpdate: "config_option_update",
    });
  });

  it("preserves session info three-state fields and drops invalid values", () => {
    const normalized = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: null,
        updatedAt: 42,
      },
    } as never);

    expect(normalized?.update).toEqual({
      sessionUpdate: "session_info_update",
      title: null,
    });
  });

  it("normalizes usage nulls and invalid cost values", () => {
    const normalized = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        cost: {
          amount: "0.01",
          currency: "USD",
        },
        sessionUpdate: "usage_update",
        size: 128000,
        used: null,
      },
    } as never);

    expect(normalized?.update).toEqual({
      cost: undefined,
      sessionUpdate: "usage_update",
      size: 128000,
      used: 0,
    });
  });

  it("normalizes tool calls without clobbering omitted update fields", () => {
    const created = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        content: [
          {
            content: {
              text: "done",
              type: "text",
            },
            type: "content",
          },
          {
            type: "unknown",
          },
        ],
        kind: "custom-tool-kind",
        locations: [{ line: 3, path: "src/index.ts" }, { line: "bad" }],
        sessionUpdate: "tool_call",
        status: "bad-status",
        title: "Run custom tool",
        toolCallId: "tool-1",
      },
    } as never);

    expect(created?.update).toMatchObject({
      content: [
        {
          content: {
            text: "done",
            type: "text",
          },
          type: "content",
        },
      ],
      kind: "other",
      locations: [{ line: 3, path: "src/index.ts" }],
      sessionUpdate: "tool_call",
      status: "pending",
    });

    const updated = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        content: "bad",
        kind: null,
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    } as never);

    expect(updated?.update).toEqual({
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tool-1",
    });
  });

  it("derives stable tool titles when agents omit protocol title", () => {
    const named = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        kind: "custom",
        rawInput: {
          args: ["status"],
          command: "git",
        },
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
      },
    } as never);

    expect(named?.update).toMatchObject({
      kind: "other",
      sessionUpdate: "tool_call",
      title: "git status",
    });

    const fallback = normalizeSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
      },
    } as never);

    expect(fallback?.update).toMatchObject({
      kind: "other",
      sessionUpdate: "tool_call",
      title: "Tool call tool-2",
    });
  });
});
