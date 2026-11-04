import { App, Octokit } from "octokit";
import type { GithubAppConfig } from "../config.js";
import type { VerifiedRepo } from "./sessions.js";

const MAX_INSTALLATIONS = 20;
const MAX_REPOS = 300;

export interface UserContext {
  githubUserId: string;
  githubLogin: string;
  repos: VerifiedRepo[];
  hasInstallation: boolean;
}

export interface InstallationInfo {
  id: number;
  accountLogin: string | null;
  suspended: boolean;
}

/** All GitHub I/O for the app: JWT/installation auth via Octokit, plus the user OAuth exchange. */
export class GithubApp {
  readonly app: App;
  private readonly OctokitClass: typeof Octokit;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GithubAppConfig, opts: { fetch?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.OctokitClass = Octokit.defaults({
      baseUrl: cfg.apiUrl,
      userAgent: "buyoncue-chat",
      throttle: { enabled: false },
      retry: { retries: 2 },
      request: { fetch: this.fetchImpl, timeout: 15_000 },
    }) as unknown as typeof Octokit;
    this.app = new App({ appId: cfg.appId, privateKey: cfg.privateKey, Octokit: this.OctokitClass });
  }

  /** Octokit authenticated as the installation (token minted and cached by Octokit, never stored by us). */
  installationClient(installationId: string): Promise<Octokit> {
    return this.app.getInstallationOctokit(Number(installationId));
  }

  async getInstallation(installationId: string): Promise<InstallationInfo> {
    const { data } = await this.app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: Number(installationId),
    });
    const account = data.account as { login?: string } | null;
    return { id: data.id, accountLogin: account?.login ?? null, suspended: !!data.suspended_at };
  }

  /** Repositories the installation can currently access (paginated). */
  async listInstallationRepositories(installationId: string): Promise<{ id: string; fullName: string }[]> {
    const octokit = await this.installationClient(installationId);
    const repos = await octokit.paginate("GET /installation/repositories", { per_page: 100 });
    return repos.map((r) => ({ id: String(r.id), fullName: r.full_name }));
  }

  /** Exchanges an OAuth code server-side. Returns the short-lived user token. */
  async exchangeCode(code: string): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: this.cfg.oauthCallbackUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
    if (!res.ok || !json?.access_token) throw new Error(`GitHub code exchange failed${json?.error ? `: ${json.error}` : ""}`);
    return json.access_token;
  }

  /** Best effort: the token is single-purpose, so invalidate it right after use. */
  async revokeUserToken(accessToken: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.cfg.apiUrl}/applications/${this.cfg.clientId}/token`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* the token expires on its own */
    }
  }

  /**
   * Using the user's token, establishes who they are (immutable numeric ID) and which installations
   * of THIS app and repositories they can reach. Nothing the browser supplied is trusted.
   */
  async fetchUserContext(accessToken: string): Promise<UserContext> {
    const user = new this.OctokitClass({ auth: accessToken });
    const { data: me } = await user.request("GET /user");
    const installations = await user.paginate("GET /user/installations", { per_page: 100 });
    const repos: VerifiedRepo[] = [];
    for (const inst of installations.slice(0, MAX_INSTALLATIONS)) {
      if (inst.suspended_at) continue;
      const list = await user.paginate("GET /user/installations/{installation_id}/repositories", {
        installation_id: inst.id,
        per_page: 100,
      });
      for (const r of list) {
        if (repos.length >= MAX_REPOS) break;
        repos.push({
          installationId: String(inst.id),
          repositoryId: String(r.id),
          fullName: r.full_name,
          userIsAdmin: r.permissions?.admin === true,
        });
      }
    }
    return { githubUserId: String(me.id), githubLogin: me.login, repos, hasInstallation: installations.length > 0 };
  }

  /** Fresh login for an immutable user ID (logins can be renamed). */
  async loginForUserId(installationId: string, githubUserId: string): Promise<string | null> {
    const octokit = await this.installationClient(installationId);
    try {
      const { data } = await octokit.request("GET /user/{account_id}", { account_id: Number(githubUserId) });
      return data.login;
    } catch {
      return null;
    }
  }

  /** Role of a user on a repository according to GitHub, using the installation token. */
  async collaboratorRole(installationId: string, fullName: string, login: string): Promise<string | null> {
    const octokit = await this.installationClient(installationId);
    const [owner, repo] = fullName.split("/") as [string, string];
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        owner,
        repo,
        username: login,
      });
      return (data as { role_name?: string; permission?: string }).role_name ?? data.permission ?? null;
    } catch {
      return null;
    }
  }
}
