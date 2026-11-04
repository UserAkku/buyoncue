import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Small durable state for the GitHub integration: webhook idempotency, a local index of
 * reviews this service submitted, and identity links (cache of what the engine holds).
 * It never stores OAuth tokens, installation tokens, private keys or redemption data.
 */
const ReviewRecordSchema = z.object({
  reviewId: z.string(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  prNumber: z.number().int(),
  headSha: z.string(),
  authorGithubId: z.string(),
  authorLogin: z.string(),
  createdAt: z.string(),
  /** True when this review was built from the merged PR (the only kind that can be finalized). */
  merged: z.boolean().default(false),
  /** Evidence completeness as measured by the collector at submit time. */
  incompleteReasons: z.array(z.string()).default([]),
  /** Hash of the submitted evidence (without its timestamp), used to avoid re-submitting unchanged PRs. */
  fingerprint: z.string().default(""),
  supersededBy: z.string().nullish(),
  finalizedAt: z.string().nullish(),
  /** The engine purchase created for this PR, if its reward was authorized. */
  purchaseId: z.string().nullish(),
});

/** A maintainer's label event recorded from a signed webhook: binds the label to the PR head at that moment. */
const LabelAuthSchema = z.object({ actorGithubUserId: z.string(), headSha: z.string(), label: z.string(), authorizedAt: z.string() });

const LinkSchema = z.object({ githubUserId: z.string(), githubLogin: z.string(), linkedAt: z.string() });

const RepoSchema = z.object({
  repositoryId: z.string(),
  installationId: z.string(),
  fullName: z.string(),
  ownerChatId: z.string(),
  status: z.enum(["connected", "revoked"]),
});

const StateSchema = z.object({
  version: z.literal(1).default(1),
  processedDeliveries: z.array(z.string()).default([]),
  reviews: z.record(z.string(), ReviewRecordSchema).default({}),
  latestByPr: z.record(z.string(), z.string()).default({}),
  links: z.record(z.string(), LinkSchema).default({}),
  labelAuths: z.record(z.string(), LabelAuthSchema).default({}),
  repos: z.record(z.string(), RepoSchema).default({}),
});

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type LabelAuthRecord = z.infer<typeof LabelAuthSchema>;
export type LinkRecord = z.infer<typeof LinkSchema>;
export type RepoRecord = z.infer<typeof RepoSchema>;
type StateData = z.infer<typeof StateSchema>;

const MAX_DELIVERIES = 2000;
const MAX_REVIEWS = 500;

export const prKey = (repositoryId: string, prNumber: number) => `${repositoryId}#${prNumber}`;

export class StateStore {
  private data: StateData;

  /** `file = null` keeps everything in memory (tests). */
  constructor(private readonly file: string | null = null) {
    this.data = StateSchema.parse({});
    if (file) {
      try {
        this.data = StateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`State file ${file} is unreadable or corrupt; fix or remove it`);
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // -- webhook idempotency
  hasProcessed(deliveryId: string): boolean {
    return this.data.processedDeliveries.includes(deliveryId);
  }
  markProcessed(deliveryId: string): void {
    if (this.hasProcessed(deliveryId)) return;
    this.data.processedDeliveries.push(deliveryId);
    if (this.data.processedDeliveries.length > MAX_DELIVERIES) this.data.processedDeliveries.splice(0, this.data.processedDeliveries.length - MAX_DELIVERIES);
    this.persist();
  }

  // -- reviews
  addReview(r: ReviewRecord): void {
    this.data.reviews[r.reviewId] = r;
    const ids = Object.keys(this.data.reviews);
    if (ids.length > MAX_REVIEWS) {
      const oldest = ids.sort((a, b) => this.data.reviews[a]!.createdAt.localeCompare(this.data.reviews[b]!.createdAt)).slice(0, ids.length - MAX_REVIEWS);
      for (const id of oldest) delete this.data.reviews[id];
    }
    this.data.latestByPr[prKey(r.repositoryId, r.prNumber)] = r.reviewId;
    this.persist();
  }
  getReview(reviewId: string): ReviewRecord | undefined {
    return this.data.reviews[reviewId];
  }
  latestReviewFor(repositoryId: string, prNumber: number): ReviewRecord | undefined {
    const id = this.data.latestByPr[prKey(repositoryId, prNumber)];
    return id ? this.data.reviews[id] : undefined;
  }
  supersede(oldReviewId: string, newReviewId: string): void {
    const r = this.data.reviews[oldReviewId];
    if (r && !r.supersededBy) {
      r.supersededBy = newReviewId;
      this.persist();
    }
  }
  markFinalized(reviewId: string, at: string, purchaseId?: string | null): void {
    const r = this.data.reviews[reviewId];
    if (r) {
      r.finalizedAt = at;
      if (purchaseId) r.purchaseId = purchaseId;
      this.persist();
    }
  }
  listReviews(filter: (r: ReviewRecord) => boolean = () => true, limit = 10): ReviewRecord[] {
    return Object.values(this.data.reviews)
      .filter(filter)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // -- maintainer label events (one per PR; a newer event replaces the older)
  setLabelAuth(repositoryId: string, prNumber: number, a: LabelAuthRecord): void {
    this.data.labelAuths[prKey(repositoryId, prNumber)] = a;
    const keys = Object.keys(this.data.labelAuths);
    if (keys.length > MAX_REVIEWS) delete this.data.labelAuths[keys[0]!];
    this.persist();
  }
  getLabelAuth(repositoryId: string, prNumber: number): LabelAuthRecord | undefined {
    return this.data.labelAuths[prKey(repositoryId, prNumber)];
  }
  clearLabelAuth(repositoryId: string, prNumber: number): void {
    if (delete this.data.labelAuths[prKey(repositoryId, prNumber)]) this.persist();
  }

  // -- identity links (telegramUserId -> github)
  setLink(telegramUserId: string, link: LinkRecord): void {
    this.data.links[telegramUserId] = link;
    this.persist();
  }
  getLink(telegramUserId: string): LinkRecord | undefined {
    return this.data.links[telegramUserId];
  }
  removeLink(telegramUserId: string): void {
    delete this.data.links[telegramUserId];
    this.persist();
  }
  telegramUserForGithub(githubUserId: string): string | undefined {
    return Object.entries(this.data.links).find(([, l]) => l.githubUserId === githubUserId)?.[0];
  }
  linkedTelegramUsers(): Set<string> {
    return new Set(Object.keys(this.data.links));
  }

  // -- repositories
  setRepo(r: RepoRecord): void {
    this.data.repos[r.repositoryId] = r;
    this.persist();
  }
  getRepo(repositoryId: string): RepoRecord | undefined {
    return this.data.repos[repositoryId];
  }
  listRepos(): RepoRecord[] {
    return Object.values(this.data.repos);
  }
}
