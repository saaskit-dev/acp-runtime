import { describe, expect, it } from "vitest";

import {
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
} from "./types.js";
import {
  runtimeAuthenticationTerminalSuccessPatterns,
  selectRuntimeAuthenticationMethod,
} from "./authentication-utils.js";

describe("runtime authentication utils", () => {
  it("selects the metadata-marked default method", () => {
    const method = selectRuntimeAuthenticationMethod([
      {
        id: "api-key",
        title: "Use API key",
        type: "agent",
      },
      {
        id: "login",
        meta: {
          [ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY]: true,
        },
        title: "Login",
        type: "agent",
      },
    ]);

    expect(method?.id).toBe("login");
  });

  it("selects the only method and leaves ambiguous methods unresolved", () => {
    expect(
      selectRuntimeAuthenticationMethod([
        {
          id: "login",
          title: "Login",
          type: "agent",
        },
      ])?.id,
    ).toBe("login");

    expect(
      selectRuntimeAuthenticationMethod([
        {
          id: "a",
          title: "A",
          type: "agent",
        },
        {
          id: "b",
          title: "B",
          type: "agent",
        },
      ]),
    ).toBeUndefined();
  });

  it("reads terminal success patterns from runtime metadata", () => {
    expect(
      runtimeAuthenticationTerminalSuccessPatterns({
        id: "login",
        meta: {
          [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
            "ok",
            1,
            "ready",
          ],
        },
        title: "Login",
        type: "agent",
      }),
    ).toEqual(["ok", "ready"]);
  });
});
