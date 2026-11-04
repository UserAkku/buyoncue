import { createHash } from "node:crypto";
import { z } from "zod";
import { EngineError } from "../engine/client.js";
import type { BountyEngineApi, ConnectedRepository, FinalizeResult, ReviewView } from "../engine/bounty-types.js";
import { code, esc } from "../html.js";
import type { Logger } from "../logger.js";
import type { Button } from "../bot/types.js";
import { type ReviewRecord, type StateStore } from "../state.js";
import { collectPrEvidence, type EvidenceIssue, type InstallationClientProvider } from "./evidence.js";
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
  label: z.object({ name: z.string() }).optional(),
  sender: z.object({ id: z.number() }).optional(),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().nullish(),
    draft: z.boolean().nullish(),
    head: z.object({ sha: z.string() }),
  }),
});

const InstallationPayload = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repositories_removed: z.array(z.object({ id: z.number() })).optional(),
});

const AuthorizationPayload = z.object({ action: z.string(), sender: z.object({ id: z.number() }) });

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "labeled"]);
/** Engine review states after which nothing further will happen without new evidence. */
const SETTLED = new Set(["REVIEWED", "NEEDS_REVIEW", "LOW_CONFIDENCE", "STALE"]);
/** Evidence younger than this is reused rather than re-submitted (the engine caps review attempts per PR). */
const REUSE_WINDOW_MS = 20 * 60_000;

export type Accepted = { handled: false } | { handled: true; status: "accepted" | "duplicate" | "ignored"; reason?: string };

type RepoRef = { repositoryId: string; installationId: string; fullName: string; ownerChatId?: string };
type Policy = NonNullable<ConnectedRepository["bountyRule"]>;

class SettledTimeout extends Error {}

/**
 * Turns verified GitHub App webhooks into engine calls.
 *  - opened / synchronize / reopened / labeled: collect evidence -> submit a REVIEW. Never pays.
 *  - closed + merged: re-fetch from GitHub, re-collect final evidence, review it, wait for the verdict,
 *    then ask the engine to finalize. The engine alone decides about and performs any purchase.
 */
export class GithubPipeline {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly watchers = new Map<string, symbol>();
  private readonly collect: typeof collectPrEvidence;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: PipelineDeps) {
    this.collect = d.collect ?? collectPrEvidence;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private nowDate = () => this.d.now?.() ?? new Date();

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
    let policy: Policy | null;
    try {
      policy = await this.policyFor(repo);
    } catch (err) {
      // The engine is the authority on the policy; without it nothing can be reviewed. Fail visibly so the delivery is retried.
      return this.schedule(deliveryId, async () => {
        throw err;
      });
    }
    if (!policy) return { handled: true, status: "ignored", reason: "no_policy" }; // connected but no bounty policy yet
    if (p.action === "closed") {
      // An unmerged close can never lead to payment, so skip all work. A merged close is re-verified via the API.
      if (p.pull_request.merged !== true) return { handled: true, status: "ignored", reason: "closed_unmerged" };
      return this.schedule(deliveryId, () => this.finalize(repo, p.pull_request.number, deliveryId));
    }
    if (p.action === "unlabeled" || p.action === "labeled") {
      // Only a label applied by the connected policy owner can authorize; it is bound to the head at this moment.
      if (policy.requiredLabel && p.label?.name === policy.requiredLabel) {
        if (p.action === "unlabeled") this.d.store.clearLabelAuth(repo.repositoryId, p.pull_request.number);
        else if (p.sender && policy.ownerGithubUserId && String(p.sender.id) === policy.ownerGithubUserId) {
          this.d.store.setLabelAuth(repo.repositoryId, p.pull_request.number, {
            actorGithubUserId: String(p.sender.id),
            headSha: p.pull_request.head.sha.toLowerCase(),
            label: policy.requiredLabel,
            authorizedAt: this.nowDate().toISOString(),
          });
        } else {
          this.d.logger.info("label_not_by_owner", { deliveryId, repositoryId: repo.repositoryId });
          return { handled: true, status: "ignored", reason: "label_not_by_owner" };
        }
      } else {
        return { handled: true, status: "ignored", reason: `action_${p.action}` };
      }
      if (p.action === "unlabeled") return { handled: true, status: "ignored", reason: "authorization_cleared" };
    }
    if (!REVIEW_ACTIONS.has(p.action)) return { handled: true, status: "ignored", reason: `action_${p.action}` };
    if (p.pull_request.draft === true) return { handled: true, status: "ignored", reason: "draft" };
    return this.schedule(deliveryId, () => this.review(repo, p.pull_request.number).then(() => undefined));
  }

  private schedule(deliveryId: string, job: () => Promise<void>): Accepted {
    if (this.d.store.hasProcessed(deliveryId) || this.inFlight.has(deliveryId)) return { handled: true, status: "duplicate" };
    this.inFlight.add(deliveryId);
    const run = (async () => {
      try {
        await job();
        this.d.store.markProcessed(deliveryId);
      } catch (err) {
        // Not marked processed: a GitHub redelivery retries. Engine idempotency and the PR award identity prevent double effects.
        const reason = err instanceof EngineError ? (err.code ?? err.kind) : "other";
        this.d.logger.error("github_event_failed", { deliveryId, kind: err instanceof EngineError ? err.kind : "other", code: reason });
        const hint = reason === "REVIEW_CALL_LIMIT" ? " The AI review attempt limit for this pull request was reached." : "";
        await this.d.notify(this.d.ownerChatId, `⚠️ I couldn't finish processing a GitHub event (delivery ${code(deliveryId.slice(0, 8))}).${hint} It can be redelivered from the app's Advanced tab.`).catch(() => {});
      } finally {
        this.inFlight.delete(deliveryId);
      }
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
    return { handled: true, status: "accepted" };
  }

  private async connectedRepo(repositoryId: string): Promise<(RepoRef & { ownerChatId: string }) | null> {
    const local = this.d.store.getRepo(repositoryId);
    if (local) return local.status === "connected" ? local : null;
    // Unknown locally (e.g. state file lost): ask the engine, then remember.
    try {
      for (const r of await this.d.engine.listRepositories(this.d.ownerChatId)) {
        this.d.store.setRepo({ repositoryId: r.repositoryId, installationId: r.installationId, fullName: r.fullName, ownerChatId: this.d.ownerChatId, status: "connected" });
      }
    } catch {
      return null;
    }
    const again = this.d.store.getRepo(repositoryId);
    return again?.status === "connected" ? again : null;
  }

  /** The repository's bounty policy as the engine holds it. Fresh on every use: the engine is the authority. */
  private async policyFor(repo: RepoRef & { ownerChatId: string }): Promise<Policy | null> {
    const repos = await this.d.engine.listRepositories(repo.ownerChatId);
    return repos.find((r) => r.repositoryId === repo.repositoryId)?.bountyRule ?? null;
  }

  // ------------------------------------------------------------------ review

  private async collectFor(repo: RepoRef & { ownerChatId: string }, prNumber: number) {
    const policy = await this.policyFor(repo);
    if (!policy) throw new Error("No bounty policy is configured for this repository");
    const collected = await this.collect(this.d.github, {
      installationId: repo.installationId,
      repositoryFullName: repo.fullName,
      prNumber,
      maintainerGithubUserId: policy.ownerGithubUserId ?? this.d.store.getLink(repo.ownerChatId)?.githubUserId ?? null,
      requiredLabel: policy.requiredLabel ?? null,
      labelAuthorization: this.d.store.getLabelAuth(repo.repositoryId, prNumber) ?? null,
      now: this.d.now,
    });
    if (collected.evidence.repositoryId !== repo.repositoryId) throw new Error("Evidence repository does not match the connected repository");
    return collected;
  }

  /** Content fingerprint that ignores the collection timestamp, so unchanged PRs don't burn review attempts. */
  private fingerprint(e: object): string {
    const { collectedAt: _ignored, ...rest } = e as Record<string, unknown>;
    return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
  }

  /**
   * Collects evidence and submits a review (reusing a recent identical one). Never initiates payment.
   * Exposed for /review. Returns immediately; the score arrives asynchronously.
   */
  async review(repo: RepoRef & { ownerChatId?: string }, prNumber: number): Promise<{ record: ReviewRecord; view: ReviewView; reused: boolean }> {
    const full = { ...repo, ownerChatId: repo.ownerChatId ?? this.d.store.getRepo(repo.repositoryId)?.ownerChatId ?? this.d.ownerChatId };
    const { evidence, issues } = await this.collectFor(full, prNumber);
    const fp = this.fingerprint(evidence);
    const prev = this.d.store.latestReviewFor(repo.repositoryId, prNumber);
    if (prev && prev.fingerprint === fp && Date.parse(evidence.collectedAt) - Date.parse(prev.createdAt) < REUSE_WINDOW_MS) {
      return { record: prev, view: await this.d.engine.getReview(prev.reviewId), reused: true };
    }
    const submitted = await this.d.engine.submitReview(evidence);
    const record = this.record(full, evidence, submitted.reviewId, fp, issues);
    this.d.store.addReview(record);
    if (prev) {
      this.d.store.supersede(prev.reviewId, submitted.reviewId); // new evidence invalidates the old assessment
      this.watchers.delete(prev.reviewId);
    }
    this.d.logger.info("review_submitted", { reviewId: submitted.reviewId, repositoryId: repo.repositoryId, prNumber, state: submitted.state, merged: evidence.merged });
    const view = await this.d.engine.getReview(submitted.reviewId);
    if (!evidence.merged) this.watch(record, view);
    return { record, view, reused: false };
  }

  private record(repo: RepoRef, e: { repositoryId: string; prNumber: number; headSha: string; authorGithubUserId: string; authorLogin: string; merged: boolean }, reviewId: string, fingerprint: string, issues: EvidenceIssue[]): ReviewRecord {
    return {
      reviewId,
      repositoryId: repo.repositoryId,
      repositoryFullName: repo.fullName,
      prNumber: e.prNumber,
      headSha: e.headSha,
      authorGithubId: e.authorGithubUserId,
      authorLogin: e.authorLogin,
      createdAt: this.nowDate().toISOString(),
      merged: e.merged,
      fingerprint,
      incompleteReasons: issues.map((i) => i.detail),
    };
  }

  private async waitSettled(reviewId: string, initial?: ReviewView): Promise<ReviewView> {
    let view = initial;
    const max = this.d.pollMaxAttempts ?? 60;
    for (let i = 0; i <= max; i++) {
      if (!view || !SETTLED.has(view.state)) {
        if (i > 0) await this.sleep(this.d.pollIntervalMs ?? 3000);
        try {
          view = await this.d.engine.getReview(reviewId);
        } catch {
          /* keep polling */
        }
      }
      if (view && SETTLED.has(view.state)) return view;
    }
    throw new SettledTimeout("The AI review did not finish in time");
  }

  /** Background: tell the maintainer once the provisional score exists. */
  private watch(record: ReviewRecord, initial: ReviewView): void {
    const token = Symbol(record.reviewId);
    this.watchers.set(record.reviewId, token);
    const run = (async () => {
      let view: ReviewView;
      try {
        view = await this.waitSettled(record.reviewId, initial);
      } catch {
        return;
      }
      if (this.watchers.get(record.reviewId) !== token) return; // superseded or replaced
      this.watchers.delete(record.reviewId);
      if (this.d.store.getReview(record.reviewId)?.supersededBy) return;
      await this.d.notify(this.d.ownerChatId, renderReview(view, record), [[{ text: "👁 View review", data: `rv:${record.reviewId}` }]]).catch(() => this.d.logger.warn("review_notify_failed", { reviewId: record.reviewId }));
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  // ---------------------------------------------------------------- finalize

  private async finalize(repo: RepoRef & { ownerChatId: string }, prNumber: number, deliveryId: string): Promise<void> {
    // Never trust the webhook payload for money: re-read the PR and its evidence from GitHub.
    const { evidence, issues } = await this.collectFor(repo, prNumber);
    if (!evidence.merged) {
      this.d.logger.info("finalize_skipped_not_merged", { deliveryId, prNumber });
      return;
    }
    // A fresh review of the merged PR, even if the head SHA is unchanged: final code, checks and approvals are verified, not inherited.
    const fp = this.fingerprint(evidence);
    let rec = this.d.store.latestReviewFor(repo.repositoryId, prNumber);
    if (!rec || rec.fingerprint !== fp) {
      const submitted = await this.d.engine.submitReview(evidence);
      const fresh = this.record(repo, evidence, submitted.reviewId, fp, issues);
      this.d.store.addReview(fresh);
      if (rec) this.d.store.supersede(rec.reviewId, submitted.reviewId);
      rec = fresh;
    }
    this.watchers.delete(rec.reviewId);
    const view = await this.waitSettled(rec.reviewId); // throws on timeout: the event is retried on redelivery

    const result = await this.d.engine.finalizeReview(rec.reviewId, {
      githubDeliveryId: deliveryId,
      repositoryId: repo.repositoryId,
      prNumber,
      headSha: evidence.headSha,
      merged: true,
    });
    this.d.store.markFinalized(rec.reviewId, this.nowDate().toISOString(), result.accepted ? result.purchaseId : null);
    this.d.logger.info("review_finalized", { reviewId: rec.reviewId, prNumber, accepted: result.accepted, reason: result.reason ?? null });

    const receipt = result.accepted && result.purchaseId ? await this.d.engine.getReceipt(result.purchaseId).catch(() => null) : null;
    const note = issues.length && evidence.evidenceTruncated ? `\n⚠️ Final evidence was incomplete: ${issues.map((i) => esc(i.detail)).join("; ")}` : "";
    await this.d.notify(this.d.ownerChatId, renderFinalization(result as FinalizeResult, receipt, view, rec) + note).catch(() => this.d.logger.warn("finalize_notify_failed", { reviewId: rec!.reviewId }));
  }

  // -------------------------------------------------------------- revocation

  private async handleRevocation(eventName: string, payload: unknown): Promise<void> {
    if (eventName === "github_app_authorization") {
      const p = AuthorizationPayload.safeParse(payload);
      if (!p.success || p.data.action !== "revoked") return;
      const tg = this.d.store.telegramUserForGithub(String(p.data.sender.id));
      if (!tg) return;
      // Engine first: if it can't be told, the local link stays and the event is retried on redelivery.
      await this.d.engine.unlinkGithub(tg);
      this.d.store.removeLink(tg);
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

  /** Stops all processing for a repository and pauses its standing spending rule. */
  async revokeRepository(repositoryId: string, reason: string): Promise<void> {
    const repo = this.d.store.getRepo(repositoryId);
    if (!repo || repo.status === "revoked") return;
    // Local hard stop first, so nothing more is collected or reviewed even if the engine is unreachable.
    this.d.store.setRepo({ ...repo, status: "revoked" });
    let paused = false;
    try {
      const rule = (await this.d.engine.listRepositories(repo.ownerChatId)).find((r) => r.repositoryId === repositoryId)?.bountyRule;
      if (!rule) paused = true;
      else if (rule.status.toLowerCase() === "paused") paused = true;
      else paused = (await this.d.engine.bountyRuleAction(rule.id, "pause", repo.ownerChatId)) !== null;
    } catch {
      this.d.logger.warn("pause_on_revoke_failed", { repositoryId });
    }
    this.d.logger.info("repository_revoked", { repositoryId, reason, paused });
    const tail = paused ? "I stopped processing its pull requests and paused its reward policy." : "I stopped processing its pull requests, but I could not confirm that the reward policy was paused. Pause it with /repositories.";
    await this.d.notify(repo.ownerChatId, `⚠️ GitHub access to ${code(repo.fullName)} was removed (${esc(reason)}). ${tail} Reconnect with /connectgithub.`).catch(() => {});
  }
}
