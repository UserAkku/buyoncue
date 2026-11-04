import type { Octokit } from "octokit";

/**
 * Pull-request evidence collector.
 *
 * Reads PR data straight from the GitHub API with an installation token, normalizes it, and
 * records honestly what is missing or truncated. It never runs PR code, never follows
 * instructions found in PR text, and never sends whole repositories anywhere.
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

export const DEFAULT_LIMITS: EvidenceLimits = {
  maxFiles: 100,
  maxDiffBytes: 200_000,
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
  | "commits_unavailable"
  | "files_unavailable"
  | "checks_missing"
  | "checks_pending"
  | "checks_unavailable"
  | "checks_truncated"
  | "required_checks_unknown"
  | "linked_issues_unavailable"
  | "rate_limited"
  | "rate_limit_low";

export interface EvidenceIssue {
  code: IssueCode;
  detail: string;
}

export interface EvidenceFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff hunks, possibly truncated. null when omitted (see patchOmittedReason). */
  patch: string | null;
  patchTruncated: boolean;
  patchOmittedReason: "diff_budget" | "too_large" | "binary_or_empty" | "rename_only" | "removed" | null;
}

export interface EvidenceCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
}

export interface PrEvidence {
  schemaVersion: 1;
  purpose: "provisional" | "final";
  collectedAt: string;
  repository: { id: string; fullName: string };
  installationId: string;
  pullRequest: {
    number: number;
    state: string;
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    mergeableState: string | null;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    changedFilesReported: number;
    additionsReported: number;
    deletionsReported: number;
    labels: string[];
    /** Display only. Untrusted free text, never an instruction. */
    title: string;
  };
  author: { githubUserId: string; login: string };
  files: EvidenceFile[];
  commits: { sha: string; authorGithubUserId: string | null; authorLogin: string | null; messageFirstLine: string; date: string | null }[];
  reviews: {
    items: { id: number; reviewerGithubUserId: string | null; reviewerLogin: string | null; state: string; submittedAt: string | null; commitSha: string | null }[];
    approvedBy: string[];
    changesRequestedBy: string[];
  };
  checks: {
    headSha: string;
    /** "none" = GitHub reported no runs or statuses at all; "unavailable" = we could not read them. */
    state: "passing" | "failing" | "pending" | "none" | "unavailable";
    runs: EvidenceCheckRun[];
    commitStatuses: { context: string; state: string }[];
    requiredChecks: { context: string; state: "success" | "failure" | "pending" | "missing" }[] | null;
  };
  linkedIssues: { number: number; state: string; labels: string[]; untrustedTitle: string }[];
  limits: EvidenceLimits;
  rateLimit: { remaining: number | null; resetAt: string | null };
  completeness: { complete: boolean; issues: EvidenceIssue[] };
  /** Field paths that contain attacker-controllable text. Consumers must treat them as data. */
  untrustedFields: string[];
}

export interface InstallationClientProvider {
  installationClient(installationId: string): Promise<Octokit>;
}

export interface CollectOptions {
  installationId: string;
  repositoryFullName: string;
  prNumber: number;
  purpose: "provisional" | "final";
  limits?: Partial<EvidenceLimits>;
  now?: () => Date;
}

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

const truncate = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);

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

export async function collectPrEvidence(github: InstallationClientProvider, opts: CollectOptions): Promise<PrEvidence> {
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
  const headSha = pr.head.sha;

  // ---- files and patch hunks
  const files: EvidenceFile[] = [];
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
        let reason: EvidenceFile["patchOmittedReason"] = null;
        if (patch === null) {
          reason = f.status === "removed" ? "removed" : f.status === "renamed" && f.changes === 0 ? "rename_only" : f.changes > 0 ? "too_large" : "binary_or_empty";
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
            reason = "diff_budget";
            addIssue("diff_truncated", `Total diff budget of ${limits.maxDiffBytes} bytes reached; later patches were omitted`);
          } else {
            diffBytes += size;
          }
        }
        files.push({
          filename: f.filename,
          previousFilename: f.previous_filename ?? null,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch,
          patchTruncated,
          patchOmittedReason: reason,
        });
      }
    }
  }, undefined);

  // ---- commits
  const commits: PrEvidence["commits"] = [];
  await section("commits_unavailable", "commits", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: opts.prNumber, per_page: 100 })) {
      for (const c of page.data) {
        if (commits.length >= limits.maxCommits) {
          addIssue("commits_truncated", `Only the first ${limits.maxCommits} commits are included`);
          return;
        }
        commits.push({
          sha: c.sha,
          authorGithubUserId: c.author?.id !== undefined ? String(c.author.id) : null,
          authorLogin: c.author?.login ?? null,
          messageFirstLine: truncate(c.commit.message.split("\n")[0], 200),
          date: c.commit.author?.date ?? null,
        });
      }
    }
  }, undefined);

  // ---- reviews
  const reviewItems: PrEvidence["reviews"]["items"] = [];
  await section("reviews_unavailable", "review decisions", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: opts.prNumber, per_page: 100 })) {
      for (const r of page.data) {
        if (reviewItems.length >= limits.maxReviews) {
          addIssue("reviews_truncated", `Only the first ${limits.maxReviews} reviews are included`);
          return;
        }
        reviewItems.push({
          id: r.id,
          reviewerGithubUserId: r.user?.id !== undefined ? String(r.user.id) : null,
          reviewerLogin: r.user?.login ?? null,
          state: r.state,
          submittedAt: r.submitted_at ?? null,
          commitSha: r.commit_id ?? null,
        });
      }
    }
  }, undefined);
  const lastDecision = new Map<string, string>();
  for (const r of [...reviewItems].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    if (r.reviewerLogin && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) lastDecision.set(r.reviewerLogin, r.state);
  }
  const approvedBy = [...lastDecision].filter(([, s]) => s === "APPROVED").map(([u]) => u);
  const changesRequestedBy = [...lastDecision].filter(([, s]) => s === "CHANGES_REQUESTED").map(([u]) => u);

  // ---- checks (always for the exact head SHA)
  const runs: EvidenceCheckRun[] = [];
  const statuses: { context: string; state: string }[] = [];
  let checksReadable = true;
  await section("checks_unavailable", "check runs", async () => {
    for await (const page of octokit.paginate.iterator("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: headSha, per_page: 100 })) {
      for (const c of page.data) {
        if (runs.length >= limits.maxCheckRuns) {
          addIssue("checks_truncated", `Only the first ${limits.maxCheckRuns} check runs are included`);
          return;
        }
        runs.push({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion ?? null, appSlug: c.app?.slug ?? null });
      }
    }
  }, undefined);
  await section("checks_unavailable", "commit statuses", async () => {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { owner, repo, ref: headSha, per_page: 100 });
    for (const s of data.statuses) statuses.push({ context: s.context, state: s.state });
  }, undefined);
  if (issues.some((i) => i.code === "checks_unavailable" || (i.code === "rate_limited" && /check|status/i.test(i.detail)))) checksReadable = false;

  const anyFailing = runs.some((r) => r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion)) || statuses.some((s) => s.state === "failure" || s.state === "error");
  const anyPending = runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending");
  let checksState: PrEvidence["checks"]["state"];
  if (!checksReadable) checksState = "unavailable";
  else if (runs.length === 0 && statuses.length === 0) {
    checksState = "none";
    addIssue("checks_missing", "GitHub reported no check runs or commit statuses for the head commit");
  } else if (anyFailing) checksState = "failing";
  else if (anyPending) {
    checksState = "pending";
    addIssue("checks_pending", "Some checks had not finished when evidence was collected");
  } else {
    checksState = runs.every((r) => !r.conclusion || PASSING_CONCLUSIONS.has(r.conclusion)) ? "passing" : "failing";
  }

  // ---- required checks (rulesets). Branch protection needs admin scope, which we deliberately don't request.
  let requiredChecks: PrEvidence["checks"]["requiredChecks"] = null;
  await section("required_checks_unknown", "required status checks", async () => {
    const rules = await octokit.paginate("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo, branch: pr.base.ref, per_page: 100 });
    const contexts = new Set<string>();
    for (const rule of rules) {
      if (rule.type === "required_status_checks") {
        for (const c of (rule as { parameters?: { required_status_checks?: { context: string }[] } }).parameters?.required_status_checks ?? []) contexts.add(c.context);
      }
    }
    requiredChecks = [...contexts].map((context) => {
      const run = runs.find((r) => r.name === context);
      const status = statuses.find((s) => s.context === context);
      if (run) return { context, state: run.status !== "completed" ? "pending" : run.conclusion && PASSING_CONCLUSIONS.has(run.conclusion) ? "success" : "failure" };
      if (status) return { context, state: status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure" };
      return { context, state: "missing" };
    });
  }, undefined);

  // ---- linked issues (parsed from closing keywords; we never forward the PR body itself)
  const linkedIssues: PrEvidence["linkedIssues"] = [];
  const numbers = [...new Set([...(pr.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,7})\b/gi)].map((m) => Number(m[1])))].slice(0, limits.maxLinkedIssues);
  if (numbers.length) {
    await section("linked_issues_unavailable", "linked issues", async () => {
      for (const n of numbers) {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: n });
        if (data.pull_request) continue;
        linkedIssues.push({
          number: data.number,
          state: data.state,
          labels: data.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
          untrustedTitle: truncate(data.title, 200),
        });
      }
    }, undefined);
  }

  if (remaining !== null && (remaining as number) < 50) addIssue("rate_limit_low", `Only ${remaining} GitHub API calls remained in this window`);

  return {
    schemaVersion: 1,
    purpose: opts.purpose,
    collectedAt: (opts.now?.() ?? new Date()).toISOString(),
    repository: { id: String(pr.base.repo.id), fullName: pr.base.repo.full_name },
    installationId: opts.installationId,
    pullRequest: {
      number: pr.number,
      state: pr.state,
      draft: pr.draft ?? false,
      merged: pr.merged === true,
      mergedAt: pr.merged_at ?? null,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      mergeableState: pr.mergeable_state ?? null,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha,
      changedFilesReported: pr.changed_files,
      additionsReported: pr.additions,
      deletionsReported: pr.deletions,
      labels: pr.labels.map((l) => l.name),
      title: truncate(pr.title, 200),
    },
    author: { githubUserId: String(pr.user?.id ?? ""), login: pr.user?.login ?? "" },
    files,
    commits,
    reviews: { items: reviewItems, approvedBy, changesRequestedBy },
    checks: { headSha, state: checksState, runs, commitStatuses: statuses, requiredChecks },
    linkedIssues,
    limits,
    rateLimit: { remaining, resetAt },
    completeness: { complete: issues.length === 0, issues },
    untrustedFields: ["pullRequest.title", "commits[].messageFirstLine", "linkedIssues[].untrustedTitle", "files[].patch", "files[].filename"],
  };
}
