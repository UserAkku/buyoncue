import { z } from "zod";

/**
 * Typed contract for the AI-bounty engine endpoints. The paths are fixed by the product spec;
 * the field-level shapes below are this service's working assumption until the engine's
 * bounty specification is merged. See docs/BOUNTY_ENGINE_CONTRACT.md. Responses are parsed
 * leniently (unknown fields allowed) so the engine can add fields without breaking chat.
 */

export const GithubLinkSchema = z
  .object({ githubUserId: z.string(), githubLogin: z.string(), telegramUserId: z.string(), linkedAt: z.string().nullish() })
  .loose();

export const ConnectedRepositorySchema = z
  .object({
    repositoryId: z.string(),
    installationId: z.string(),
    fullName: z.string(),
    status: z.string().nullish(),
    bountyRule: z.object({ id: z.string(), status: z.string(), name: z.string().nullish() }).loose().nullish(),
  })
  .loose();

export const BountyRuleSchema = z.object({ id: z.string(), status: z.string(), name: z.string().nullish() }).loose();

export const ScoreCategorySchema = z.object({ category: z.string(), score: z.number(), max: z.number() }).loose();

export const ContributionReviewSchema = z
  .object({
    reviewId: z.string(),
    status: z.string(),
    repositoryId: z.string().nullish(),
    prNumber: z.number().nullish(),
    headSha: z.string().nullish(),
    provisional: z.boolean().nullish(),
    score: z
      .object({ total: z.number(), max: z.number().default(100), breakdown: z.array(ScoreCategorySchema).default([]) })
      .loose()
      .nullish(),
    candidateTier: z.string().nullish(),
    summary: z.string().nullish(),
    finalization: z
      .object({
        status: z.string(),
        purchaseId: z.string().nullish(),
        invoiceId: z.string().nullish(),
        tier: z.string().nullish(),
        reason: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export type GithubLink = z.infer<typeof GithubLinkSchema>;
export type ConnectedRepository = z.infer<typeof ConnectedRepositorySchema>;
export type BountyRule = z.infer<typeof BountyRuleSchema>;
export type ContributionReview = z.infer<typeof ContributionReviewSchema>;

export interface LinkGithubBody {
  githubUserId: string;
  githubLogin: string;
  telegramUserId: string;
  chatId: string;
}

export interface ConnectRepositoryBody {
  ownerChatId: string;
  /** Verified GitHub numeric ID of the authorizing maintainer. */
  authorizedByGithubUserId: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
}

export interface BountyTier {
  name: string;
  minScore: number;
  productId: string;
  packageId: string;
}

export interface CreateBountyRuleBody {
  ownerChatId: string;
  repositoryId: string;
  name: string;
  requiredLabel: string | null;
  tiers: BountyTier[];
  perPurchaseCapUsdCents: number;
  dailyCapUsdCents: number;
  monthlyCapUsdCents: number;
  autoApproveUpToUsdCents: number;
}

export interface SubmitReviewBody {
  idempotencyKey: string;
  purpose: "provisional" | "final";
  repositoryId: string;
  prNumber: number;
  headSha: string;
  supersedesReviewId: string | null;
  evidence: unknown;
}

export interface FinalizeBody {
  idempotencyKey: string;
  expectedHeadSha: string;
  mergedAt: string;
  evidence: unknown;
}

export interface BountyEngineApi {
  linkGithub(body: LinkGithubBody): Promise<GithubLink>;
  unlinkGithub(telegramUserId: string): Promise<void>;
  connectRepository(body: ConnectRepositoryBody): Promise<ConnectedRepository>;
  listRepositories(ownerChatId: string): Promise<ConnectedRepository[]>;
  disconnectRepository(repositoryId: string, reason: string): Promise<void>;
  createBountyRule(body: CreateBountyRuleBody): Promise<BountyRule>;
  bountyRuleAction(id: string, action: "enable" | "pause" | "resume", ownerChatId: string): Promise<BountyRule | null>;
  submitReview(body: SubmitReviewBody): Promise<ContributionReview>;
  getReview(reviewId: string): Promise<ContributionReview>;
  finalizeReview(reviewId: string, body: FinalizeBody): Promise<ContributionReview>;
}
