import {
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
  type AcpRuntimeAuthenticationMethod,
} from "./types.js";

export function selectRuntimeAuthenticationMethod(
  methods: readonly AcpRuntimeAuthenticationMethod[],
): AcpRuntimeAuthenticationMethod | undefined {
  if (methods.length === 0) {
    return undefined;
  }

  const defaultMethod = methods.find(
    (method) =>
      method.meta?.[ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY] === true,
  );
  if (defaultMethod) {
    return defaultMethod;
  }

  return methods.length === 1 ? methods[0] : undefined;
}

export function runtimeAuthenticationTerminalSuccessPatterns(
  method: AcpRuntimeAuthenticationMethod,
): readonly string[] | undefined {
  const patterns =
    method.meta?.[ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY];
  if (!Array.isArray(patterns)) {
    return undefined;
  }

  const values = patterns.filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
  return values.length > 0 ? values : undefined;
}
