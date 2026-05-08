import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type DaemonSession = {
  accountId: string;
  token: string;
  savedAt: number;
};

const SESSION_FILE_NAME = "relay-session.json";
const SESSION_DIR = (homeDir = homedir()) => join(homeDir, ".acp-runtime");
const SESSION_PATH = (homeDir = homedir()) => join(SESSION_DIR(homeDir), SESSION_FILE_NAME);

export function getSessionPath(homeDir?: string): string {
  return SESSION_PATH(homeDir);
}

export async function loadCachedSession(homeDir?: string): Promise<DaemonSession | undefined> {
  return readSessionFile(SESSION_PATH(homeDir));
}

async function readSessionFile(path: string): Promise<DaemonSession | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const session: DaemonSession = JSON.parse(raw);
    if (!session.token || !session.accountId) {
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export async function saveSession(session: DaemonSession, homeDir?: string): Promise<void> {
  const dir = SESSION_DIR(homeDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(SESSION_PATH(homeDir), JSON.stringify(session, null, 2), "utf-8");
}

export async function clearCachedSession(homeDir?: string): Promise<void> {
  await rm(SESSION_PATH(homeDir), { force: true });
}

export type SessionValidationResult =
  | { accountId: string; ok: true }
  | { ok: false; reason: string; retryable?: boolean; status?: number };

export async function validateRelaySession(input: {
  relayUrl: string;
  session: DaemonSession;
}): Promise<SessionValidationResult> {
  try {
    const url = new URL(
      "/api/session",
      input.relayUrl.replace(/^ws(s?):\/\//, "http$1://"),
    );
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.session.token}`,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return {
        ok: false,
        reason: typeof body?.error === "string"
          ? body.error
          : `Relay rejected cached session with HTTP ${response.status}.`,
        status: response.status,
      };
    }
    const body = await response.json().catch(() => undefined) as { accountId?: unknown } | undefined;
    const accountId = typeof body?.accountId === "string"
      ? body.accountId
      : input.session.accountId;
    return { accountId, ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not validate cached relay session: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }
}

export async function loginViaOAuth(relayUrl: string): Promise<DaemonSession> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const localPort = typeof addr === "object" && addr ? addr.port : 0;
      const url = new URL(req.url ?? "/", `http://localhost:${localPort}`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        const accountId = url.searchParams.get("accountId");
        if (!token || !accountId) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Login failed</h1><p>Missing token in callback.</p>");
          reject(new Error("OAuth callback missing token."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p>" +
          "<script>window.close()</script>",
        );

        const session: DaemonSession = {
          accountId,
          savedAt: Date.now(),
          token,
        };
        server.close();
        resolve(session);
        return;
      }

      // Root: health check
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ACP daemon OAuth listener ready.");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) {
        reject(new Error("Failed to bind local OAuth server."));
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://localhost:${port}/callback`;
      // Convert ws:// or wss:// to http:// or https:// for the login URL
      const httpRelayUrl = relayUrl.replace(/^ws(s?):\/\//, "http$1://");
      const loginUrl = new URL("/login", httpRelayUrl);
      loginUrl.searchParams.set("returnTo", callbackUrl);

      process.stderr.write(`Opening browser for login: ${loginUrl.toString()}\n`);
      openBrowser(loginUrl.toString()).catch((err) => {
        process.stderr.write(
          `Could not open browser automatically: ${err instanceof Error ? err.message : err}\n` +
          `Please open this URL manually: ${loginUrl.toString()}\n`,
        );
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out after 5 minutes."));
    }, 5 * 60 * 1000);
  });
}

async function openBrowser(url: string): Promise<void> {
  const { execFile } = await import("child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open"
    : platform === "win32" ? "cmd.exe"
    : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", url] : [url];

  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
