export type GitHubUser = {
  id: number;
  login: string;
};

export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export type GitHubAccount = {
  accountId: string;
  createdAt: number;
  githubId: number;
  githubLogin: string;
};

export type GitHubAccountStore = {
  findByGithubId(githubId: number): Promise<GitHubAccount | undefined>;
  upsert(account: GitHubAccount): Promise<void>;
};

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

export function createGitHubAuthorizationUrl(
  config: GitHubOAuthConfig,
  state: string,
  callbackBaseUrl: string,
): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${callbackBaseUrl}/login/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubCodeForAccessToken(
  config: GitHubOAuthConfig,
  code: string,
): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`GitHub token exchange error: ${body.error ?? "unknown"}`);
  }
  return body.access_token;
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "acp-relay-worker",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }
  const user = (await response.json()) as GitHubUser;
  if (!user.id || !user.login) {
    throw new Error("GitHub user response missing id or login.");
  }
  return user;
}

export function resolveOrCreateGithubAccount(
  store: GitHubAccountStore,
  githubUser: GitHubUser,
): Promise<GitHubAccount> {
  return resolveOrCreateAccount(store, githubUser);
}

async function resolveOrCreateAccount(
  store: GitHubAccountStore,
  githubUser: GitHubUser,
): Promise<GitHubAccount> {
  const existing = await store.findByGithubId(githubUser.id);
  if (existing) {
    return existing;
  }
  const account: GitHubAccount = {
    accountId: crypto.randomUUID(),
    createdAt: Date.now(),
    githubId: githubUser.id,
    githubLogin: githubUser.login,
  };
  await store.upsert(account);
  return account;
}

export class D1GitHubAccountStore implements GitHubAccountStore {
  constructor(private readonly db: D1Database) {}

  async findByGithubId(githubId: number): Promise<GitHubAccount | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM acp_github_accounts WHERE github_id = ?")
      .bind(githubId)
      .first<Record<string, unknown>>();
    if (!row) {
      return undefined;
    }
    return {
      accountId: row.account_id as string,
      createdAt: row.created_at as number,
      githubId: row.github_id as number,
      githubLogin: row.github_login as string,
    };
  }

  async upsert(account: GitHubAccount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO acp_accounts (account_id) VALUES (?) ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(account.accountId)
      .run();
    await this.db
      .prepare(
        `INSERT INTO acp_github_accounts (github_id, github_login, account_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET github_login = ?`,
      )
      .bind(
        account.githubId,
        account.githubLogin,
        account.accountId,
        account.createdAt,
        account.githubLogin,
      )
      .run();
  }
}

export class MemoryGitHubAccountStore implements GitHubAccountStore {
  private readonly byGithubId = new Map<number, GitHubAccount>();

  async findByGithubId(githubId: number): Promise<GitHubAccount | undefined> {
    return this.byGithubId.get(githubId);
  }

  async upsert(account: GitHubAccount): Promise<void> {
    this.byGithubId.set(account.githubId, account);
  }
}
