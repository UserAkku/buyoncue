import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPrEvidence } from "../src/github/evidence.js";
import { prPayload, sha, startStack, type Stack } from "./github-stack.js";

let s: Stack;
beforeEach(async () => {
  s = await startStack();
  s.connectRepo();
});
afterEach(async () => {
  await s.stop();
});

const A = sha("a");
const reviewCalls = () => s.engine.calls("POST", "/v1/contributions/review");
const finalizeCalls = () => s.engine.requests.filter((r) => /\/v1\/contributions\/[^/]+\/finalize$/.test(r.path));
const paymentish = () => s.engine.requests.filter((r) => r.path.startsWith("/v1/triggers") || r.path.startsWith("/v1/approvals") || finalizeCalls().includes(r));
/** Maintainer (GitHub ID 5001) applies the label: a signed `labeled` event bound to the head at that moment. */
const maintainerLabels = (headSha = A, id = "d-label") => s.deliver("pull_request", prPayload({ action: "labeled", label: "reward-ready", senderId: 5001, headSha }), id);

describe("webhook intake", () => {
  it("rejects an invalid signature before any processing", async () => {
    const res = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-bad", "wrong-secret");
    expect(res.status).toBe(401);
    await s.pipeline.idle();
    expect(s.gh.requests).toHaveLength(0);
    expect(s.engine.requests.filter((r) => r.path.startsWith("/v1"))).toHaveLength(0);
  });

  it("PR opened triggers a review only: canonical evidence is collected and submitted, nothing is paid", async () => {
    s.engine.mockScore = { score: 77, subscores: { correctness: 20, tests: 25, feedback: 17, maintainability: 10, security: 5 } };
    s.engine.mockCandidate = { tier: 1, minScore: 50, maxScore: 69, faceValueINR: 50, requiresApproval: false, enabled: true };
    const res = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-open");
    expect(res.status).toBe(202);
    expect(res.json.status).toBe("accepted");
    await s.pipeline.idle();

    expect(reviewCalls()).toHaveLength(1);
    const body = reviewCalls()[0]!.body;
    // The wire format is the engine's: numeric IDs, exact head SHA, merged=false.
    expect(body).toMatchObject({ installationId: 9001, repositoryId: 4242, repositoryFullName: "acme/app", prNumber: 42, headSha: A, authorGithubUserId: 6001, merged: false, repositoryPrivate: false });
    expect(finalizeCalls()).toHaveLength(0);
    expect(paymentish()).toHaveLength(0);
    expect(s.engine.calls("POST", "/v1/triggers")).toHaveLength(0); // legacy path not also used

    const msg = s.sent.find((m) => m.chatId === "1001" && m.html.includes("reviewed"))!;
    expect(msg.html).toContain("Correctness / issue alignment: 20/30");
    expect(msg.html).toContain("Total: 77/100"); // straight from the engine response
    expect(msg.html).toContain("Tier 1");
    expect(msg.html).toContain("provisional");
    expect(msg.buttons!.flat()[0]!.data).toMatch(/^rv:/);
  });

  it("a synchronize event submits the new head and supersedes the earlier review", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    const first = s.store.latestReviewFor("4242", 42)!;

    s.gh.setPr("acme/app", 42, { headSha: sha("d") });
    await s.deliver("pull_request", prPayload({ action: "synchronize", headSha: sha("d") }), "d2");
    await s.pipeline.idle();

    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]!.body.headSha).toBe(sha("d"));
    const second = s.store.latestReviewFor("4242", 42)!;
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(s.store.getReview(first.reviewId)!.supersededBy).toBe(second.reviewId);
    expect(s.engine.reviews.get(first.reviewId)!.state).toBe("STALE");
    expect(finalizeCalls()).toHaveLength(0);
  });

  it("draft PRs and unrelated actions are ignored; connected repos without a policy are ignored", async () => {
    expect((await s.deliver("pull_request", prPayload({ action: "opened", draft: true }), "d-draft")).json.reason).toBe("draft");
    expect((await s.deliver("pull_request", prPayload({ action: "edited" }), "d-edit")).json.reason).toBe("action_edited");
    s.engine.bountyRules.clear();
    expect((await s.deliver("pull_request", prPayload({ action: "opened" }), "d-nopolicy")).json.reason).toBe("no_policy");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(0);
  });

  it("only the connected maintainer's label authorizes, and only for the head it was applied to", async () => {
    // A contributor (or anyone else) applying the label authorizes nothing.
    const stranger = await s.deliver("pull_request", prPayload({ action: "labeled", label: "reward-ready", senderId: 6001 }), "d-stranger");
    expect(stranger.json.reason).toBe("label_not_by_owner");
    expect(s.store.getLabelAuth("4242", 42)).toBeUndefined();

    await maintainerLabels(A);
    await s.pipeline.idle();
    expect(s.store.getLabelAuth("4242", 42)).toMatchObject({ actorGithubUserId: "5001", headSha: A, label: "reward-ready" });
    // The seeded PR also carries a maintainer approval; remove it so only the label event can authorize.
    expect(reviewCalls().at(-1)!.body.maintainerAuthorization).toMatchObject({ actorGithubUserId: 5001, headSha: A, source: "github_api_label_event", verifiedWriteAccess: true });

    // A new commit: the stored label belongs to the old head and is NOT copied onto the new one.
    s.gh.reviews.set("acme/app#42", []);
    s.gh.setPr("acme/app", 42, { headSha: sha("d") });
    await s.deliver("pull_request", prPayload({ action: "synchronize", headSha: sha("d") }), "d-sync");
    await s.pipeline.idle();
    expect(reviewCalls().at(-1)!.body.maintainerAuthorization).toBeNull();
  });

  it("merged PR: re-fetches from GitHub, reviews the merged evidence, then asks the engine to finalize", async () => {
    await maintainerLabels(A);
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: A, merged: true });
    const before = s.gh.calls("GET", "/repos/acme/app/pulls/42").length;

    const res = await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    expect(res.status).toBe(202);
    await s.pipeline.idle();

    expect(s.gh.calls("GET", "/repos/acme/app/pulls/42").length).toBeGreaterThan(before); // authoritative re-read
    expect(reviewCalls().at(-1)!.body.merged).toBe(true);
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0]!.body).toEqual({ githubDeliveryId: "d-merge", repositoryId: 4242, prNumber: 42, headSha: A, merged: true });
    // Queued is not delivered: the bot must not claim a delivery.
    const last = s.sent.at(-1)!.html;
    expect(last).toContain("merged");
    expect(last).toContain("Reward authorized");
    expect(last).toContain("Queued");
    expect(last).not.toMatch(/delivered/i);
  });

  it("claims delivery only from a receipt with a delivered purchase, a real invoice and delivered orders", async () => {
    await maintainerLabels(A);
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: A, merged: true });
    // Purchase marked delivered, but no invoice and no individual order evidence: not claimed.
    s.engine.mockReceiptStatus = "DELIVERED";
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    await s.pipeline.idle();
    expect(s.sent.at(-1)!.html).not.toContain("Bounty delivered.");
  });

  it("states delivery when the receipt proves it", async () => {
    await maintainerLabels(A);
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: A, merged: true });
    s.engine.mockReceiptStatus = "DELIVERED";
    s.engine.mockReceiptInvoice = "MOCK-INV-BOUNTY";
    s.engine.mockReceiptOrders = [{ id: "o1", status: "delivered" }];
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    await s.pipeline.idle();
    expect(s.sent.at(-1)!.html).toContain("Bounty delivered.");
    expect(s.sent.at(-1)!.html).toContain("MOCK-INV-BOUNTY");
  });

  it("a final head that was never reviewed is reviewed before finalizing", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    // A new commit landed and the PR was merged; the synchronize webhook was lost.
    s.gh.setPr("acme/app", 42, { headSha: sha("9"), merged: true });
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true, headSha: sha("9") }), "d-merge");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]!.body).toMatchObject({ headSha: sha("9"), merged: true });
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0]!.body.headSha).toBe(sha("9"));
  });

  it("a hold from the engine is reported plainly with reasons, and nothing is claimed", async () => {
    s.engine.mockReasons = ["REQUIRED_CI_NOT_SUCCESSFUL"];
    s.engine.mockEligibility = "HOLD";
    s.gh.setPr("acme/app", 42, { headSha: A, merged: true });
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d-merge");
    await s.pipeline.idle();
    const last = s.sent.at(-1)!.html;
    expect(last).toContain("no reward");
    expect(last).toContain("required CI did not succeed");
  });

  it("an unmerged close never triggers finalization or payment, nor does a payload that GitHub's API contradicts", async () => {
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

  it("duplicate deliveries are idempotent, and unchanged PRs don't burn extra review attempts", async () => {
    const a = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-same");
    await s.pipeline.idle();
    const b = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-same");
    expect(a.json.status).toBe("accepted");
    expect(b.json.status).toBe("duplicate");
    await s.pipeline.idle();
    expect(reviewCalls()).toHaveLength(1);
    // A different delivery for identical evidence reuses the review instead of calling the model again.
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

  it("revoked access: installation deleted -> repository stopped, rule paused through the engine, owner told, later PRs ignored", async () => {
    const res = await s.deliver("installation", { action: "deleted", installation: { id: 9001 } }, "d-uninstall");
    expect(res.status).toBe(202);
    await s.pipeline.idle();
    expect(s.store.getRepo("4242")!.status).toBe("revoked");
    expect(s.engine.bountyRules.get("rule-1").status).toBe("paused");
    expect(s.engine.calls("POST", "/v1/rules/rule-1/pause")).toHaveLength(1);
    expect(s.sent.at(-1)!.html).toContain("was removed");
    expect(s.sent.at(-1)!.html).toContain("paused");

    const later = await s.deliver("pull_request", prPayload({ action: "opened" }), "d-after");
    expect(later.json.reason).toBe("repository_revoked");
    expect(reviewCalls()).toHaveLength(0);

    // Removing a single repository from a live installation works the same way.
    s.engine.bountyRules.get("rule-1").status = "enabled";
    s.store.setRepo({ repositoryId: "4242", installationId: "9001", fullName: "acme/app", ownerChatId: "1001", status: "connected" });
    await s.deliver("installation_repositories", { action: "removed", installation: { id: 9001 }, repositories_removed: [{ id: 4242 }] }, "d-removed");
    await s.pipeline.idle();
    expect(s.store.getRepo("4242")!.status).toBe("revoked");
    expect(s.engine.bountyRules.get("rule-1").status).toBe("paused");
  });

  it("revocation tells the owner honestly when the engine could not confirm the pause", async () => {
    await s.engine.stop();
    await s.deliver("installation", { action: "suspend", installation: { id: 9001 } }, "d-suspend");
    await s.pipeline.idle();
    expect(s.store.getRepo("4242")!.status).toBe("revoked"); // local hard stop still applies
    expect(s.sent.at(-1)!.html).toContain("could not confirm");
  });

  it("user revoking app authorization unlinks them in the engine and locally", async () => {
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    s.engine.links.set("2002", { telegramUserId: "2002", githubUserId: 6001, githubLogin: "contrib", revoked: false });
    await s.deliver("github_app_authorization", { action: "revoked", sender: { id: 6001 } }, "d-revoke");
    await s.pipeline.idle();
    expect(s.store.getLink("2002")).toBeUndefined();
    expect(s.engine.links.get("2002").revoked).toBe(true);
    expect(s.sent.at(-1)).toMatchObject({ chatId: "2002" });
  });

  it("if the engine cannot be told about an authorization revocation, the link stays and the event is retried", async () => {
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    await s.engine.stop();
    await s.deliver("github_app_authorization", { action: "revoked", sender: { id: 6001 } }, "d-revoke");
    await s.pipeline.idle();
    expect(s.store.getLink("2002")).toBeDefined();
    expect(s.store.hasProcessed("d-revoke")).toBe(false);
  });
});

describe("evidence collector", () => {
  const collect = (extra: Record<string, unknown> = {}, limits = {}) =>
    collectPrEvidence(s.github, { installationId: "9001", repositoryFullName: "acme/app", prNumber: 42, maintainerGithubUserId: "5001", requiredLabel: "reward-ready", limits, ...extra });

  it("normalizes the PR into the engine's exact schema, with CI bound to the head commit", async () => {
    s.gh.branchRules.set("acme/app:main", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    const { evidence: ev, issues } = await collect();
    expect(ev).toMatchObject({ installationId: "9001", repositoryId: "4242", repositoryFullName: "acme/app", repositoryPrivate: false, prNumber: 42, headSha: A, baseSha: sha("b"), authorGithubUserId: "6001", authorLogin: "contrib", authorIsBot: false, merged: false, labels: ["reward-ready"], evidenceTruncated: true, ciComplete: true });
    expect(ev.description).toBe("Closes #7");
    expect(ev.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.patch === null])).toEqual([
      ["src/a.ts", "modified", 20, 2, false],
      ["test/a.test.ts", "added", 10, 0, false],
      ["logo.png", "added", 0, 0, true],
    ]);
    expect(ev.commits).toEqual([{ sha: sha("c"), message: "feat: add\n\nbody" }]);
    expect(ev.checks).toEqual([{ id: 1, name: "ci", headSha: A, status: "completed", conclusion: "success", required: true }]);
    expect(ev.reviews).toEqual([{ id: 1, reviewerGithubUserId: "5001", headSha: A, state: "APPROVED", body: "Looks right to me.", feedbackResolved: true }]);
    expect(ev.linkedIssues).toEqual([{ number: 7, title: "Bug 7", body: "", state: "open" }]);
    expect(issues.map((i) => i.code)).toContain("patch_unavailable"); // the binary file has no diff: flagged, so the engine will HOLD
    // Everything came from installation-token calls, never from the webhook payload.
    const tokens = s.gh.requests.filter((r) => r.path.startsWith("/repos/")).map((r) => r.authorization);
    expect(tokens.every((t) => /ghs_mock/.test(t ?? ""))).toBe(true);
  });

  it("CI is never assumed: missing, pending, failing, unreadable and unknown-required checks are reported honestly", async () => {
    s.gh.checkRuns.set(`acme/app@${A}`, []);
    const none = await collect();
    expect(none.evidence.checks).toEqual([]);
    expect(none.evidence.ciComplete).toBe(false); // required "ci" never reported
    expect(none.issues.map((i) => i.code)).toContain("checks_missing");

    s.gh.checkRuns.set(`acme/app@${A}`, "forbidden");
    const blocked = await collect();
    expect(blocked.evidence.ciComplete).toBe(false);
    expect(blocked.issues.map((i) => i.code)).toContain("checks_unavailable");
    expect(blocked.evidence.evidenceTruncated).toBe(true);

    s.gh.checkRuns.set(`acme/app@${A}`, [{ id: 2, name: "ci", status: "in_progress", conclusion: null, app: { slug: "x" } }]);
    const pending = await collect();
    expect(pending.evidence.checks[0]).toMatchObject({ status: "in_progress", conclusion: null, required: true });
    s.gh.checkRuns.set(`acme/app@${A}`, [{ id: 3, name: "ci", status: "completed", conclusion: "failure", app: { slug: "x" } }]);
    expect((await collect()).evidence.checks[0]).toMatchObject({ status: "completed", conclusion: "failure", required: true });
    s.gh.checkRuns.set(`acme/app@${A}`, [{ id: 4, name: "ci", status: "completed", conclusion: "startup_failure", app: { slug: "x" } }]);
    expect((await collect()).evidence.checks[0]!.conclusion).toBe("failure");

    // No ruleset readable -> which checks are required is unknown -> CI cannot be called complete.
    s.gh.branchRules.delete("acme/app:main");
    s.gh.checkRuns.set(`acme/app@${A}`, [{ id: 1, name: "ci", status: "completed", conclusion: "success", app: { slug: "x" } }]);
    const unknown = await collect();
    expect(unknown.evidence.ciComplete).toBe(false);
    expect(unknown.evidence.checks[0]!.required).toBe(false);
    expect(unknown.issues.map((i) => i.code)).toContain("required_checks_unknown");
  });

  it("legacy commit statuses are included as checks with non-colliding IDs", async () => {
    s.gh.statuses.set(`acme/app@${A}`, [{ id: 77, context: "ci", state: "success" }]);
    s.gh.checkRuns.set(`acme/app@${A}`, []);
    const { evidence } = await collect();
    expect(evidence.checks).toEqual([{ id: 1_000_000_000_000_077, name: "ci", headSha: A, status: "completed", conclusion: "success", required: true }]);
    expect(evidence.ciComplete).toBe(true);
  });

  it("large diffs are paginated, capped and flagged as truncated", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+x" }));
    s.gh.files.set("acme/app#42", many);
    const big = await collect({}, { maxFiles: 120 });
    expect(big.evidence.files).toHaveLength(120); // proves we went past the first 100-item page
    expect(big.issues.map((i) => i.code)).toContain("files_truncated");
    expect(big.evidence.evidenceTruncated).toBe(true);
    expect(s.gh.calls("GET", "/repos/acme/app/pulls/42/files").length).toBeGreaterThanOrEqual(2);

    s.gh.files.set("acme/app#42", [
      { filename: "big.ts", status: "modified", additions: 5000, deletions: 0, changes: 5000, patch: "x".repeat(50_000) },
      { filename: "huge.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "y".repeat(9_000) },
      { filename: "late.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "z".repeat(9_000) },
      { filename: "toolarge.bin", status: "modified", additions: 0, deletions: 0, changes: 900 },
    ]);
    const capped = await collect({}, { maxPatchBytesPerFile: 10_000, maxDiffBytes: 20_000 });
    expect(capped.evidence.files[0]).toMatchObject({ patchTruncated: true });
    expect(Buffer.byteLength(capped.evidence.files[0]!.patch!)).toBeLessThanOrEqual(10_000);
    expect(capped.evidence.files[2]!.patch).toBeNull();
    expect(capped.evidence.files[3]!.patch).toBeNull();
    expect(capped.evidence.evidenceTruncated).toBe(true);
    expect(capped.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["diff_truncated", "patch_unavailable"]));
  });

  it("reports GitHub rate limiting instead of inventing data", async () => {
    s.gh.rateLimited = true;
    const { evidence, issues } = await collect();
    expect(evidence.prNumber).toBe(42); // the PR itself was still readable
    expect(evidence.files).toEqual([]);
    expect(evidence.commits).toEqual([]);
    expect(evidence.evidenceTruncated).toBe(true);
    expect(evidence.ciComplete).toBe(false);
    expect(issues.map((i) => i.code)).toContain("rate_limited");
  });

  it("flags bot authors and private repositories exactly as GitHub reports them", async () => {
    s.gh.setPr("acme/app", 42, { headSha: A, authorType: "Bot", isPrivate: true });
    const { evidence } = await collect();
    expect(evidence.authorIsBot).toBe(true);
    expect(evidence.repositoryPrivate).toBe(true);
  });

  describe("maintainer authorization", () => {
    it("is bound to the exact head: a label event for another head authorizes nothing", async () => {
      s.gh.reviews.set("acme/app#42", []);
      const stale = { actorGithubUserId: "5001", headSha: sha("f"), label: "reward-ready", authorizedAt: "2026-11-03T00:00:00Z" };
      expect((await collect({ labelAuthorization: stale })).evidence.maintainerAuthorization).toBeNull();
      const fresh = { ...stale, headSha: A };
      expect((await collect({ labelAuthorization: fresh })).evidence.maintainerAuthorization).toMatchObject({ source: "github_api_label_event", headSha: A, actorGithubUserId: "5001", verifiedWriteAccess: true });
    });

    it("never accepts anyone but the connected maintainer, or someone GitHub says lacks write access", async () => {
      s.gh.reviews.set("acme/app#42", []);
      const other = { actorGithubUserId: "6001", headSha: A, label: "reward-ready", authorizedAt: "2026-11-03T00:00:00Z" };
      expect((await collect({ labelAuthorization: other })).evidence.maintainerAuthorization).toBeNull();
      s.gh.roles.set("acme/app:maint", "read");
      const demoted = { ...other, actorGithubUserId: "5001" };
      const r = await collect({ labelAuthorization: demoted });
      expect(r.evidence.maintainerAuthorization).toBeNull();
    });

    it("the required label must actually be on the PR", async () => {
      s.gh.setPr("acme/app", 42, { headSha: A, labels: [] });
      const stored = { actorGithubUserId: "5001", headSha: A, label: "reward-ready", authorizedAt: "2026-11-03T00:00:00Z" };
      expect((await collect({ labelAuthorization: stored })).evidence.maintainerAuthorization).toBeNull();
    });

    it("an approving review by the maintainer on this exact head, with resolved feedback, can authorize", async () => {
      const ok = await collect();
      expect(ok.evidence.maintainerAuthorization).toMatchObject({ source: "github_api_review", headSha: A, actorGithubUserId: "5001" });
      // Unresolved review threads: the approval no longer counts.
      s.gh.threads.set("acme/app#42", [{ isResolved: false }]);
      const unresolved = await collect();
      expect(unresolved.evidence.reviews[0]!.feedbackResolved).toBe(false);
      expect(unresolved.evidence.maintainerAuthorization).toBeNull();
      // Thread data unreadable: treated as unresolved, and reported.
      s.gh.threads.delete("acme/app#42");
      s.gh.graphqlFails = true;
      const unreadable = await collect();
      expect(unreadable.evidence.maintainerAuthorization).toBeNull();
      expect(unreadable.issues.map((i) => i.code)).toContain("review_threads_unavailable");
      // An approval of an older commit is not an approval of this one.
      s.gh.graphqlFails = false;
      s.gh.reviews.set("acme/app#42", [{ id: 1, user: { id: 5001, login: "maint" }, state: "APPROVED", body: "", submitted_at: "2026-11-03T11:00:00Z", commit_id: sha("f") }]);
      expect((await collect()).evidence.maintainerAuthorization).toBeNull();
    });

    it("a later change request by the maintainer revokes the earlier approval", async () => {
      s.gh.reviews.set("acme/app#42", [
        { id: 1, user: { id: 5001, login: "maint" }, state: "APPROVED", body: "", submitted_at: "2026-11-03T11:00:00Z", commit_id: A },
        { id: 2, user: { id: 5001, login: "maint" }, state: "CHANGES_REQUESTED", body: "wait", submitted_at: "2026-11-03T12:00:00Z", commit_id: A },
      ]);
      const r = await collect();
      expect(r.evidence.maintainerAuthorization).toBeNull();
      expect(r.evidence.reviews.find((x) => x.id === 2)).toMatchObject({ state: "CHANGES_REQUESTED", feedbackResolved: false });
    });
  });
});
