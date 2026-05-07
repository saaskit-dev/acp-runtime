.PHONY: help install clean build build-self dev lint test test-watch \
	demo-client-sdk demo-runtime harness-clean harness-admission harness-full \
	runtime simulator claude codex remote-help remote-smoke remote-prod-smoke \
	remote-relay remote-daemon remote-bridge remote-e2e local-pack local-install \
	local-uninstall daemon-install daemon-login daemon-status bridge-config

PROMPT ?=
RUNTIME_AGENT := $(word 2,$(MAKECMDGOALS))
PACKAGE_VERSION := $(shell node -p "require('./package.json').version")
PACKAGE_TARBALL := saaskit-dev-acp-runtime-$(PACKAGE_VERSION).tgz
RELAY_URL ?= ws://localhost:8787
RELAY_HTTP_URL ?= http://localhost:8787
WORKSPACE_ROOT ?=
DAEMON_ID ?=
ACCOUNT_SESSION ?=
CLIENT_ID ?=

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
		'  make daemon-install' \
		'  make daemon-login' \
		'  make daemon-status' \
		'  make bridge-config' \
		'  make local-uninstall' \
		'' \
		'Remote targets:' \
		'  make remote-help' \
		'  make remote-smoke' \
		'  make remote-prod-smoke' \
		'  make remote-relay' \
		'  make remote-daemon' \
		'  make remote-bridge' \
		'  make remote-e2e' \
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

local-pack:
	pnpm run build:lib
	npm pack

local-install: local-pack
	npm install -g ./$(PACKAGE_TARBALL)
	@printf '%s\n' '' 'Installed local package. Try:' '  acp-runtime --help'

local-uninstall:
	npm uninstall -g @saaskit-dev/acp-runtime

daemon-install:
	acp-runtime daemon install

daemon-login:
	acp-runtime daemon install --force-login

daemon-status:
	acp-runtime daemon status

bridge-config:
	acp-runtime bridge config

remote-help:
	@printf '%s\n' \
		'Remote local workflow:' \
		'' \
		'  Terminal 1:' \
		'    make remote-relay' \
		'' \
		'  Terminal 2:' \
		'    make remote-daemon' \
		'' \
		'  Terminal 3:' \
		'    make remote-e2e' \
		'' \
		'Fast in-process smoke:' \
		'    make remote-smoke' \
		'' \
		'Hosted relay smoke:' \
		'    make remote-prod-smoke' \
		'' \
		'Optional variables:' \
		'    RELAY_URL=ws://localhost:8787' \
		'    RELAY_HTTP_URL=http://localhost:8787' \
		'    WORKSPACE_ROOT=/path/to/workspace   (default: daemon uses home)' \
		'    DAEMON_ID=my-host                   (default: persistent machine id)' \
		'    ACCOUNT_SESSION=token               (optional)' \
		'    CLIENT_ID=my-client                 (for remote-bridge only)'

remote-smoke:
	pnpm exec vitest run src/runtime/remote/broker-daemon-smoke.test.ts packages/relay-worker/src/native-acp-worker-smoke.test.ts

remote-prod-smoke:
	pnpm run remote:prod-smoke

remote-relay:
	pnpm --filter @saaskit-dev/acp-relay-worker dev

remote-daemon: build-self
	@args="--relay-url $(RELAY_URL)"; \
	if [ -n "$(DAEMON_ID)" ]; then args="$$args --host-id $(DAEMON_ID)"; fi; \
	if [ -n "$(WORKSPACE_ROOT)" ]; then args="$$args --workspace-root $(WORKSPACE_ROOT)"; fi; \
	if [ -n "$(ACCOUNT_SESSION)" ]; then args="$$args --account-session $(ACCOUNT_SESSION)"; fi; \
	node dist/runtime/remote/daemon/bin.js $$args

remote-bridge: build-self
	@env_cmd="ACP_RELAY_URL=$(RELAY_URL)"; \
	if [ -n "$(DAEMON_ID)" ]; then env_cmd="$$env_cmd ACP_DAEMON_ID=$(DAEMON_ID)"; fi; \
	if [ -n "$(CLIENT_ID)" ]; then env_cmd="$$env_cmd ACP_CLIENT_ID=$(CLIENT_ID)"; fi; \
	if [ -n "$(ACCOUNT_SESSION)" ]; then env_cmd="$$env_cmd ACP_ACCOUNT_SESSION=$(ACCOUNT_SESSION)"; fi; \
	eval "$$env_cmd node dist/runtime/remote/client/relay-bridge.js"

remote-e2e:
	RELAY_URL=$(RELAY_HTTP_URL) node test-e2e-acp.mjs

%:
	@if [ "$@" = "$(firstword $(MAKECMDGOALS))" ]; then \
		echo "Unknown target: $@"; \
		exit 2; \
	fi
