#!/usr/bin/env node

import { ACP_REMOTE_DEFAULT_RELAY_URL } from "./defaults.js";
import {
  clearCachedSession,
  getSessionPath,
  loadCachedSession,
  loginViaOAuth,
  saveSession,
  validateRelaySession,
} from "./daemon/daemon-login.js";
import {
  getAcpRemoteDaemonUserServiceStatus,
  installAcpRemoteDaemonUserService,
  startAcpRemoteDaemonUserService,
} from "./daemon/service.js";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type AuthCommand =
  | { name: "help" }
  | { ensureDaemon: boolean; force: boolean; name: "login"; relayUrl: string }
  | { name: "logout" }
  | { name: "status" };

export function parseAcpRuntimeAuthCommand(argv: readonly string[]): AuthCommand {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  switch (command) {
    case "login":
      return parseLoginCommand(rest);
    case "logout":
      assertNoArgs(rest, "logout");
      return { name: "logout" };
    case "status":
      assertNoArgs(rest, "status");
      return { name: "status" };
    default:
      throw new Error(`Unknown acp-runtime auth command: ${command}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = parseAcpRuntimeAuthCommand(argv);
  switch (command.name) {
    case "help":
      printHelp();
      return;
    case "login":
      await login(command);
      return;
    case "logout":
      await logout();
      return;
    case "status":
      await status();
      return;
  }
}

function parseLoginCommand(argv: readonly string[]): AuthCommand {
  let ensureDaemon = true;
  let force = false;
  let relayUrl = ACP_REMOTE_DEFAULT_RELAY_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--force":
      case "-f":
        force = true;
        break;
      case "--no-daemon":
        ensureDaemon = false;
        break;
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        return { name: "help" };
      default:
        throw new Error(`Unknown acp-runtime auth login option: ${arg}`);
    }
  }
  return { ensureDaemon, force, name: "login", relayUrl };
}

function assertNoArgs(argv: readonly string[], command: string): void {
  if (argv.length > 0) {
    throw new Error(`Unexpected arguments for acp-runtime auth ${command}: ${argv.join(" ")}`);
  }
}

function readArgValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

async function login(command: Extract<AuthCommand, { name: "login" }>): Promise<void> {
  if (!command.force) {
    const cached = await loadCachedSession();
    if (cached) {
      const validation = await validateRelaySession({
        relayUrl: command.relayUrl,
        session: cached,
      });
      if (!validation.ok) {
        if (!validation.retryable) {
          await clearCachedSession();
        }
        process.stdout.write(
          [
            validation.retryable
              ? `Cached session could not be validated right now: ${validation.reason}`
              : `Cached session is no longer valid: ${validation.reason}`,
            validation.retryable
              ? "Keeping the cached session. Retry when the relay/network is reachable, or use `--force` to refresh login now."
              : "Opening browser to refresh login...",
          ].join("\n") + "\n",
        );
        if (validation.retryable) {
          return;
        }
      } else {
        process.stdout.write(
          [
            "Already authenticated.",
            `account: ${validation.accountId}`,
            `session: ${getSessionPath()}`,
            "Use `acp-runtime auth login --force` to refresh the session.",
          ].join("\n") + "\n",
        );
        return;
      }
    }
  }

  const session = await loginViaOAuth(command.relayUrl);
  await saveSession(session);
  const daemonMessage = command.ensureDaemon
    ? await ensureDefaultDaemonInstalled(command.relayUrl, {
        reinstall: command.force,
      })
    : "Daemon install skipped because --no-daemon was set.";
  process.stdout.write(
    [
      "Authentication successful.",
      `account: ${session.accountId}`,
      `session: ${getSessionPath()}`,
      daemonMessage,
    ].join("\n") + "\n",
  );
}

async function ensureDefaultDaemonInstalled(
  relayUrl: string,
  options: { reinstall?: boolean } = {},
): Promise<string> {
  if (process.platform !== "darwin") {
    return "Daemon service install skipped: automatic service install currently supports macOS launchd only.";
  }
  const homeDir = homedir();
  const systemStatus = getAcpRemoteDaemonUserServiceStatus(
    undefined,
    "system",
    homeDir,
  );
  const userStatus = getAcpRemoteDaemonUserServiceStatus(
    undefined,
    "user",
    homeDir,
  );
  if (systemStatus.installed && !userStatus.installed) {
    return reinstallSystemDaemonService(relayUrl);
  }
  if (userStatus.installed && !options.reinstall) {
    if (userStatus.running) {
      return `Daemon service already installed: running (${userStatus.plistPath})`;
    }
    const started = await startAcpRemoteDaemonUserService(
      undefined,
      "user",
      homeDir,
    );
    return `Daemon service already installed; started: ${started.running ? "running" : "not running"} (${started.plistPath})`;
  }
  const status = await installAcpRemoteDaemonUserService({
    daemonBinPath: join(dirname(fileURLToPath(import.meta.url)), "daemon", "bin.js"),
    env: {
      ...process.env,
    },
    homeDir,
    nodePath: process.execPath,
    relayUrl,
    scope: "user",
    workspaceRoots: [homeDir],
  });
  return `Daemon service ${options.reinstall ? "reinstalled" : "installed"}: ${status.running ? "running" : "not running"} (${status.plistPath})`;
}

function reinstallSystemDaemonService(relayUrl: string): string {
  const daemonBinPath = join(dirname(fileURLToPath(import.meta.url)), "daemon", "bin.js");
  try {
    execFileSync(
      "sudo",
      [
        process.execPath,
        daemonBinPath,
        "install",
        "--system",
        "--relay-url",
        relayUrl,
      ],
      { stdio: "inherit" },
    );
    return "System daemon service reinstalled.";
  } catch (error) {
    return `System daemon reinstall failed after login: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function logout(): Promise<void> {
  const path = getSessionPath();
  const cached = await loadCachedSession();
  await clearCachedSession();
  if (!cached) {
    process.stdout.write(`Not authenticated. No cached session at ${path}.\n`);
    return;
  }
  process.stdout.write(`Logged out. Removed cached session at ${path}.\n`);
}

async function status(): Promise<void> {
  const cached = await loadCachedSession();
  const validation = cached
    ? await validateRelaySession({
        relayUrl: ACP_REMOTE_DEFAULT_RELAY_URL,
        session: cached,
      })
    : undefined;
  process.stdout.write(
    [
      `authenticated: ${validation?.ok ? "yes" : "no"}`,
      ...(validation?.ok && cached
        ? [
            `account: ${validation.accountId}`,
            `savedAt: ${new Date(cached.savedAt).toISOString()}`,
          ]
        : []),
      ...(!validation?.ok && cached
        ? [`reason: ${validation?.reason ?? "cached session missing"}`]
        : []),
      `session: ${getSessionPath()}`,
    ].join("\n") + "\n",
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  acp-runtime auth login [--relay-url <ws-url>] [--force] [--no-daemon]",
      "  acp-runtime auth status",
      "  acp-runtime auth logout",
      "",
      "Options:",
      `  --relay-url   Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  --force       Ignore any cached account session and open browser OAuth.",
      "  --no-daemon   Only cache the login session; do not install the default user daemon.",
      "",
      "The auth login command caches the account session. After a fresh login,",
      "it installs the default user daemon service on macOS if no service exists.",
      "--force refreshes login and reinstalls the default user daemon service.",
      `Cached session: ${getSessionPath()}`,
    ].join("\n") + "\n",
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
