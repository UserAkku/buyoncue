import { z } from "zod";
import { EngineError } from "../engine/client.js";
import type { BountyEngineApi, ContributionReview } from "../engine/bounty-types.js";
import { code, esc } from "../html.js";
import type { Logger } from "../logger.js";
import type { Button } from "../bot/types.js";
import { type ReviewRecord, type StateStore } from "../state.js";
import { collectPrEvidence, type InstallationClientProvider, type PrEvidence } from "./evidence.js";
import { renderFinalization, renderReview } from "./format.js";

export interface PipelineDeps {
  github: InstallationClientProvider;
  engine: BountyEngineApi;
  store: StateStore;
  logger: Logger;
  ownerChatId: string;
  /** Sends HTML to a Telegram chat. Must throw if Telegram did not accept it. */
  notify: (chatId: string, html: string, buttons?: Button[][]) => Promise<void>;
  collect?: typeof collectPrEvidence;
  /** Review polling. Tests shrink these. */
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const PullRequestPayload = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ id: z.number(), full_name: z.string() }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().nullish(),
    head: z.object({ sha: z.string() }),
  }),
});

const InstallationPayload = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repositories_removed: z.array(z.object({ id: z.number() })).optional(),
});

const AuthorizationPayload = z.object({ action: z.string(), sender: z.object({ id: z.number() }) });

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const TERMINAL = new Set(["completed", "failed", "error", "superseded", "rejected"]);

export type Accepted = { handled: false } | { handled: true; status: "accepted" | "duplicate" | "ignored"; reason?: string };

/**
 * Turns verified GitHub App webhooks into engine calls.
 *  - opened / synchronize / reopened: collect evidence -> submit a REVIEW. Never pays.
 *  - closed + merged: re-fetch from GitHub, re-collect final evidence -> request FINALIZATION.
 *    The engine alone decides about and performs any purchase.
 */
export class GithubPipeline {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly watchers = new Map<string, symbol>();
  private repoCache: { at: number; ids: Set<string> } | null = null;
  private readonly collect: typeof collectPrEvidence;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: PipelineDeps) {
    this.collect = d.collect ?? collectPrEvidence;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when all background work scheduled so far is done. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Called after the HMAC check. Decides synchronously whether this pipeline owns the event and,
   * if so, de-duplicates by X-GitHub-Delivery and processes in the background.
   */
  async accept(eventName: string | undefined, deliveryId: string, payload: unknown): Promise<Accepted> {
    if (eventName === "installation" || eventName === "installation_repositories" || eventName === "github_app_authorization") {
      return this.schedule(deliveryId, () => this.handleRevocation(eventName, payload));
    }
    if (eventName !== "pull_request") return { handled: false };

    const parsed = PullRequestPayload.safeParse(payload);
    if (!parsed.success) return { handled: false };
    const p = parsed.data;
    if (this.d.store.getRepo(String(p.repository.id))?.status === "revoked") {
      return { handled: true, status: "ignored", reason: "repository_revoked" }; // access was removed: do nothing at all
    }
    const repo = await this.connectedRepo(String(p.repository.id));
    if (!repo) return { handled: false }; // not a bounty repository: legacy path may apply
    if (p.installation && String(p.installation.id) !== repo.installationId) {
      this.d.logger.warn("webhook_installation_mismatch", { deliveryId, repositoryId: repo.repositoryId });
      return { handled: true, status: "ignored", reason: "installation_mismatch" };
    }
    if (p.action === "closed") {
      // An unmerged close can never lead to payment, so skip all work. A merged close is re-verified via the API.
      if (p.pull_request.merged !== true) return { handled: true, status: "ignored", reason: "closed_unmerged" };
      return this.schedule(deliveryId, () => this.finalize(repo, p.pull_request.number, deliveryId));
    }
    if (!REVIEW_ACTIONS.has(p.action)) return { handled: true, status: "ignored", reason: `action_${p.action}` };
    return this.schedule(deliveryId, () => this.review(repo, p.pull_request.number, deliveryId, "provisional").then(() => undefined));
  }

  private schedule(deliveryId: string, job: () => Promise<void>): Accepted {
    if (this.d.store.hasProcessed(deliveryId) || this.inFlight.has(deliveryId)) return { handled: true, status: "duplicate" };
    this.inFlight.add(deliveryId);
    const run = (async () => {
      try {
        await job();
        this.d.store.markProcessed(deliveryId);
      } catch (err) {
        // Not marked processed: a GitHub redelivery retries. Engine idempotency keys prevent double effects.
        this.d.logger.error("github_event_failed", { deliveryId, kind: err instanceof EngineError ? err.kind : "other" });
        await this.d.notify(this.d.ownerChatId, `⚠️ I couldn't finish processing a GitHub event (delivery ${code(deliveryId.slice(0, 8))}). It can be redelivered from the app's Advanced tab.`).catch(() => {});
      } finally {
        this.inFlight.delete(deliveryId);
      }
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
    return { handled: true, status: "accepted" };
  }

  private async connectedRepo(repositoryId: string) {
    const local = this.d.store.getRepo(repositoryId);
    if (local) return local.status === "connected" ? local : null;
    // Unknown locally (e.g. state file lost): ask the engine once per 30s, then remember.
    const now = Date.now();
    if (!this.repoCache || now - this.repoCache.at > 30_000) {
      try {
        const repos = await this.d.engine.listRepositories(this.d.ownerChatId);
        for (const r of repos) {
          if ((r.status ?? "connected") === "connected") {
            this.d.store.setRepo({ repositoryId: r.repositoryId, installationId: r.installationId, fullName: r.fullName, ownerChatId: this.d.ownerChatId, status: "connected" });
          }
        }
        this.repoCache = { at: now, ids: new Set(repos.map((r) => r.repositoryId)) };
      } catch {
        return null;
      }
    }
    const again = this.d.store.getRepo(repositoryId);
    return again?.status === "connected" ? again : null;
  }

  // ------------------------------------------------------------------ review

  /** Collects evidence and submits a review. Never initiates payment. Exposed for /review. */
  async review(repo: { repositoryId: string; installationId: string; fullName: string }, prNumber: number, key: string, purpose: "provisional" | "final"): Promise<{ record: ReviewRecord; review: ContributionReview; reused: boolean }> {
    const evidence = await this.collect(this.d.github, { installationId: repo.installationId, repositoryFullName: repo.fullName, prNumber, purpose, now: this.d.now });
    this.assertSameRepo(evidence, repo);
    const prev = this.d.store.latestReviewFor(repo.repositoryId, prNumber);
    if (prev && prev.headSha === evidence.pullRequest.headSha && !prev.supersededBy && prev.purpose === purpose) {
      return { record: prev, review: await this.d.engine.getReview(prev.reviewId), reused: true };
    }
    const review = await this.d.engine.submitReview({
      idempotencyKey: `${key}:review`,
      purpose,
      repositoryId: repo.repositoryId,
      prNumber,
      headSha: evidence.pullRequest.headSha,
      supersedesReviewId: prev && !prev.finalizedAt ? prev.reviewId : null,
      evidence,
    });
    const record: ReviewRecord = {
      reviewId: review.reviewId,
      repositoryId: repo.repositoryId,
      repositoryFullName: repo.fullName,
      prNumber,
      headSha: evidence.pullRequest.headSha,
      authorGithubId: evidence.author.githubUserId,
      authorLogin: evidence.author.login,
      deliveryId: key,
      createdAt: (this.d.now?.() ?? new Date()).toISOString(),
      purpose,
      incompleteReasons: evidence.completeness.issues.map((i) => i.detail),
    };
    this.d.store.addReview(record);
    if (prev && !prev.finalizedAt) {
      // A new commit invalidates the old assessment: it must never be shown or paid on.
      this.d.store.supersede(prev.reviewId, review.reviewId);
      this.watchers.delete(prev.reviewId);
    }
    this.d.logger.info("review_submitted", { reviewId: review.reviewId, repositoryId: repo.repositoryId, prNumber, status: review.status, purpose });
    if (purpose === "provisional") this.watch(record, review);
    return { record, review, reused: false };
  }

  private assertSameRepo(evidence: PrEvidence, repo: { repositoryId: string }): void {
    if (evidence.repository.id !== repo.repositoryId) throw new Error("Evidence repository does not match the connected repository");
  }

  /** Background: tell the maintainer once the provisional score exists. */
  private watch(record: ReviewRecord, initial: ContributionReview): void {
    const token = Symbol(record.reviewId);
    this.watchers.set(record.reviewId, token);
    const run = (async () => {
      let review = initial;
      const max = this.d.pollMaxAttempts ?? 60;
      for (let i = 0; i <= max; i++) {
        if (this.watchers.get(record.reviewId) !== token) return; // superseded or replaced
        if (TERMINAL.has(review.status.toLowerCase())) break;
        await this.sleep(this.d.pollIntervalMs ?? 3000);
        try {
          review = await this.d.engine.getReview(record.reviewId);
        } catch {
          /* keep polling */
        }
      }
      if (this.watchers.get(record.reviewId) !== token) return;
      this.watchers.delete(record.reviewId);
      if (this.d.store.getReview(record.reviewId)?.supersededBy) return;
      await this.d.notify(this.d.ownerChatId, renderReview(review, record), [[{ text: "👁 View review", data: `rv:${record.reviewId}` }]]).catch(() => this.d.logger.warn("review_notify_failed", { reviewId: record.reviewId }));
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  // ---------------------------------------------------------------- finalize

  private async finalize(repo: { repositoryId: string; installationId: string; fullName: string }, prNumber: number, deliveryId: string): Promise<void> {
    // Never trust the webhook payload for money: re-read the PR and its evidence from GitHub.
    const evidence = await this.collect(this.d.github, { installationId: repo.installationId, repositoryFullName: repo.fullName, prNumber, purpose: "final", now: this.d.now });
    this.assertSameRepo(evidence, repo);
    if (!evidence.pullRequest.merged || !evidence.pullRequest.mergedAt) {
      this.d.logger.info("finalize_skipped_not_merged", { deliveryId, prNumber });
      return;
    }
    const headSha = evidence.pullRequest.headSha;
    let rec = this.d.store.latestReviewFor(repo.repositoryId, prNumber);
    if (!rec || rec.headSha !== headSha || rec.supersededBy) {
      // The final commit has not been analysed yet: review it first.
      const r = await this.d.engine.submitReview({
        idempotencyKey: `${deliveryId}:review`,
        purpose: "final",
        repositoryId: repo.repositoryId,
        prNumber,
        headSha,
        supersedesReviewId: rec && !rec.finalizedAt ? rec.reviewId : null,
        evidence,
      });
      const fresh: ReviewRecord = {
        reviewId: r.reviewId,
        repositoryId: repo.repositoryId,
        repositoryFullName: repo.fullName,
        prNumber,
        headSha,
        authorGithubId: evidence.author.githubUserId,
        authorLogin: evidence.author.login,
        deliveryId,
        createdAt: (this.d.now?.() ?? new Date()).toISOString(),
        purpose: "final",
        incompleteReasons: evidence.completeness.issues.map((i) => i.detail),
      };
      this.d.store.addReview(fresh);
      if (rec && !rec.finalizedAt) this.d.store.supersede(rec.reviewId, r.reviewId);
      rec = fresh;
    }
    this.watchers.delete(rec.reviewId);
    const result = await this.d.engine.finalizeReview(rec.reviewId, {
      idempotencyKey: `${deliveryId}:finalize`,
      expectedHeadSha: headSha,
      mergedAt: evidence.pullRequest.mergedAt,
      evidence,
    });
    this.d.store.markFinalized(rec.reviewId, (this.d.now?.() ?? new Date()).toISOString());
    this.d.logger.info("review_finalized", { reviewId: rec.reviewId, prNumber, status: result.finalization?.status ?? result.status });
    const note = evidence.completeness.complete ? "" : `\n⚠️ Final evidence was incomplete: ${evidence.completeness.issues.map((i) => esc(i.detail)).join("; ")}`;
    await this.d.notify(this.d.ownerChatId, renderFinalization(result, rec) + note).catch(() => this.d.logger.warn("finalize_notify_failed", { reviewId: rec!.reviewId }));
  }

  // -------------------------------------------------------------- revocation

  private async handleRevocation(eventName: string, payload: unknown): Promise<void> {
    if (eventName === "github_app_authorization") {
      const p = AuthorizationPayload.safeParse(payload);
      if (!p.success || p.data.action !== "revoked") return;
      const tg = this.d.store.telegramUserForGithub(String(p.data.sender.id));
      if (!tg) return;
      this.d.store.removeLink(tg);
      await this.d.engine.unlinkGithub(tg).catch(() => this.d.logger.warn("unlink_on_revoke_failed"));
      await this.d.notify(tg, "🔓 GitHub reported that you revoked this app's authorization, so I removed your GitHub link. Use /linkgithub to link again.").catch(() => {});
      return;
    }
    const p = InstallationPayload.safeParse(payload);
    if (!p.success) return;
    const installationId = String(p.data.installation.id);
    let affected: string[] = [];
    if (eventName === "installation" && ["deleted", "suspend"].includes(p.data.action)) {
      affected = this.d.store.listRepos().filter((r) => r.installationId === installationId && r.status === "connected").map((r) => r.repositoryId);
    } else if (eventName === "installation_repositories" && p.data.action === "removed") {
      affected = (p.data.repositories_removed ?? []).map((r) => String(r.id)).filter((id) => this.d.store.getRepo(id)?.installationId === installationId && this.d.store.getRepo(id)?.status === "connected");
    }
    for (const id of affected) await this.revokeRepository(id, eventName);
  }

  async revokeRepository(repositoryId: string, reason: string): Promise<void> {
    const repo = this.d.store.getRepo(repositoryId);
    if (!repo || repo.status === "revoked") return;
    this.d.store.setRepo({ ...repo, status: "revoked" });
    // Stop spending first (best effort), then tell the engine the repository is gone.
    try {
      const listed = await this.d.engine.listRepositories(repo.ownerChatId);
      const rule = listed.find((r) => r.repositoryId === repositoryId)?.bountyRule;
      if (rule) await this.d.engine.bountyRuleAction(rule.id, "pause", repo.ownerChatId);
    } catch {
      this.d.logger.warn("pause_on_revoke_failed", { repositoryId });
    }
    await this.d.engine.disconnectRepository(repositoryId, reason).catch(() => this.d.logger.warn("disconnect_on_revoke_failed", { repositoryId }));
    this.d.logger.info("repository_revoked", { repositoryId, reason });
    await this.d.notify(repo.ownerChatId, `⚠️ GitHub access to ${code(repo.fullName)} was removed (${esc(reason)}). I stopped processing its pull requests and asked the engine to pause rewards. Reconnect with /connectgithub.`).catch(() => {});
  }
}
