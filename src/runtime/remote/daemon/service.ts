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
  homeDir?: string;
  identityPath?: string;
  label?: string;
  nodePath: string;
  relayUrl: string;
  scope?: AcpRemoteDaemonServiceScope;
  userName?: string;
  workspaceRoots: readonly string[];
};

export type AcpRemoteDaemonServiceScope = "system" | "user";

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
  assertLaunchdScopePermissions(options.scope);
  const scope = options.scope ?? "user";
  const label = options.label ?? ACP_REMOTE_DAEMON_LAUNCHD_LABEL;
  const homeDir = options.homeDir ?? homedir();
  await removeOppositeLaunchdService({
    homeDir,
    label,
    scope,
    userName: options.userName,
  });
  const plistPath = launchdPlistPath(label, scope, homeDir);
  const logDir = join(homeDir, ".acp-runtime", "logs");
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    plistPath,
    createMacOSLaunchAgentPlist({
      ...options,
      homeDir,
      label,
      scope,
      standardErrorPath: join(logDir, "daemon.err.log"),
      standardOutPath: join(logDir, "daemon.out.log"),
    }),
    "utf8",
  );
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  ignoreLaunchctlFailure("bootout", launchdDomain(scope), plistPath);
  await waitForLaunchdServiceStopped(label, scope);
  await bootstrapAndKickstartLaunchAgent(label, plistPath, scope);
  await waitForLaunchdServiceRunning(label, scope);
  return getAcpRemoteDaemonUserServiceStatus(label, scope, homeDir);
}

async function removeOppositeLaunchdService(input: {
  homeDir: string;
  label: string;
  scope: AcpRemoteDaemonServiceScope;
  userName?: string;
}): Promise<void> {
  if (input.scope === "system") {
    const userPlistPath = launchdPlistPath(input.label, "user", input.homeDir);
    const userUid = input.userName ? readUserId(input.userName) : undefined;
    const userTarget = userUid
      ? `gui/${userUid}/${input.label}`
      : launchdServiceTarget(input.label, "user");
    ignoreLaunchctlFailure("bootout", userTarget);
    await rm(userPlistPath, { force: true });
    return;
  }

  const systemPlistPath = launchdPlistPath(input.label, "system", input.homeDir);
  if (!existsSync(systemPlistPath)) {
    return;
  }
  if (process.getuid?.() !== 0) {
    throw new Error(
      `System daemon is already installed at ${systemPlistPath}. ` +
      "Run `sudo acp-runtime daemon uninstall --system` before installing user mode.",
    );
  }
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(input.label, "system"));
  await rm(systemPlistPath, { force: true });
}

export async function uninstallAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
  scope: AcpRemoteDaemonServiceScope = "user",
  homeDir = homedir(),
): Promise<void> {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  const plistPath = launchdPlistPath(label, scope, homeDir);
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  await rm(plistPath, { force: true });
}

export async function startAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
  scope: AcpRemoteDaemonServiceScope = "user",
  homeDir = homedir(),
): Promise<AcpRemoteDaemonServiceStatus> {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  const plistPath = launchdPlistPath(label, scope, homeDir);
  await bootstrapAndKickstartLaunchAgent(label, plistPath, scope);
  await waitForLaunchdServiceRunning(label, scope);
  return getAcpRemoteDaemonUserServiceStatus(label, scope, homeDir);
}

export function stopAcpRemoteDaemonUserService(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
  scope: AcpRemoteDaemonServiceScope = "user",
  homeDir = homedir(),
): AcpRemoteDaemonServiceStatus {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  return getAcpRemoteDaemonUserServiceStatus(label, scope, homeDir);
}

export function getAcpRemoteDaemonUserServiceStatus(
  label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL,
  scope: AcpRemoteDaemonServiceScope = "user",
  homeDir = homedir(),
): AcpRemoteDaemonServiceStatus {
  assertMacOSServiceSupport();
  const plistPath = launchdPlistPath(label, scope, homeDir);
  return {
    installed: existsSync(plistPath),
    label,
    plistPath,
    running: isLaunchdServiceRunning(label, scope),
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
  homeDir?: string;
  identityPath?: string;
  label: string;
  nodePath: string;
  relayUrl: string;
  scope?: AcpRemoteDaemonServiceScope;
  standardErrorPath: string;
  standardOutPath: string;
  userName?: string;
  workspaceRoots: readonly string[];
}): string {
  const homeDir = input.homeDir ?? homedir();
  const scope = input.scope ?? "user";
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
  const env = sanitizeLaunchdEnv(input.env, homeDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
${scope === "system" && input.userName ? `  <key>UserName</key>\n  <string>${escapePlist(input.userName)}</string>\n` : ""}  <key>ProgramArguments</key>
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
  <string>${escapePlist(homeDir)}</string>
</dict>
</plist>
`;
}

export function launchAgentPlistPath(label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchDaemonPlistPath(label = ACP_REMOTE_DAEMON_LAUNCHD_LABEL): string {
  return join("/Library", "LaunchDaemons", `${label}.plist`);
}

function launchdPlistPath(
  label: string,
  scope: AcpRemoteDaemonServiceScope,
  homeDir: string,
): string {
  return scope === "system"
    ? launchDaemonPlistPath(label)
    : join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

function sanitizeLaunchdEnv(
  env: Record<string, string | undefined> | undefined,
  homeDir = homedir(),
): Record<string, string> {
  const result: Record<string, string> = {
    HOME: homeDir,
    PATH: defaultLaunchdPath(homeDir),
  };
  for (const key of [
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

function defaultLaunchdPath(homeDir: string): string {
  return [
    join(homeDir, ".n", "bin"),
    join(homeDir, ".local", "bin"),
    join(homeDir, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function isLaunchdServiceRunning(
  label: string,
  scope: AcpRemoteDaemonServiceScope,
): boolean {
  try {
    const output = execFileSync("launchctl", [
      "print",
      launchdServiceTarget(label, scope),
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

function launchdDomain(scope: AcpRemoteDaemonServiceScope): string {
  return scope === "system" ? "system" : launchdUserDomain();
}

function launchdServiceTarget(
  label: string,
  scope: AcpRemoteDaemonServiceScope,
): string {
  return `${launchdDomain(scope)}/${label}`;
}

async function bootstrapAndKickstartLaunchAgent(
  label: string,
  plistPath: string,
  scope: AcpRemoteDaemonServiceScope,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ignoreLaunchctlFailure("bootstrap", launchdDomain(scope), plistPath);
    try {
      execFileSync("launchctl", [
        "kickstart",
        "-k",
        launchdServiceTarget(label, scope),
      ], { stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  writeLaunchctlErrorOutput(lastError);
  throw lastError;
}

async function waitForLaunchdServiceStopped(
  label: string,
  scope: AcpRemoteDaemonServiceScope,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isLaunchdServiceRunning(label, scope)) {
      return;
    }
    await delay(100);
  }
}

async function waitForLaunchdServiceRunning(
  label: string,
  scope: AcpRemoteDaemonServiceScope,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (isLaunchdServiceRunning(label, scope)) {
      return;
    }
    await delay(100);
  }
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

function assertLaunchdScopePermissions(
  scope: AcpRemoteDaemonServiceScope = "user",
): void {
  if (scope === "system" && process.getuid?.() !== 0) {
    throw new Error("System daemon install/start/stop/uninstall requires root. Re-run with sudo.");
  }
}

function readUserId(userName: string): string | undefined {
  try {
    return execFileSync("id", ["-u", userName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
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
