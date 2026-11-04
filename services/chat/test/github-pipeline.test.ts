import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPrEvidence } from "../src/github/evidence.js";
import { prPayload, startStack, type Stack } from "./github-stack.js";

let s: Stack;
beforeEach(async () => {
  s = await startStack();
  s.connectRepo();
});
afterEach(async () => {
  await s.stop();
});

const reviewCalls = () => s.engine.calls("POST", "/v1/contributions/review");
const finalizeCalls = () => s.engine.requests.filter((r) => /\/v1\/contributions\/[^/]+\/finalize$/.test(r.path));
const paymentish = () => s.engine.requests.filter((r) => r.path.startsWith("/v1/triggers") || r.path.startsWith("/v1/approvals") || finalizeCalls().includes(r));

describe("webhook intake", () => {
  it("10. rejects an invalid signature before any processing", async () => {
    const res = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-bad", "wrong-secret");
    expect(res.status).toBe(401);
    await s.pipeline.idle();
    expect(s.gh.requests).toHaveLength(0);
    expect(s.engine.requests.filter((r) => r.path.startsWith("/v1"))).toHaveLength(0);
  });

  it("11. PR opened triggers a review only: evidence is collected and submitted, nothing is paid", async () => {
    s.engine.mockScore = { total: 77, max: 100, breakdown: [{ category: "Correctness", score: 20, max: 30 }, { category: "Tests/CI", score: 25, max: 25 }] };
    s.engine.mockTier = "Tier 1";
    const res = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-open");
    expect(res.status).toBe(202);
    expect(res.json.status).toBe("accepted");
    await s.pipeline.idle();

    expect(reviewCalls()).toHaveLength(1);
    const body = reviewCalls()[0]!.body;
    expect(body).toMatchObject({ purpose: "provisional", repositoryId: "4242", prNumber: 42, headSha: "sha-head-1", supersedesReviewId: null });
    expect(body.evidence.pullRequest.headSha).toBe("sha-head-1");
    expect(finalizeCalls()).toHaveLength(0);
    expect(paymentish()).toHaveLength(0);
    // The legacy rule-trigger path was NOT also used for this repository.
    expect(s.engine.calls("POST", "/v1/triggers")).toHaveLength(0);

    const msg = s.sent.find((m) => m.chatId === "1001" && m.html.includes("reviewed"))!;
    expect(msg.html).toContain("Correctness: 20/30");
    expect(msg.html).toContain("Total: 77/100"); // straight from the engine response
    expect(msg.html).toContain("Tier 1");
    expect(msg.html).toContain("provisional");
    expect(msg.buttons!.flat()[0]!.data).toMatch(/^rv:/);
  });

  it("12. a synchronize event supersedes the earlier review", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    const first = s.store.latestReviewFor("4242", 42)!;

    s.gh.setPr("acme/app", 42, { headSha: "sha-head-2" });
    await s.deliver("pull_request", prPayload({ action: "synchronize", headSha: "sha-head-2" }), "d2");
    await s.pipeline.idle();

    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]!.body).toMatchObject({ headSha: "sha-head-2", supersedesReviewId: first.reviewId });
    const second = s.store.latestReviewFor("4242", 42)!;
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(s.store.getReview(first.reviewId)!.supersededBy).toBe(second.reviewId);
    expect(s.engine.reviews.get(first.reviewId)!.status).toBe("superseded");
    expect(finalizeCalls()).toHaveLength(0);
  });

  it("13. a merged PR re-fetches from GitHub, re-collects final evidence and requests finalization", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: "sha-head-1", merged: true });
    const before = s.gh.calls("GET", "/repos/acme/app/pulls/42").length;

    const res = await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    expect(res.status).toBe(202);
    await s.pipeline.idle();

    expect(s.gh.calls("GET", "/repos/acme/app/pulls/42").length).toBeGreaterThan(before); // authoritative re-read
    expect(finalizeCalls()).toHaveLength(1);
    const f = finalizeCalls()[0]!.body;
    expect(f).toMatchObject({ expectedHeadSha: "sha-head-1", mergedAt: "2026-11-04T12:00:00Z", idempotencyKey: "d-merge:finalize" });
    expect(f.evidence).toMatchObject({ purpose: "final" });
    expect(f.evidence.pullRequest.merged).toBe(true);
    // Not delivered yet according to the engine -> the bot must not claim it.
    const last = s.sent.at(-1)!.html;
    expect(last).toContain("merged");
    expect(last).toContain("Waiting for your approval");
    expect(last).not.toMatch(/delivered/i);
  });

  it("13b. claims delivery only when the engine confirms it with an invoice", async () => {
    s.engine.mockFinalStatus = "delivered";
    s.engine.mockTier = "Tier 2";
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: "sha-head-1", merged: true });
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    await s.pipeline.idle();
    const last = s.sent.at(-1)!.html;
    expect(last).toContain("Bounty delivered.");
    expect(last).toContain("PR: #42");
    expect(last).toContain("Bounty tier: Tier 2");
    expect(last).toContain("Bitrefill invoice: <code>MOCK-INV-BOUNTY</code>");
  });

  it("13c. if the final commit was never reviewed, it is reviewed before finalizing", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    // A new commit landed and the PR was merged; the synchronize webhook was lost.
    s.gh.setPr("acme/app", 42, { headSha: "sha-head-9", merged: true });
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true, headSha: "sha-head-9" }), "d-merge");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]!.body).toMatchObject({ purpose: "final", headSha: "sha-head-9" });
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0]!.body.expectedHeadSha).toBe("sha-head-9");
  });

  it("14. an unmerged close never triggers finalization or payment, nor does a payload that GitHub's API contradicts", async () => {
    const closed = await s.deliver("pull_request", prPayload({ action: "closed", merged: false }), "d-closed");
    expect(closed.json.reason).toBe("closed_unmerged");
    // Payload claims merged, but GitHub's authoritative answer says it is not.
    const forged = await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-forged");
    expect(forged.status).toBe(202);
    await s.pipeline.idle();
    expect(finalizeCalls()).toHaveLength(0);
    expect(paymentish()).toHaveLength(0);
    expect(reviewCalls()).toHaveLength(0);
  });

  it("18. duplicate deliveries are idempotent", async () => {
    const a = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-same");
    await s.pipeline.idle();
    const b = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-same");
    expect(a.json.status).toBe("accepted");
    expect(b.json.status).toBe("duplicate");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(1);
    // A different delivery for the same head SHA doesn't create another review either.
    await s.deliver("pull_request", prPayload({ action: "reopened" }), "d-other");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(1);
  });

  it("a failed processing run is not marked done, so GitHub's redelivery can retry it", async () => {
    await s.engine.stop();
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d-retry");
    await s.pipeline.idle();
    expect(s.store.hasProcessed("d-retry")).toBe(false);
    expect(s.sent.at(-1)!.html).toContain("couldn't finish processing");
    await s.engine.start(Number(new URL(s.engine.url).port));
    const again = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-retry");
    expect(again.json.status).toBe("accepted");
    await s.pipeline.idle();
    expect(s.store.hasProcessed("d-retry")).toBe(true);
  });

  it("repositories that aren't connected keep the legacy rule-trigger path", async () => {
    const legacy = { ...prPayload({ action: "closed", merged: true, repoId: 9999 }), installation: undefined };
    const res = await s.deliver("pull_request", { ...legacy, pull_request: { ...legacy.pull_request, number: 5, user: { login: "contrib" }, labels: [{ name: "x" }] } }, "d-legacy");
    expect(res.status).toBe(202);
    expect(s.engine.calls("POST", "/v1/triggers/github")).toHaveLength(1);
    expect(reviewCalls()).toHaveLength(0);
  });

  it("revoked access: installation deleted -> repository disabled, engine told, owner notified, later PRs ignored", async () => {
    s.engine.bountyRules.set("r1", { id: "r1", status: "active", repositoryId: "4242", ownerChatId: "1001" });
    const res = await s.deliver("installation", { action: "deleted", installation: { id: 9001 } }, "d-uninstall");
    expect(res.status).toBe(202);
    await s.pipeline.idle();
    expect(s.store.getRepo("4242")!.status).toBe("revoked");
    expect(s.engine.bountyRules.get("r1").status).toBe("paused");
    expect(s.engine.calls("POST", "/v1/repositories/4242/disconnect")).toHaveLength(1);
    expect(s.sent.at(-1)!.html).toContain("access");
    expect(s.sent.at(-1)!.html).toContain("was removed");

    const later = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-after");
    expect(later.json.reason).toBe("repository_revoked");
    expect(reviewCalls()).toHaveLength(0);
    expect(s.engine.calls("POST", "/v1/triggers/github")).toHaveLength(0);

    // Removing a single repository from a live installation works the same way.
    s.store.setRepo({ repositoryId: "4242", installationId: "9001", fullName: "acme/app", ownerChatId: "1001", status: "connected" });
    await s.deliver("installation_repositories", { action: "removed", installation: { id: 9001 }, repositories_removed: [{ id: 4242 }] }, "d-removed");
    await s.pipeline.idle();
    expect(s.store.getRepo("4242")!.status).toBe("revoked");
  });

  it("user revoking app authorization unlinks them", async () => {
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    s.engine.links.set("2002", { telegramUserId: "2002", githubUserId: "6001" });
    await s.deliver("github_app_authorization", { action: "revoked", sender: { id: 6001 } }, "d-revoke");
    await s.pipeline.idle();
    expect(s.store.getLink("2002")).toBeUndefined();
    expect(s.engine.links.has("2002")).toBe(false);
    expect(s.sent.at(-1)).toMatchObject({ chatId: "2002" });
  });
});

describe("evidence collector", () => {
  const collect = (limits = {}) => collectPrEvidence(s.github, { installationId: "9001", repositoryFullName: "acme/app", prNumber: 42, purpose: "provisional", limits });

  it("15. normalizes files, commits, reviews, checks and linked issues from the API (never the PR body)", async () => {
    s.gh.branchRules.set("acme/app:main", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "lint" }] } }]);
    const ev = await collect();
    expect(ev.repository).toEqual({ id: "4242", fullName: "acme/app" });
    expect(ev.installationId).toBe("9001");
    expect(ev.author).toEqual({ githubUserId: "6001", login: "contrib" });
    expect(ev.pullRequest).toMatchObject({ number: 42, headSha: "sha-head-1", baseSha: "sha-base", merged: false, labels: ["reward-ready"] });
    expect(ev.files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 20, 2],
      ["test/a.test.ts", "added", 10, 0],
      ["logo.png", "added", 0, 0],
    ]);
    expect(ev.files[0]!.patch).toContain("@@");
    expect(ev.files[2]).toMatchObject({ patch: null, patchOmittedReason: "binary_or_empty" });
    expect(ev.commits).toEqual([{ sha: "c1", authorGithubUserId: "6001", authorLogin: "contrib", messageFirstLine: "feat: add", date: "2026-11-03T10:00:00Z" }]);
    expect(ev.reviews.approvedBy).toEqual(["maint"]);
    expect(ev.checks.state).toBe("passing");
    expect(ev.checks.runs).toEqual([{ id: 1, name: "ci", status: "completed", conclusion: "success", appSlug: "github-actions" }]);
    expect(ev.checks.requiredChecks).toEqual([{ context: "ci", state: "success" }, { context: "lint", state: "missing" }]);
    expect(ev.linkedIssues).toEqual([{ number: 7, state: "open", labels: ["bug"], untrustedTitle: "Bug 7" }]);
    expect(JSON.stringify(ev)).not.toContain("Closes #7"); // the PR description is not forwarded
    expect(ev.untrustedFields).toContain("pullRequest.title");
    // Everything came from installation-token calls, never from the webhook payload.
    const tokens = s.gh.requests.filter((r) => r.path.startsWith("/repos/")).map((r) => r.authorization);
    expect(tokens.every((t) => /ghs_mock/.test(t ?? ""))).toBe(true);
  });

  it("16. missing or unreadable checks are reported honestly, never assumed to pass", async () => {
    s.gh.checkRuns.set("acme/app@sha-head-1", []);
    const none = await collect();
    expect(none.checks.state).toBe("none");
    expect(none.completeness.complete).toBe(false);
    expect(none.completeness.issues.map((i) => i.code)).toContain("checks_missing");

    s.gh.checkRuns.set("acme/app@sha-head-1", "forbidden");
    const blocked = await collect();
    expect(blocked.checks.state).toBe("unavailable");
    expect(blocked.completeness.issues.map((i) => i.code)).toContain("checks_unavailable");

    s.gh.checkRuns.set("acme/app@sha-head-1", [{ id: 2, name: "ci", status: "in_progress", conclusion: null, app: { slug: "x" } }]);
    expect((await collect()).checks.state).toBe("pending");
    s.gh.checkRuns.set("acme/app@sha-head-1", [{ id: 3, name: "ci", status: "completed", conclusion: "failure", app: { slug: "x" } }]);
    expect((await collect()).checks.state).toBe("failing");
    // No ruleset readable -> required checks unknown, flagged.
    const ev = await collect();
    expect(ev.checks.requiredChecks).toBeNull();
    expect(ev.completeness.issues.map((i) => i.code)).toContain("required_checks_unknown");
  });

  it("17. large diffs are paginated, capped and flagged as truncated", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+x" }));
    s.gh.files.set("acme/app#42", many);
    const ev = await collect({ maxFiles: 120 });
    expect(ev.files).toHaveLength(120); // proves we went past the first 100-item page
    expect(ev.completeness.issues.map((i) => i.code)).toContain("files_truncated");
    expect(s.gh.calls("GET", "/repos/acme/app/pulls/42/files").length).toBeGreaterThanOrEqual(2);

    s.gh.files.set("acme/app#42", [
      { filename: "big.ts", status: "modified", additions: 5000, deletions: 0, changes: 5000, patch: "x".repeat(50_000) },
      { filename: "huge.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "y".repeat(9_000) },
      { filename: "late.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "z".repeat(9_000) },
      { filename: "toolarge.bin", status: "modified", additions: 0, deletions: 0, changes: 900 },
    ]);
    const capped = await collect({ maxPatchBytesPerFile: 10_000, maxDiffBytes: 20_000 });
    expect(capped.files[0]).toMatchObject({ patchTruncated: true });
    expect(Buffer.byteLength(capped.files[0]!.patch!)).toBeLessThanOrEqual(10_000);
    expect(capped.files[2]).toMatchObject({ patch: null, patchOmittedReason: "diff_budget" });
    expect(capped.files[3]).toMatchObject({ patch: null, patchOmittedReason: "too_large" });
    expect(capped.completeness.complete).toBe(false);
    expect(capped.completeness.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["diff_truncated", "patch_unavailable"]));
  });

  it("reports GitHub rate limiting instead of inventing data", async () => {
    s.gh.rateLimited = true;
    const ev = await collect();
    expect(ev.pullRequest.number).toBe(42); // the PR itself was still readable
    expect(ev.files).toEqual([]);
    expect(ev.commits).toEqual([]);
    expect(ev.completeness.complete).toBe(false);
    expect(ev.completeness.issues.map((i) => i.code)).toContain("rate_limited");
    expect(ev.checks.state).toBe("unavailable");
  });
});
