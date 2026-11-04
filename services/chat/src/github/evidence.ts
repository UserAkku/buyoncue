import type { Octokit } from "octokit";
import type { EngineEvidence } from "../engine/bounty-types.js";

/**
 * Pull-request evidence collector.
 *
 * Reads PR data straight from the GitHub API with an installation token and produces the exact
 * document the engine's `POST /v1/contributions/review` accepts. It records honestly what is
 * missing or truncated, never assumes CI success, never runs PR code and never follows
 * instructions found in PR text. Free text (title, body, patches, commit messages, issue text) is
 * attacker-controlled data; the engine's model prompt and deterministic policy treat it that way.
 */

export interface EvidenceLimits {
  maxFiles: number;
  maxDiffBytes: number;
  maxPatchBytesPerFile: number;
  maxCommits: number;
  maxReviews: number;
  maxCheckRuns: number;
  maxLinkedIssues: number;
}

/** File and size ceilings sit inside the engine's own hold thresholds (50 files, 120k serialized characters). */
export const DEFAULT_LIMITS: EvidenceLimits = {
  maxFiles: 50,
  maxDiffBytes: 80_000,
  maxPatchBytesPerFile: 20_000,
  maxCommits: 100,
  maxReviews: 100,
  maxCheckRuns: 100,
  maxLinkedIssues: 3,
};

export type IssueCode =
  | "files_truncated"
  | "diff_truncated"
  | "patch_unavailable"
  | "commits_truncated"
  | "reviews_truncated"
  | "reviews_unavailable"
  | "review_threads_unavailable"
  | "commits_unavailable"
  | "files_unavailable"
  | "checks_missing"
  | "checks_pending"
  | "checks_unavailable"
  | "checks_truncated"
  | "required_checks_unknown"
  | "linked_issues_unavailable"
  | "maintainer_unverified"
  | "rate_limited"
  | "rate_limit_low";

/** Issues that only affect the CI verdict, not whether the diff/commit/review evidence is complete. */
const CI_ONLY: ReadonlySet<IssueCode> = new Set(["checks_missing", "checks_pending", "required_checks_unknown", "rate_limit_low", "maintainer_unverified"]);

export interface EvidenceIssue {
  code: IssueCode;
  detail: string;
}

/** A maintainer label event recorded from a signed webhook (the only way to bind a label to a head SHA). */
export interface LabelAuthorization {
  actorGithubUserId: string;
  headSha: string;
  label: string;
  authorizedAt: string;
}

export interface InstallationClientProvider {
  installationClient(installationId: string): Promise<Octokit>;
}

export interface CollectOptions {
  installationId: string;
  repositoryFullName: string;
  prNumber: number;
  /** Numeric GitHub ID of the connected policy owner: the only identity that can authorize a bounty. */
  maintainerGithubUserId: string | null;
  requiredLabel: string | null;
  labelAuthorization?: LabelAuthorization | null;
  limits?: Partial<EvidenceLimits>;
  now?: () => Date;
}

export interface CollectedEvidence {
  evidence: EngineEvidence;
  issues: EvidenceIssue[];
  rateLimit: { remaining: number | null; resetAt: string | null };
}

type Check = EngineEvidence["checks"][number];
type CheckConclusion = NonNullable<Check["conclusion"]>;

const CONCLUSIONS: ReadonlySet<string> = new Set(["success", "failure", "cancelled", "timed_out", "neutral", "skipped", "action_required", "stale"]);
const STATUS_ID_OFFSET = 1_000_000_000_000_000; // keeps legacy commit-status IDs from colliding with check-run IDs

const truncate = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);
const HEX = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function utf8Prefix(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

function isRateLimited(err: unknown): boolean {
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string> } };
  if (e?.status !== 403 && e?.status !== 429) return false;
  return e.status === 429 || e.response?.headers?.["x-ratelimit-remaining"] === "0" || /rate limit/i.test(e.message ?? "");
}

function mapConclusion(c: string | null | undefined): CheckConclusion | null {
  if (!c) return null;
  if (CONCLUSIONS.has(c)) return c as CheckConclusion;
  return "failure"; // e.g. startup_failure: never treated as success
}

function mapFileStatus(s: string): EngineEvidence["files"][number]["status"] {
  if (s === "added" || s === "removed" || s === "renamed" || s === "modified") return s;
  return s === "copied" ? "added" : "modified";
}

export async function collectPrEvidence(github: InstallationClientProvider, opts: CollectOptions): Promise<CollectedEvidence> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const octokit = await github.installationClient(opts.installationId);
  const [owner, repo] = opts.repositoryFullName.split("/") as [string, string];
  const issues: EvidenceIssue[] = [];
  const addIssue = (code: IssueCode, detail: string) => {
    if (!issues.some((i) => i.code === code && i.detail === detail)) issues.push({ code, detail });
  };
  let remaining: number | null = null;
  let resetAt: string | null = null;
  octokit.hook.after("request", (response) => {
    const h = response.headers as Record<string, string | number | undefined>;
    if (h["x-ratelimit-remaining"] !== undefined) remaining = Number(h["x-ratelimit-remaining"]);
    if (h["x-ratelimit-reset"] !== undefined) resetAt = new Date(Number(h["x-ratelimit-reset"]) * 1000).toISOString();
  });

  /** Runs one optional section; failures degrade to "incomplete" instead of aborting or inventing data. */
  async function section<T>(unavailableCode: IssueCode, label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimited(err)) addIssue("rate_limited", `GitHub rate limit reached while reading ${label}`);
      else addIssue(unavailableCode, `${label} could not be read from GitHub (HTTP ${(err as { status?: number }).status ?? "error"})`);
      return fallback;
    }
  }

  // The PR itself is mandatory: if this fails the whole collection fails.
  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: opts.prNumber });
  const headSha = pr.head.sha.toLowerCase();
  const baseSha = pr.base.sha.toLowerCase();
  if (!HEX.test(headSha) || !HEX.test(baseSha)) throw new Error("GitHub returned an unexpected commit SHA");
  if (!pr.user) throw new Error("Pull request has no author");

  // ---- files and patch hunks
  const files: EngineEvidence["files"] = [];
  await section("files_unavailable", "changed files", async () => {
    let diffBytes = 0;
    let seen = 0;
    outer: for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number: opts.prNumber, per_page: 100 })) {
      for (const f of page.data) {
        seen++;
        if (files.length >= limits.maxFiles) {
          addIssue("files_truncated", `Only the first ${limits.maxFiles} of ${Math.max(pr.changed_files, seen)} changed files are included`);
          break outer;
        }
        let patch: string | null = f.patch ?? null;
        let patchTruncated = false;
        if (patch === null) {
          const reason = f.status === "removed" ? "removed" : f.status === "renamed" && f.changes === 0 ? "rename_only" : f.changes > 0 ? "too_large" : "binary_or_empty";
          if (reason === "too_large" || reason === "binary_or_empty") addIssue("patch_unavailable", `No diff available for ${f.filename} (${reason})`);
        } else {
          if (Buffer.byteLength(patch) > limits.maxPatchBytesPerFile) {
            patch = utf8Prefix(patch, limits.maxPatchBytesPerFile);
            patchTruncated = true;
            addIssue("diff_truncated", `Patch for ${f.filename} was cut at ${limits.maxPatchBytesPerFile} bytes`);
          }
          const size = Buffer.byteLength(patch);
          if (diffBytes + size > limits.maxDiffBytes) {
            patch = null;
            addIssue("diff_truncated", `Total diff budget of ${limits.maxDiffBytes} bytes reached; later patches were omitted`);
          } else {
            diffBytes += size;
          }
        }
        files.push({ path: truncate(f.filename, 300), status: mapFileStatus(f.status), additions: f.additions, deletions: f.deletions, patch, patchTruncated });
      }
    }
  }, undefined);

  // ---- commits
  const commits: EngineEvidence["commits"] = [];
  await section("commits_unavailable", "commits", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: opts.prNumber, per_page: 100 })) {
      for (const c of page.data) {
        if (commits.length >= limits.maxCommits) {
          addIssue("commits_truncated", `Only the first ${limits.maxCommits} commits are included`);
          return;
        }
        if (HEX.test(c.sha) && !commits.some((x) => x.sha === c.sha.toLowerCase())) commits.push({ sha: c.sha.toLowerCase(), message: truncate(c.commit.message, 5000) });
      }
    }
  }, undefined);

  // ---- review threads (REST cannot tell whether feedback was resolved; GraphQL can)
  let threadsResolved: boolean | null = null;
  await section("review_threads_unavailable", "review threads", async () => {
    let cursor: string | null = null;
    let allResolved = true;
    for (let page = 0; page < 5; page++) {
      const res: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { isResolved: boolean }[] } } } } = await octokit.graphql(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}`,
        { owner, name: repo, number: opts.prNumber, cursor },
      );
      const t = res.repository.pullRequest.reviewThreads;
      if (t.nodes.some((n) => !n.isResolved)) allResolved = false;
      if (!t.pageInfo.hasNextPage) {
        threadsResolved = allResolved;
        return;
      }
      cursor = t.pageInfo.endCursor;
    }
    throw new Error("too many review threads");
  }, undefined);

  // ---- reviews
  type RawReview = { id: number; reviewer: number; login: string; state: EngineEvidence["reviews"][number]["state"]; submittedAt: string; commit: string; body: string };
  const rawReviews: RawReview[] = [];
  await section("reviews_unavailable", "review decisions", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: opts.prNumber, per_page: 100 })) {
      for (const r of page.data) {
        if (rawReviews.length >= limits.maxReviews) {
          addIssue("reviews_truncated", `Only the first ${limits.maxReviews} reviews are included`);
          return;
        }
        if (!r.user || !r.commit_id || !HEX.test(r.commit_id)) continue; // cannot be tied to a person and a commit
        if (!["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(r.state)) continue;
        rawReviews.push({ id: r.id, reviewer: r.user.id, login: r.user.login, state: r.state as RawReview["state"], submittedAt: r.submitted_at ?? "", commit: r.commit_id.toLowerCase(), body: truncate(r.body, 10_000) });
      }
    }
  }, undefined);
  const latestDecision = new Map<number, string>();
  for (const r of [...rawReviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latestDecision.set(r.reviewer, r.state);
  }
  const reviews: EngineEvidence["reviews"] = rawReviews.map((r) => ({
    id: r.id,
    reviewerGithubUserId: String(r.reviewer),
    headSha: r.commit,
    state: r.state,
    body: r.body,
    // A change request is resolved once the same reviewer later approved or was dismissed; other feedback needs all threads resolved.
    feedbackResolved: r.state === "CHANGES_REQUESTED" ? latestDecision.get(r.reviewer) !== "CHANGES_REQUESTED" : threadsResolved === true,
  }));

  // ---- checks (always for the exact head SHA)
  const checks: EngineEvidence["checks"] = [];
  let checksReadable = true;
  let checksTruncated = false;
  const runNames = new Set<string>();
  await section("checks_unavailable", "check runs", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: headSha, per_page: 100 })) {
      for (const c of page.data) {
        if (checks.length >= limits.maxCheckRuns) {
          addIssue("checks_truncated", `Only the first ${limits.maxCheckRuns} check runs are included`);
          checksTruncated = true;
          return;
        }
        runNames.add(c.name);
        checks.push({
          id: c.id,
          name: truncate(c.name, 200),
          headSha,
          status: c.status === "completed" ? "completed" : c.status === "in_progress" ? "in_progress" : "queued",
          conclusion: c.status === "completed" ? mapConclusion(c.conclusion) : null,
          required: false,
        });
      }
    }
  }, undefined);
  await section("checks_unavailable", "commit statuses", async () => {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { owner, repo, ref: headSha, per_page: 100 });
    for (const [i, s] of data.statuses.entries()) {
      if (checks.length >= limits.maxCheckRuns) {
        addIssue("checks_truncated", `Only the first ${limits.maxCheckRuns} checks are included`);
        checksTruncated = true;
        return;
      }
      runNames.add(s.context);
      const done = s.state === "success" || s.state === "failure" || s.state === "error";
      checks.push({
        id: STATUS_ID_OFFSET + (Number.isSafeInteger(s.id) && s.id > 0 ? s.id : i + 1),
        name: truncate(s.context, 200),
        headSha,
        status: done ? "completed" : "in_progress",
        conclusion: s.state === "success" ? "success" : done ? "failure" : null,
        required: false,
      });
    }
  }, undefined);
  if (issues.some((i) => i.code === "checks_unavailable" || (i.code === "rate_limited" && /check|status/i.test(i.detail)))) checksReadable = false;
  if (checksReadable && checks.length === 0) addIssue("checks_missing", "GitHub reported no check runs or commit statuses for the head commit");
  if (checks.some((c) => c.status !== "completed")) addIssue("checks_pending", "Some checks had not finished when evidence was collected");

  // ---- required checks (rulesets). Branch protection needs admin scope, which we deliberately don't request.
  const requiredBox: { contexts: Set<string> | null } = { contexts: null };
  await section("required_checks_unknown", "required status checks", async () => {
    const rules = await octokit.paginate("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo, branch: pr.base.ref, per_page: 100 });
    const contexts = new Set<string>();
    for (const rule of rules) {
      if (rule.type === "required_status_checks") {
        for (const c of (rule as { parameters?: { required_status_checks?: { context: string }[] } }).parameters?.required_status_checks ?? []) contexts.add(c.context);
      }
    }
    requiredBox.contexts = contexts;
  }, undefined);
  const required = requiredBox.contexts;
  if (required) for (const c of checks) c.required = required.has(c.name);
  // CI is "complete" only if every required context was enumerated AND is present for this exact head.
  const ciComplete = checksReadable && !checksTruncated && required !== null && [...required].every((ctx) => runNames.has(ctx));
  if (required !== null && !ciComplete && checksReadable) {
    const missing = [...required].filter((ctx) => !runNames.has(ctx));
    if (missing.length) addIssue("checks_missing", `Required check(s) have not reported for the head commit: ${missing.join(", ").slice(0, 200)}`);
  }

  // ---- linked issues (parsed from closing keywords in the PR body; contents are untrusted data)
  const linkedIssues: EngineEvidence["linkedIssues"] = [];
  const numbers = [...new Set([...(pr.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,7})\b/gi)].map((m) => Number(m[1])))].slice(0, limits.maxLinkedIssues);
  if (numbers.length) {
    await section("linked_issues_unavailable", "linked issues", async () => {
      for (const n of numbers) {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: n });
        if (data.pull_request) continue;
        linkedIssues.push({ number: data.number, title: truncate(data.title, 500), body: truncate(data.body, 15_000), state: data.state === "closed" ? "closed" : "open" });
      }
    }, undefined);
  }

  // ---- maintainer authorization, bound to the exact current head SHA
  const labels = pr.labels.map((l) => l.name);
  const collectedAt = (opts.now?.() ?? new Date()).toISOString();
  let maintainerAuthorization: EngineEvidence["maintainerAuthorization"] = null;
  if (opts.maintainerGithubUserId && opts.requiredLabel && labels.includes(opts.requiredLabel)) {
    const hasWrite = await section("maintainer_unverified", "maintainer permission", async () => {
      const { data: u } = await octokit.request("GET /user/{account_id}", { account_id: Number(opts.maintainerGithubUserId) });
      const { data: p } = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", { owner, repo, username: u.login });
      const role = (p as { role_name?: string; permission?: string }).role_name ?? p.permission;
      return role === "admin" || role === "maintain" || role === "write";
    }, false);
    if (hasWrite) {
      const stored = opts.labelAuthorization;
      const approval = reviews
        .filter((r) => r.reviewerGithubUserId === opts.maintainerGithubUserId && r.headSha === headSha && r.state === "APPROVED" && r.feedbackResolved && latestDecision.get(Number(r.reviewerGithubUserId)) === "APPROVED")
        .map((r) => ({ r, at: rawReviews.find((x) => x.id === r.id)!.submittedAt }))
        .filter((x) => x.at && x.at <= collectedAt)
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      if (stored && stored.headSha === headSha && stored.label === opts.requiredLabel && stored.actorGithubUserId === opts.maintainerGithubUserId && stored.authorizedAt <= collectedAt) {
        maintainerAuthorization = { actorGithubUserId: stored.actorGithubUserId, headSha, label: stored.label, verifiedWriteAccess: true, source: "github_api_label_event", authorizedAt: stored.authorizedAt };
      } else if (approval) {
        maintainerAuthorization = { actorGithubUserId: opts.maintainerGithubUserId, headSha, label: opts.requiredLabel, verifiedWriteAccess: true, source: "github_api_review", authorizedAt: approval.at };
      }
    }
  }

  if (remaining !== null && (remaining as number) < 50) addIssue("rate_limit_low", `Only ${remaining} GitHub API calls remained in this window`);

  const evidence: EngineEvidence = {
    installationId: opts.installationId,
    repositoryId: String(pr.base.repo.id),
    repositoryFullName: pr.base.repo.full_name.toLowerCase(),
    repositoryPrivate: pr.base.repo.private,
    prNumber: pr.number,
    headSha,
    baseSha,
    authorGithubUserId: String(pr.user.id),
    authorLogin: pr.user.login,
    authorIsBot: pr.user.type === "Bot" || /\[bot\]$/i.test(pr.user.login),
    merged: pr.merged === true,
    collectedAt,
    title: truncate(pr.title, 500),
    description: truncate(pr.body, 15_000),
    labels: labels.map((l) => truncate(l, 100)).slice(0, 100),
    files,
    commits,
    checks,
    reviews,
    linkedIssues,
    evidenceTruncated: issues.some((i) => !CI_ONLY.has(i.code)),
    ciComplete,
    maintainerAuthorization,
  };
  return { evidence, issues, rateLimit: { remaining, resetAt } };
}
