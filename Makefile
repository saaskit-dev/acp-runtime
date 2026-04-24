.PHONY: help install clean build build-self dev lint test test-watch \
	demo-client-sdk demo-runtime harness-clean harness-admission harness-full \
	runtime simulator claude codex

PROMPT ?=
RUNTIME_AGENT := $(word 2,$(MAKECMDGOALS))

help:
	@printf '%s\n' \
		'Common targets:' \
		'  make install' \
		'  make clean' \
		'  make build' \
		'  make build-self' \
		'  make dev' \
		'  make lint' \
		'  make test' \
		'  make test-watch' \
		'  make demo-client-sdk' \
		'  make demo-runtime' \
		'  make runtime simulator' \
		'  make runtime simulator PROMPT="/describe"' \
		'  make runtime claude' \
		'  make runtime codex' \
		'  make runtime <registry-agent-id> PROMPT="..."' \
		'  make harness-clean' \
		'  make harness-admission' \
		'  make harness-full' \
		'' \
		'Note:' \
		'  GNU make does not support CLI flags like --prompt=/describe for recipes.' \
		'  Use PROMPT="/describe" instead.'

install:
	pnpm install

clean:
	pnpm run clean

build:
	pnpm run build

build-self:
	pnpm run build:self

dev:
	pnpm run dev

lint:
	pnpm run lint

test:
	pnpm run test

test-watch:
	pnpm run test:watch

demo-client-sdk:
	pnpm run demo:client-sdk

demo-runtime:
	pnpm run demo:runtime

runtime:
	@if [ -z "$(RUNTIME_AGENT)" ]; then \
		echo 'usage: make runtime <agent-id> [PROMPT="..."]'; \
		exit 2; \
	fi
	@$(MAKE) --no-print-directory build-self
	@agent_id="$(RUNTIME_AGENT)"; \
	if [ "$$agent_id" = "claude" ]; then \
		agent_id="claude-acp"; \
	fi; \
	if [ "$$agent_id" = "codex" ]; then \
		agent_id="codex-acp"; \
	fi; \
	node dist/examples/runtime-sdk-demo.js "$$agent_id" $(PROMPT)

simulator:
	@:

claude:
	@:

codex:
	@:

harness-clean:
	pnpm run harness:clean-outputs

harness-admission:
	pnpm run harness:check-admission

harness-full:
	pnpm run harness:run-agent

%:
	@if [ "$@" = "$(firstword $(MAKECMDGOALS))" ]; then \
		echo "Unknown target: $@"; \
		exit 2; \
	fi
