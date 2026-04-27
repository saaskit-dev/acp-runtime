# acp-runtime Maintenance Guide

## Project Mission

- `acp-runtime` is the host-side SDK/runtime layer for Agent Client Protocol (ACP) products.
- The runtime must give hosts one stable model for agent launch, sessions, turns, permissions, recovery, read models, and observability.
- The runtime must hide real ACP agent implementation differences after the agent `type` is known. External host integrations should not need per-agent workaround knowledge.
- The simulator package is a deterministic ACP agent used for runtime and harness validation. It is not the product API.

## Repository Map

- `src/index.ts`: package-root public API. Keep exports intentional and covered by `src/index.test.ts`.
- `src/runtime/index.ts`: runtime public API re-export layer.
- `src/runtime/core/`: product-facing runtime abstractions (`AcpRuntime`, `AcpRuntimeSession`, errors, queue/session/read-model state, initial config).
- `src/runtime/acp/`: ACP-specific transport, session orchestration, protocol mapping, and profile normalization.
- `src/runtime/acp/profiles/`: agent-specific compatibility adapters selected by `AcpRuntimeAgent.type`.
- `src/runtime/agents/`: explicit launch helper constructors and constants for known agents.
- `src/runtime/registry/`: ACP registry launch resolution, local cache, aliases, and local session registry.
- `examples/`: host/demo programs that exercise public runtime APIs. They should not contain per-agent compatibility workarounds.
- `harness/`: protocol/scenario validation tooling and case definitions.
- `packages/simulator-agent/`: independently built simulator ACP agent.
- `docs/`: public docs, RFCs, compatibility notes, research matrices.
- `dist/`: generated output. Do not manually edit.

## Compatibility Boundary

- Agent-specific compatibility belongs in SDK/runtime profiles or adapter layers by default.
- Do not require demos, harnesses, or external hosts to know agent-specific quirks.
- If an agent needs behavior normalization, first look at `src/runtime/acp/profiles/<agent>.ts`.
- If the behavior affects launch identity, registry ids, aliases, or cache layout, use `src/runtime/registry/`.
- If the behavior is generic ACP shape mapping, use `src/runtime/acp/*-mapper.ts` or `src/runtime/core/`.
- Demo/harness code may expose or test compatibility behavior, but should call runtime APIs instead of duplicating per-agent logic.

Examples that should be handled by runtime/profile, not external hosts:

- Registry id and short alias resolution (`github`, `copilot`, `pi`, `codex`, `claude`, `sim`).
- Mode id/name/URI normalization.
- Auth method quirks such as terminal auth that is only an interactive setup entrypoint.
- Agent-specific system prompt delivery.
- Config option aliases and value aliases.
- Protocol shape drift and benign agent-specific errors.

## Public API Rules

- Keep the package root narrow. If adding a value export, update `src/index.ts` and `src/index.test.ts`.
- Do not export internal driver/service/connection types from the package root.
- Prefer adding host-facing APIs to `AcpRuntime` or `AcpRuntimeSession` over requiring hosts to call raw ACP methods.
- Dedicated `createXxxAcpAgent(...)` helpers are optional sugar. Registry id startup must remain the primary fallback path.
- A registry id listed by ACP should be startable through `runtime.sessions.start({ agent: "<id>" })` even without a dedicated helper.
- Common short names should resolve centrally in `src/runtime/registry/agent-launch-registry.ts`.

## Runtime/Profile Rules

- `acp/session-service.ts` owns ACP lifecycle orchestration: initialize, auth, session new/load/resume/list/fork, and cleanup.
- Any path that starts an agent process must dispose it on failure. Do not leave child processes running after create/auth/session errors.
- `acp/profiles/` may normalize initialize auth methods, runtime auth methods, prompt errors, system prompts, initial config aliases, and operation classifications.
- Profile policies should be explicit and covered by tests in `src/runtime/acp/profiles/index.test.ts` or agent-specific tests.
- Do not put host UI details in profiles unless they are required to prevent host-visible semantic breakage.
- `Authentication not implemented` from `authenticate` is treated as a compatibility skip in runtime lifecycle, not a fatal session creation error.
- For terminal auth that opens a full interactive product CLI, adapt it in the profile so hosts receive a protocol-only auth method rather than terminal execution details.
- If a host needs terminal login completion hints, expose them through `acp-runtime/terminal-success-patterns` metadata from the profile, not an agent-id branch in the host.
- If a host should prefer one auth method among several, expose `acp-runtime/default-auth-method` metadata from the profile, not hardcoded demo selection logic.
- Generic hosts should consume `selectRuntimeAuthenticationMethod(...)`, `runtimeAuthenticationTerminalSuccessPatterns(...)`, and `resolveRuntimeTerminalAuthenticationRequest(...)` instead of duplicating auth policy.
- Runtime may auto-authenticate safe protocol-only `agent` methods when no host authentication handler is provided. It must not auto-run terminal or env-var auth without host participation.

## Demo And Harness Rules

- `examples/runtime-sdk-demo.ts` should demonstrate host usage, not own core compatibility.
- `examples/runtime-demo-auth-adapter.ts` may choose auth methods and run terminal auth, but should not contain agent-specific skip/workaround logic.
- CLI conveniences such as display formatting, command parsing, and interactive prompts can stay in examples.
- Harness cases should validate observable behavior and compatibility surfaces. Add cases when a new agent integration exposes a new behavioral family.
- Harness output is diagnostic. Keep generated artifacts under `.tmp/` or configured output directories, not committed docs unless intentionally summarized.

## Agent Integration Workflow

- Start with registry id startup. Do not require a helper before an agent can run.
- Add aliases only in the centralized registry alias map.
- Add a helper in `src/runtime/agents/` only when callers need convenient explicit overrides for command/package/version/env/args.
- Add or update a profile when the agent's ACP behavior differs from the runtime's host-facing contract.
- Add tests for helper construction, registry/alias resolution, profile normalization, and any runtime lifecycle changes.
- Run focused smoke through `./run runtime <agent>` and harness admission/full cases when applicable.
- Record persistent compatibility findings in docs, not only in chat or temporary logs.

## Testing And Validation

Use focused checks while iterating:

- `pnpm exec tsc --noEmit -p tsconfig.json`
- `pnpm run build:lib && pnpm exec tsc --noEmit -p tsconfig.examples.json`
- `pnpm exec tsc --noEmit -p tsconfig.harness.json`
- `pnpm exec vitest run <test files>`

Use broader checks before handing off larger changes:

- `pnpm run build:self`
- `pnpm run lint`
- `pnpm test`

For real agent checks:

- `./run agents` lists registry-supported agents.
- `./run runtime <id-or-alias>` starts the interactive runtime demo.
- `./run runtime --list-agents` lists supported registry agents.
- `pnpm harness:check-admission -- --type <agent>` is the first-pass admission gate.
- `pnpm harness:run-agent -- --type <agent>` is the stricter full matrix.

## Logs And State

- Runtime home defaults to `~/.acp-runtime/`.
- Runtime cache defaults to `~/.acp-runtime/cache/`.
- Runtime logs default to `~/.acp-runtime/logs/runtime.log` and `.jsonl`.
- Session logs live under `~/.acp-runtime/logs/sessions/<sessionId>/`.
- Override with `ACP_RUNTIME_HOME_DIR`, `ACP_RUNTIME_CACHE_DIR`, or demo `--log-file` flags.
- Use logs to inspect raw ACP JSON-RPC before changing compatibility behavior.

## Process And Signal Handling

- Stdio agent processes must be disposed on every failure path after spawn.
- Terminal auth child processes must handle `SIGINT`/`SIGTERM` and escalate to `SIGKILL` only as a last resort.
- Do not use destructive cleanup commands like `git reset --hard` or broad process kills.
- When killing test/smoke processes, target only the PIDs created by the current run.

## Documentation Rules

- Update both English and `docs/zh-CN/` pages when changing public semantics.
- Use `docs/guides/runtime-sdk-api.md` for public API semantics.
- Use `docs/guides/runtime-agent-compatibility.md` for compatibility policy.
- Use `docs/research/*` for observed agent behavior and admission evidence.
- Keep README high-level; avoid burying detailed maintenance rules there.

## Coding Conventions

- TypeScript source is ESM.
- Prefer small focused modules over adding unrelated logic to `runtime.ts` or `driver.ts`.
- Keep public types in `src/runtime/core/types.ts` when they are host-facing.
- Keep ACP wire mapping in `src/runtime/acp/*`.
- Keep registry/cache concerns in `src/runtime/registry/*`.
- Add tests near the layer changed.
- Do not manually edit `dist/`; rebuild it with scripts.
