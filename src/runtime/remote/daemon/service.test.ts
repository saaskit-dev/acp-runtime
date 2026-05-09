import { describe, expect, it } from "vitest";

import {
  createMacOSLaunchAgentPlist,
  launchDaemonPlistPath,
  parseMacOSLaunchAgentRunningState,
} from "./service.js";

describe("remote daemon user service", () => {
  it("creates a launchd plist that runs daemon with self-healing settings", () => {
    const plist = createMacOSLaunchAgentPlist({
      daemonBinPath: "/usr/local/bin/acp-runtime",
      daemonId: "dev-mac",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      homeDir: "/Users/dev",
      label: "dev.saaskit.acp-runtime.daemon",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      standardErrorPath: "/Users/dev/.acp-runtime/logs/daemon.err.log",
      standardOutPath: "/Users/dev/.acp-runtime/logs/daemon.out.log",
      workspaceRoots: ["/Users/dev/acp-runtime", "/Users/dev/work"],
    });

    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--relay-url</string>");
    expect(plist).toContain("<string>wss://relay.example.com</string>");
    expect(plist).toContain("<string>--host-id</string>");
    expect(plist).toContain("<string>dev-mac</string>");
    expect(plist).toContain("<string>/Users/dev/acp-runtime</string>");
    expect(plist).toContain("<string>/Users/dev/work</string>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(
      "<string>/Users/dev/.n/bin:/Users/dev/.local/bin:/Users/dev/Library/pnpm:" +
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
  });

  it("does not persist account login state in launchd environment", () => {
    const plist = createMacOSLaunchAgentPlist({
      daemonBinPath: "/usr/local/bin/acp-runtime",
      env: {
        ACP_REMOTE_DAEMON_ACCOUNT_ID: "acct-1",
        ACP_REMOTE_DAEMON_ACCOUNT_SESSION: "session-token",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      label: "dev.saaskit.acp-runtime.daemon",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      standardErrorPath: "/Users/dev/.acp-runtime/logs/daemon.err.log",
      standardOutPath: "/Users/dev/.acp-runtime/logs/daemon.out.log",
      workspaceRoots: ["/Users/dev"],
    });

    expect(plist).not.toContain("ACP_REMOTE_DAEMON_ACCOUNT_ID");
    expect(plist).not.toContain("ACP_REMOTE_DAEMON_ACCOUNT_SESSION");
    expect(plist).not.toContain("session-token");
  });

  it("creates a system LaunchDaemon plist that runs as the target user", () => {
    const plist = createMacOSLaunchAgentPlist({
      daemonBinPath: "/usr/local/bin/acp-runtime",
      homeDir: "/Users/dev",
      label: "dev.saaskit.acp-runtime.daemon",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      scope: "system",
      standardErrorPath: "/Users/dev/.acp-runtime/logs/daemon.err.log",
      standardOutPath: "/Users/dev/.acp-runtime/logs/daemon.out.log",
      userName: "dev",
      workspaceRoots: ["/Users/dev"],
    });

    expect(launchDaemonPlistPath()).toBe(
      "/Library/LaunchDaemons/dev.saaskit.acp-runtime.daemon.plist",
    );
    expect(plist).toContain("<key>UserName</key>");
    expect(plist).toContain("<string>dev</string>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("creates a system LaunchDaemon plist without explicit user override", () => {
    const plist = createMacOSLaunchAgentPlist({
      daemonBinPath: "/usr/local/bin/acp-runtime",
      homeDir: "/Users/dev",
      label: "dev.saaskit.acp-runtime.daemon",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      scope: "system",
      standardErrorPath: "/Users/dev/.acp-runtime/logs/daemon.err.log",
      standardOutPath: "/Users/dev/.acp-runtime/logs/daemon.out.log",
      workspaceRoots: ["/Users/dev"],
    });

    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
  });

  it("escapes plist values", () => {
    const plist = createMacOSLaunchAgentPlist({
      daemonBinPath: "/tmp/acp-runtime",
      label: "dev.saaskit.acp-runtime.daemon",
      nodePath: "/tmp/node",
      relayUrl: "wss://relay.example.com/?a=<b>&c=\"d\"",
      standardErrorPath: "/tmp/err.log",
      standardOutPath: "/tmp/out.log",
      workspaceRoots: ["/tmp/project's"],
    });

    expect(plist).toContain("a=&lt;b&gt;&amp;c=&quot;d&quot;");
    expect(plist).toContain("/tmp/project&apos;s");
  });

  it("parses actual launchd running state", () => {
    expect(
      parseMacOSLaunchAgentRunningState(`
gui/501/dev.saaskit.acp-runtime.daemon = {
  state = running
}
`),
    ).toBe(true);
    expect(
      parseMacOSLaunchAgentRunningState(`
gui/501/dev.saaskit.acp-runtime.daemon = {
  state = not running
}
`),
    ).toBe(false);
  });
});
