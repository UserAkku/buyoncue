/**
 * Minimal mock of the GitHub REST + OAuth endpoints this service uses. For tests ONLY.
 * Serves both api.github.com-style and github.com-style paths from one local server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockUser {
  id: number;
  login: string;
}

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  body: any;
}

/** A well-formed 40-hex SHA made from one hex digit, e.g. sha("a"). */
export const sha = (c: string) => c.repeat(40).slice(0, 40);

export class MockGithub {
  readonly appId = 4321;
  readonly clientId = "Iv1.testclient";
  readonly clientSecret = "test-client-secret";
  readonly users = new Map<number, MockUser>();
  readonly requests: Recorded[] = [];
  /** installationId -> { account, suspended, repoIds } */
  readonly installations = new Map<number, { account: MockUser; suspended: boolean; repoIds: number[] }>();
  readonly repos = new Map<number, { id: number; full_name: string; adminUserIds: number[] }>();
  /** `${fullName}:${login}` -> role_name */
  readonly roles = new Map<string, string>();
  readonly prs = new Map<string, any>();
  readonly files = new Map<string, any[]>();
  readonly commits = new Map<string, any[]>();
  readonly reviews = new Map<string, any[]>();
  readonly checkRuns = new Map<string, any[] | "forbidden">();
  readonly statuses = new Map<string, any[]>();
  readonly issues = new Map<string, any>();
  /** review threads per `${fullName}#${n}` for GraphQL: [{ isResolved }] */
  readonly threads = new Map<string, { isResolved: boolean }[]>();
  graphqlFails = false;
  /** branch rules per `${fullName}:${branch}`; absence -> 404 */
  readonly branchRules = new Map<string, any[]>();
  /** oauth code -> userId; deleted on use */
  readonly codes = new Map<string, number>();
  readonly userTokens = new Map<string, number>();
  readonly revokedTokens: string[] = [];
  rateLimited = false;
  private installTokens = new Map<string, number>();
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  calls(method: string, prefix: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  /** Seeds a maintainer, a contributor, one installation and one repo with a ready-to-review PR #42. */
  seed(): this {
    const maint = { id: 5001, login: "maint" };
    const contrib = { id: 6001, login: "contrib" };
    const other = { id: 7001, login: "intruder" };
    for (const u of [maint, contrib, other]) this.users.set(u.id, u);
    this.repos.set(4242, { id: 4242, full_name: "acme/app", adminUserIds: [maint.id] });
    this.repos.set(4343, { id: 4343, full_name: "acme/other", adminUserIds: [] });
    this.installations.set(9001, { account: { id: 8001, login: "acme" }, suspended: false, repoIds: [4242, 4343] });
    this.roles.set("acme/app:maint", "admin");
    this.roles.set("acme/app:contrib", "write");
    this.roles.set("acme/app:intruder", "read");
    this.branchRules.set("acme/app:main", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    this.setPr("acme/app", 42, { headSha: sha("a") });
    return this;
  }

  setPr(fullName: string, number: number, o: { headSha: string; merged?: boolean; labels?: string[]; body?: string; title?: string; state?: string; isPrivate?: boolean; authorType?: string }): void {
    const repo = [...this.repos.values()].find((r) => r.full_name === fullName)!;
    this.prs.set(`${fullName}#${number}`, {
      number,
      state: o.state ?? (o.merged ? "closed" : "open"),
      draft: false,
      merged: o.merged ?? false,
      merged_at: o.merged ? "2026-11-04T12:00:00Z" : null,
      merge_commit_sha: o.merged ? sha("e") : null,
      mergeable_state: "clean",
      title: o.title ?? "Add feature",
      body: o.body ?? "Closes #7",
      user: { id: 6001, login: "contrib", type: o.authorType ?? "User" },
      labels: (o.labels ?? ["reward-ready"]).map((name) => ({ name })),
      head: { sha: o.headSha, ref: "feature" },
      base: { sha: sha("b"), ref: "main", repo: { id: repo.id, full_name: fullName, private: o.isPrivate ?? false } },
      changed_files: 3,
      additions: 30,
      deletions: 4,
    });
    if (!this.files.has(`${fullName}#${number}`)) {
      this.files.set(`${fullName}#${number}`, [
        { filename: "src/a.ts", status: "modified", additions: 20, deletions: 2, changes: 22, patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "test/a.test.ts", status: "added", additions: 10, deletions: 0, changes: 10, patch: "@@ -0,0 +1 @@\n+t" },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
      ]);
      this.commits.set(`${fullName}#${number}`, [{ sha: sha("c"), author: { id: 6001, login: "contrib" }, commit: { message: "feat: add\n\nbody", author: { date: "2026-11-03T10:00:00Z" } } }]);
      this.reviews.set(`${fullName}#${number}`, [{ id: 1, user: { id: 5001, login: "maint" }, state: "APPROVED", body: "Looks right to me.", submitted_at: "2026-11-03T11:00:00Z", commit_id: o.headSha }]);
      this.issues.set(`${fullName}#7`, { number: 7, state: "open", title: "Bug 7", labels: [{ name: "bug" }] });
    }
    this.checkRuns.set(`${fullName}@${o.headSha}`, [{ id: 1, name: "ci", status: "completed", conclusion: "success", app: { slug: "github-actions" } }]);
    this.statuses.set(`${fullName}@${o.headSha}`, []);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;
    const method = req.method ?? "GET";
    const auth = req.headers.authorization;
    this.requests.push({ method, path, query: Object.fromEntries(url.searchParams), authorization: auth, body });

    const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const page = <T,>(items: T[], wrap?: (page: T[]) => unknown) => {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const p = Number(url.searchParams.get("page") ?? 1);
      const slice = items.slice((p - 1) * per, p * per);
      const headers: Record<string, string> = {};
      if (p * per < items.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(p + 1));
        headers.link = `<${this.url}${next.pathname}${next.search}>; rel="next"`;
      }
      send(200, wrap ? wrap(slice) : slice, headers);
    };

    // ---- OAuth (github.com host)
    if (method === "POST" && path === "/login/oauth/access_token") {
      const uid = this.codes.get(body.code);
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret || uid === undefined) return send(200, { error: "bad_verification_code" });
      this.codes.delete(body.code);
      const token = `ghu_mock_${uid}_${this.userTokens.size}`;
      this.userTokens.set(token, uid);
      return send(200, { access_token: token, token_type: "bearer" });
    }
    if (method === "DELETE" && path === `/applications/${this.clientId}/token`) {
      this.revokedTokens.push(body.access_token);
      this.userTokens.delete(body.access_token);
      return send(204);
    }

    // ---- App (JWT) endpoints
    const instTok = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (method === "POST" && instTok) {
      if (!/^bearer ey/i.test(auth ?? "")) return send(401, { message: "A JSON web token could not be decoded" });
      const id = Number(instTok[1]);
      const inst = this.installations.get(id);
      if (!inst) return send(404, { message: "Not Found" });
      const token = `ghs_mock_${id}_${this.installTokens.size}`;
      this.installTokens.set(token, id);
      return send(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "selected" });
    }
    const instGet = path.match(/^\/app\/installations\/(\d+)$/);
    if (method === "GET" && instGet) {
      if (!/^bearer ey/i.test(auth ?? "")) return send(401, { message: "A JSON web token could not be decoded" });
      const inst = this.installations.get(Number(instGet[1]));
      if (!inst) return send(404, { message: "Not Found" });
      return send(200, { id: Number(instGet[1]), account: inst.account, app_id: this.appId, suspended_at: inst.suspended ? "2026-11-01T00:00:00Z" : null });
    }

    // ---- user-token endpoints
    const userId = auth ? this.userTokens.get(auth.replace(/^(Bearer|token) /i, "")) : undefined;
    if (method === "GET" && path === "/user" && userId !== undefined) return send(200, this.users.get(userId));
    if (method === "GET" && path === "/user/installations" && userId !== undefined) {
      // A user sees installations whose repos they can reach (here: those with an admin repo, or all for the maintainer).
      const mine = [...this.installations].filter(([, i]) => i.repoIds.some((r) => this.repos.get(r)!.adminUserIds.includes(userId)));
      return page(mine, (p) => ({ total_count: mine.length, installations: p.map(([id, i]) => ({ id, account: i.account, suspended_at: i.suspended ? "x" : null })) }));
    }
    const uinstRepos = path.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (method === "GET" && uinstRepos && userId !== undefined) {
      const inst = this.installations.get(Number(uinstRepos[1]))!;
      const visible = inst.repoIds.map((r) => this.repos.get(r)!).filter((r) => r.adminUserIds.includes(userId) || userId === 5001);
      return page(visible, (p) => ({ total_count: visible.length, repositories: p.map((r) => ({ id: r.id, full_name: r.full_name, permissions: { admin: r.adminUserIds.includes(userId) } })) }));
    }
    if (path.startsWith("/user") && userId === undefined && !path.match(/^\/user\/\d+$/)) return send(401, { message: "Bad credentials" });

    // ---- installation-token endpoints
    const instId = auth ? this.installTokens.get(auth.replace(/^(Bearer|token) /i, "")) : undefined;
    if (instId === undefined) return send(401, { message: "Bad credentials" });
    if (this.rateLimited && path.startsWith("/repos/") && !path.endsWith("/pulls/42")) {
      return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    }
    const inst = this.installations.get(instId)!;
    const rateHdr = { "x-ratelimit-remaining": "4900", "x-ratelimit-reset": "1893456000" };

    if (method === "GET" && path === "/installation/repositories") {
      const rs = inst.repoIds.map((r) => this.repos.get(r)!);
      return page(rs, (p) => ({ total_count: rs.length, repositories: p.map((r) => ({ id: r.id, full_name: r.full_name, private: false })) }));
    }
    if (method === "POST" && path === "/graphql") {
      if (this.graphqlFails) return send(502, { message: "Bad gateway" });
      const v = body?.variables ?? {};
      const nodes = this.threads.get(`${v.owner}/${v.name}#${v.number}`) ?? [];
      return send(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
    }
    const userById = path.match(/^\/user\/(\d+)$/);
    if (method === "GET" && userById) {
      const u = this.users.get(Number(userById[1]));
      return u ? send(200, u) : send(404, { message: "Not Found" });
    }

    const rm = path.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);
    if (!rm) return send(404, { message: "Not Found" });
    const full = rm[1]!;
    const rest = rm[2]!;
    const repo = [...this.repos.values()].find((r) => r.full_name === full);
    if (!repo || !inst.repoIds.includes(repo.id)) return send(404, { message: "Not Found" });

    let m2: RegExpMatchArray | null;
    if ((m2 = rest.match(/^pulls\/(\d+)$/))) {
      const pr = this.prs.get(`${full}#${m2[1]}`);
      return pr ? send(200, pr, rateHdr) : send(404, { message: "Not Found" });
    }
    if ((m2 = rest.match(/^pulls\/(\d+)\/files$/))) return page(this.files.get(`${full}#${m2[1]}`) ?? []);
    if ((m2 = rest.match(/^pulls\/(\d+)\/commits$/))) return page(this.commits.get(`${full}#${m2[1]}`) ?? []);
    if ((m2 = rest.match(/^pulls\/(\d+)\/reviews$/))) return page(this.reviews.get(`${full}#${m2[1]}`) ?? []);
    if ((m2 = rest.match(/^commits\/([^/]+)\/check-runs$/))) {
      const runs = this.checkRuns.get(`${full}@${m2[1]}`);
      if (runs === "forbidden") return send(403, { message: "Resource not accessible by integration" });
      return page(runs ?? [], (p) => ({ total_count: (runs ?? []).length, check_runs: p }));
    }
    if ((m2 = rest.match(/^commits\/([^/]+)\/status$/))) {
      const st = this.statuses.get(`${full}@${m2[1]}`) ?? [];
      return send(200, { state: st.length ? "success" : "pending", statuses: st, total_count: st.length });
    }
    if ((m2 = rest.match(/^rules\/branches\/(.+)$/))) {
      const rules = this.branchRules.get(`${full}:${m2[1]}`);
      return rules ? page(rules) : send(404, { message: "Not Found" });
    }
    if ((m2 = rest.match(/^issues\/(\d+)$/))) {
      const iss = this.issues.get(`${full}#${m2[1]}`);
      return iss ? send(200, iss) : send(404, { message: "Not Found" });
    }
    if ((m2 = rest.match(/^collaborators\/([^/]+)\/permission$/))) {
      const role = this.roles.get(`${full}:${m2[1]}`);
      return role ? send(200, { permission: role === "admin" ? "admin" : role === "read" ? "read" : "write", role_name: role }) : send(404, { message: "Not Found" });
    }
    return send(404, { message: "Not Found" });
  }
}
