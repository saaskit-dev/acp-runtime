import { describe, expect, it } from "vitest";

import {
  createMacOSLaunchAgentPlist,
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
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
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
