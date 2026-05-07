import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ACP_REMOTE_DAEMON_LAUNCHD_LABEL =
  "dev.saaskit.acp-runtime.daemon";

export type AcpRemoteDaemonServiceInstallOptions = {
  daemonBinPath: string;
  daemonId?: string;
  env?: Record<string, string | undefined>;
  identityPath?: string;
  label?: string;
  nodePath: string;
  relayUrl: string;
  workspaceRoots: readonly string[];
};

export type AcpRemoteDaemonServiceStatus = {
  installed: boolean;
  label: string;
  plistPath: string;
  running: boolean;
};

export async function installAcpRemoteDaemonUserService(
  options: AcpRemoteDaemonServiceInstallOptions,
): Promise<AcpRemoteDaemonServiceStatus> {
  assertMacOSServiceSupport();
  const label = options.label ?? ACP_REMOTE_DAEMON_LAUNCHD_LABEL;
  const plistPath = launchAgentPlistPath(label);
  const logDir = join(homedir(), ".acp-runtime", "logs");
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    plistPath,
    createMacOSLaunchAgentPlist({
      ...options,
      label,
      standardErrorPath: join(logDir, "daemon.err.log"),
      standardOutPath: join(logDir, "daemon.out.log"),
    }),
    "utf8",
  );
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label));
  await runLaunchctlWithRetry("bootstrap", launchdUserDomain(), plistPath);
  await runLaunchctlWithRetry("kickstart", "-k", launchdServiceTarget(label));
  return getAcpRemoteDaemonUserServiceStatus(label);
}

export async function uninstallAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
): Promise<void> {
  assertMacOSServiceSupport();
  const plistPath = launchAgentPlistPath(label);
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label));
  await rm(plistPath, { force: true });
}

export function startAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
): AcpRemoteDaemonServiceStatus {
  assertMacOSServiceSupport();
  const plistPath = launchAgentPlistPath(label);
  ignoreLaunchctlFailure("bootstrap", launchdUserDomain(), plistPath);
  runLaunchctl("kickstart", "-k", launchdServiceTarget(label));
  return getAcpRemoteDaemonUserServiceStatus(label);
}

export function stopAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
): AcpRemoteDaemonServiceStatus {
  assertMacOSServiceSupport();
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label));
  return getAcpRemoteDaemonUserServiceStatus(label);
}

export function getAcpRemoteDaemonUserServiceStatus(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
): AcpRemoteDaemonServiceStatus {
  assertMacOSServiceSupport();
  const plistPath = launchAgentPlistPath(label);
  return {
    installed: existsSync(plistPath),
    label,
    plistPath,
    running: isLaunchdServiceRunning(label),
  };
}

export async function readAcpRemoteDaemonUserServicePlist(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
): Promise<string | undefined> {
  const plistPath = launchAgentPlistPath(label);
  if (!existsSync(plistPath)) {
    return undefined;
  }
  return readFile(plistPath, "utf8");
}

export function createMacOSLaunchAgentPlist(input: {
  daemonBinPath: string;
  daemonId?: string;
  env?: Record<string, string | undefined>;
  identityPath?: string;
  label: string;
  nodePath: string;
  relayUrl: string;
  standardErrorPath: string;
  standardOutPath: string;
  workspaceRoots: readonly string[];
}): string {
  const args = [
    input.nodePath,
    input.daemonBinPath,
    "run",
    "--relay-url",
    input.relayUrl,
    ...input.workspaceRoots.flatMap((root) => ["--workspace-root", root]),
    ...(input.daemonId ? ["--host-id", input.daemonId] : []),
    ...(input.identityPath ? ["--identity-path", input.identityPath] : []),
  ];
  const env = sanitizeLaunchdEnv(input.env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapePlist(key)}</key>\n    <string>${escapePlist(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.standardErrorPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapePlist(homedir())}</string>
</dict>
</plist>
`;
}

export function launchAgentPlistPath(label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function sanitizeLaunchdEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {
    HOME: homedir(),
    PATH: env?.PATH ?? process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  };
  for (const key of [
    "ACP_REMOTE_DAEMON_ACCOUNT_ID",
    "ACP_REMOTE_DAEMON_ACCOUNT_SESSION",
    "ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS",
    "ACP_REMOTE_DAEMON_WORKSPACE_ROOTS",
  ]) {
    const value = env?.[key] ?? process.env[key];
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function isLaunchdServiceRunning(label: string): boolean {
  try {
    const output = execFileSync("launchctl", [
      "print",
      launchdServiceTarget(label),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseMacOSLaunchAgentRunningState(output);
  } catch {
    return false;
  }
}

export function parseMacOSLaunchAgentRunningState(output: string): boolean {
  return /^\s*state = running\s*$/m.test(output);
}

function launchdUserDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdServiceTarget(label: string): string {
  return `${launchdUserDomain()}/${label}`;
}

function runLaunchctl(...args: string[]): void {
  execFileSync("launchctl", args, { stdio: "inherit" });
}

async function runLaunchctlWithRetry(...args: string[]): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      execFileSync("launchctl", args, { stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  writeLaunchctlErrorOutput(lastError);
  throw lastError;
}

function ignoreLaunchctlFailure(...args: string[]): void {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // launchctl returns non-zero when bootstrapping an already-loaded service or
    // booting out a missing one. The next status check is the source of truth.
  }
}

function assertMacOSServiceSupport(): void {
  if (process.platform !== "darwin") {
    throw new Error("acp-runtime daemon service install currently supports macOS launchd only.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLaunchctlErrorOutput(error: unknown): void {
  if (!error || typeof error !== "object") {
    return;
  }
  const output = error as { stderr?: unknown; stdout?: unknown };
  writeOutput(output.stdout);
  writeOutput(output.stderr);
}

function writeOutput(output: unknown): void {
  if (typeof output === "string") {
    process.stderr.write(output);
    return;
  }
  if (Buffer.isBuffer(output)) {
    process.stderr.write(output.toString("utf8"));
  }
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
