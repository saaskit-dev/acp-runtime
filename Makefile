.PHONY: help install clean build build-self dev lint test test-watch \
	demo-client-sdk demo-runtime harness-clean harness-admission harness-full \
	runtime simulator claude codex local-pack local-install local-uninstall

PROMPT ?=
RUNTIME_AGENT := $(word 2,$(MAKECMDGOALS))
PACKAGE_VERSION := $(shell node -p "require('./package.json').version")
PACKAGE_TARBALL := saaskit-dev-acp-runtime-$(PACKAGE_VERSION).tgz

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
		'Local npm-style install:' \
		'  make local-install' \
		'  make local-uninstall' \
		'' \
		'Note:' \
		'  GNU make does not support CLI flags like --prompt=/describe for recipes.' \
		'  Use PROMPT="/describe" instead.'

install:
	bun install

clean:
	bun run clean

build:
	bun run build

build-self:
	bun run build:self

dev:
	bun run dev

lint:
	bun run lint

test:
	bun run test

test-watch:
	bun run test:watch

demo-client-sdk:
	bun run demo:client-sdk

demo-runtime:
	bun run runtime

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
		bun dist/runtime/cli/runtime-command.js "$$agent_id" $(PROMPT)

simulator:
	@:

claude:
	@:

codex:
	@:

harness-clean:
	bun run harness:clean-outputs

harness-admission:
	bun run harness:check-admission

harness-full:
	bun run harness:run-agent

local-pack:
	bun run build:lib
	npm pack

local-install: local-pack
	npm install -g ./$(PACKAGE_TARBALL)
	@printf '%s\n' '' 'Installed local package. Try:' '  acp-runtime --help'

local-uninstall:
	npm uninstall -g @saaskit-dev/acp-runtime

%:
	@if [ "$@" = "$(firstword $(MAKECMDGOALS))" ]; then \
		echo "Unknown target: $@"; \
		exit 2; \
	fi
