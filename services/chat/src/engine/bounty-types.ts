import { z } from "zod";

/**
 * Typed client contract for the engine's AI-bounty endpoints. The canonical request/response
 * schemas live in services/engine/src/bounty/schemas.ts and services/engine/BOUNTY_API.md.
 *
 * Inside this service GitHub IDs are strings (so they can never lose precision in JSON or be
 * confused with display names). They are converted to the engine's positive integers at the HTTP
 * boundary in client.ts, and rejected if they are not safe integers.
 */

const numId = z.union([z.number(), z.string()]).transform(String);

export const GithubLinkSchema = z
  .object({ githubUserId: numId, githubLogin: z.string(), telegramUserId: z.string(), verifiedAt: z.string().nullish(), createdAt: z.string().nullish() })
  .loose();

export const ConnectedRepositorySchema = z
  .object({
    repositoryId: numId,
    installationId: numId,
    repositoryFullName: z.string(),
    ownerGithubUserId: numId.nullish(),
  })
  .loose();

export const BountyRuleSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    name: z.string().nullish(),
    repositoryId: numId.nullish(),
    policyVersion: z.number().nullish(),
    requiredLabel: z.string().nullish(),
    ownerGithubUserId: numId.nullish(),
    tiers: z
      .array(z.object({ minScore: z.number(), maxScore: z.number(), faceValueINR: z.number(), enabled: z.boolean().nullish() }).loose())
      .nullish(),
  })
  .loose();

export const CandidateTierSchema = z
  .object({
    tier: z.number(),
    minScore: z.number(),
    maxScore: z.number(),
    faceValueINR: z.number(),
    requiresApproval: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
  })
  .loose();

export const SubmitResultSchema = z.object({ reviewId: z.string(), state: z.string(), eligibilityState: z.string() }).loose();

export const ReviewViewSchema = z
  .object({
    reviewId: z.string(),
    state: z.string(),
    eligibilityState: z.string(),
    reasons: z.array(z.string()).default([]),
    repositoryId: numId.nullish(),
    prNumber: z.number().nullish(),
    headSha: z.string().nullish(),
    authorGithubUserId: numId.nullish(),
    score: z.number().nullish(),
    subscores: z.record(z.string(), z.number()).nullish(),
    confidence: z.number().nullish(),
    findings: z.array(z.object({ severity: z.string(), message: z.string(), evidenceRefs: z.array(z.string()).default([]) }).loose()).default([]),
    reasoningSummary: z.string().nullish(),
    riskFlags: z.array(z.string()).default([]),
    candidateTier: CandidateTierSchema.nullish(),
    model: z.string().nullish(),
    validUntil: z.string().nullish(),
  })
  .loose();

export const FinalizeResultSchema = z
  .object({
    accepted: z.boolean(),
    reviewId: z.string(),
    state: z.string().nullish(),
    eligibilityState: z.string().nullish(),
    reasons: z.array(z.string()).default([]),
    reason: z.string().nullish(),
    awardId: z.string().nullish(),
    purchaseId: z.string().nullish(),
  })
  .loose();

export const ReceiptSchema = z
  .object({
    purchaseId: z.string(),
    status: z.string(),
    mode: z.string().nullish(),
    invoiceId: z.string().nullish(),
    amountUsdCents: z.number().nullish(),
    invoiceStatus: z.string().nullish(),
    errorCode: z.string().nullish(),
    score: z.number().nullish(),
    tier: z.number().nullish(),
    faceValueINR: z.number().nullish(),
    prNumber: z.number().nullish(),
    orders: z.array(z.object({ id: z.string().nullish(), status: z.string().nullish() }).loose()).default([]),
  })
  .loose();

export type GithubLink = z.infer<typeof GithubLinkSchema>;
export type BountyRule = z.infer<typeof BountyRuleSchema>;
export type ReviewView = z.infer<typeof ReviewViewSchema>;
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
export type FinalizeResult = z.infer<typeof FinalizeResultSchema>;
export type BountyReceipt = z.infer<typeof ReceiptSchema>;

/** A repository as the chat service uses it, joined with its bounty policy (if any). */
export interface ConnectedRepository {
  repositoryId: string;
  installationId: string;
  fullName: string;
  status?: string;
  bountyRule?: { id: string; status: string; name?: string | null; requiredLabel?: string | null; ownerGithubUserId?: string | null } | null;
}

export interface LinkGithubBody {
  telegramUserId: string;
  githubUserId: string;
  githubLogin: string;
  /** When GitHub's OAuth flow authenticated this identity. */
  verifiedAt: string;
}

export interface ConnectRepositoryBody {
  ownerTelegramUserId: string;
  repositoryId: string;
  installationId: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
}

export interface BountyTier {
  minScore: number;
  maxScore: number;
  /** INR face value of the verified catalogue package. The engine re-verifies it. */
  faceValueINR: number;
  productId: string;
  packageId: string;
  requiresApproval: boolean;
}

export interface CreateBountyRuleBody {
  ownerTelegramUserId: string;
  repositoryId: string;
  requiredLabel: string;
  requireSuccessfulCI: boolean;
  scoreThreshold: number;
  tiers: BountyTier[];
  perPurchaseCapUsdCents: number;
  dailyCapUsdCents: number;
  monthlyCapUsdCents: number;
  autoApproveUpToUsdCents: number;
  allowSelfReward: boolean;
}

/** The exact evidence document the engine accepts (see engine `evidenceSchema`). */
export interface EngineEvidence {
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  prNumber: number;
  headSha: string;
  baseSha: string;
  authorGithubUserId: string;
  authorLogin: string;
  authorIsBot: boolean;
  merged: boolean;
  collectedAt: string;
  title: string;
  description: string;
  labels: string[];
  files: { path: string; status: "added" | "modified" | "removed" | "renamed"; additions: number; deletions: number; patch: string | null; patchTruncated: boolean }[];
  commits: { sha: string; message: string }[];
  checks: {
    id: number;
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | "timed_out" | "neutral" | "skipped" | "action_required" | "stale" | null;
    required: boolean;
  }[];
  reviews: { id: number; reviewerGithubUserId: string; headSha: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; body: string; feedbackResolved: boolean }[];
  linkedIssues: { number: number; title: string; body: string; state: "open" | "closed" }[];
  evidenceTruncated: boolean;
  ciComplete: boolean;
  maintainerAuthorization: {
    actorGithubUserId: string;
    headSha: string;
    label: string;
    verifiedWriteAccess: true;
    source: "github_api_label_event" | "github_api_review";
    authorizedAt: string;
  } | null;
}

export interface FinalizeBody {
  githubDeliveryId: string;
  repositoryId: string;
  prNumber: number;
  headSha: string;
  merged: boolean;
}

export interface BountyEngineApi {
  linkGithub(body: LinkGithubBody): Promise<GithubLink>;
  unlinkGithub(telegramUserId: string): Promise<void>;
  connectRepository(body: ConnectRepositoryBody): Promise<ConnectedRepository>;
  listRepositories(ownerTelegramUserId: string): Promise<ConnectedRepository[]>;
  createBountyRule(body: CreateBountyRuleBody): Promise<BountyRule>;
  /** Uses the engine's owner-checked /v1/rules/:id/(enable|pause|resume). */
  bountyRuleAction(ruleId: string, action: "enable" | "pause" | "resume", ownerChatId: string): Promise<{ id: string; status: string } | null>;
  submitReview(evidence: EngineEvidence): Promise<SubmitResult>;
  getReview(reviewId: string): Promise<ReviewView>;
  finalizeReview(reviewId: string, body: FinalizeBody): Promise<FinalizeResult>;
  getReceipt(purchaseId: string): Promise<BountyReceipt>;
}
