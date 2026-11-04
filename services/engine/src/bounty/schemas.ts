import { z } from 'zod';
const githubId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const privateChatId=z.string().regex(/^[1-9]\d{0,14}$/);
const repoName=z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(250).transform(s=>s.toLowerCase());
export const sha=z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).transform(s=>s.toLowerCase());
const date=z.string().datetime({offset:true});
const login=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/).max(100);
export const linkSchema=z.object({telegramUserId:privateChatId,githubUserId:githubId,githubLogin:login,verificationSource:z.literal('github_oauth'),verifiedAt:date}).strict();
export const connectSchema=z.object({ownerTelegramUserId:privateChatId,repositoryId:githubId,repositoryFullName:repoName,installationId:githubId,verifiedOwnerAccess:z.literal(true),repositoryPrivate:z.boolean().default(true)}).strict();
export const tierSchema=z.object({minScore:z.number().int().min(0).max(100),maxScore:z.number().int().min(0).max(100),faceValueINR:z.number().int().positive().max(1_000_000),productId:z.string().min(1).max(500),packageId:z.string().min(1).max(500),requiresApproval:z.boolean().default(false)}).strict();
export const bountyRuleSchema=z.object({
  ownerTelegramUserId:privateChatId,repositoryId:githubId,requiredLabel:z.string().min(1).max(100),mode:z.literal('ai_contribution_bounty'),requireMerged:z.literal(true),requireSuccessfulCI:z.boolean(),scoreThreshold:z.number().int().min(50).max(100),tiers:z.array(tierSchema).min(1).max(10),
  autoApproveUpToUsdCents:z.number().int().min(0).max(2_000_000_000),perPurchaseCapUsdCents:z.number().int().positive().max(2_000_000_000),dailyCapUsdCents:z.number().int().positive().max(2_000_000_000),monthlyCapUsdCents:z.number().int().positive().max(2_000_000_000),allowSelfReward:z.boolean().default(false)
}).strict().superRefine((r,c)=>{
  if(!(r.autoApproveUpToUsdCents<=r.perPurchaseCapUsdCents&&r.perPurchaseCapUsdCents<=r.dailyCapUsdCents&&r.dailyCapUsdCents<=r.monthlyCapUsdCents))c.addIssue({code:'custom',message:'Invalid hard limits'});
  const tiers=[...r.tiers].sort((a,b)=>a.minScore-b.minScore);
  tiers.forEach((t,i)=>{if(t.minScore>t.maxScore||t.minScore<r.scoreThreshold||(i>0&&t.minScore<=tiers[i-1]!.maxScore))c.addIssue({code:'custom',message:'Invalid or overlapping tiers'});});
});
const file=z.object({path:z.string().min(1).max(300),status:z.enum(['added','modified','removed','renamed']),additions:z.number().int().min(0).max(1_000_000),deletions:z.number().int().min(0).max(1_000_000),patch:z.string().max(50000).nullable(),patchTruncated:z.boolean().default(false)}).strict();
const commit=z.object({sha, message:z.string().max(5000)}).strict();
const check=z.object({id:githubId,name:z.string().min(1).max(200),headSha:sha,status:z.enum(['queued','in_progress','completed']),conclusion:z.enum(['success','failure','cancelled','timed_out','neutral','skipped','action_required','stale']).nullable(),required:z.boolean()}).strict();
const review=z.object({id:githubId,reviewerGithubUserId:githubId,headSha:sha,state:z.enum(['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING']),body:z.string().max(10000),feedbackResolved:z.boolean()}).strict();
const issue=z.object({number:z.number().int().positive(),title:z.string().max(500),body:z.string().max(15000),state:z.enum(['open','closed'])}).strict();
export const evidenceSchema=z.object({
  installationId:githubId,repositoryId:githubId,repositoryFullName:repoName,repositoryPrivate:z.boolean().default(true),prNumber:z.number().int().positive().max(2147483647),headSha:sha,baseSha:sha,authorGithubUserId:githubId,authorLogin:login,authorIsBot:z.boolean().default(true),merged:z.boolean(),collectedAt:date,
  title:z.string().max(500).default(''),description:z.string().max(15000).default(''),labels:z.array(z.string().max(100)).max(100),
  files:z.array(file).max(100),commits:z.array(commit).max(100),checks:z.array(check).max(100),reviews:z.array(review).max(100),linkedIssues:z.array(issue).max(20),evidenceTruncated:z.boolean(),ciComplete:z.boolean().default(false),
  maintainerAuthorization:z.object({actorGithubUserId:githubId,headSha:sha,label:z.string().max(100),verifiedWriteAccess:z.literal(true),source:z.enum(['github_api_label_event','github_api_review']),authorizedAt:date}).strict().nullable().default(null)
}).strict().superRefine((e,c)=>{
  for(const list of [e.files.map(x=>x.path),e.checks.map(x=>String(x.id)),e.reviews.map(x=>String(x.id)),e.commits.map(x=>x.sha),e.linkedIssues.map(x=>String(x.number))])if(new Set(list).size!==list.length)c.addIssue({code:'custom',message:'Evidence IDs must be unique'});
});
export const finalizeSchema=z.object({githubDeliveryId:z.string().min(1).max(200),repositoryId:githubId,prNumber:z.number().int().positive().max(2147483647),headSha:sha,merged:z.boolean()}).strict();
export const scoreSchema=z.object({
  subscores:z.object({correctness:z.number().int().min(0).max(30),tests:z.number().int().min(0).max(25),feedback:z.number().int().min(0).max(20),maintainability:z.number().int().min(0).max(15),security:z.number().int().min(0).max(10)}).strict(),totalScore:z.number().int().min(0).max(100),confidence:z.number().min(0).max(1),
  findings:z.array(z.object({severity:z.enum(['info','warning','critical']),message:z.string().min(1).max(1500),evidenceRefs:z.array(z.string().min(1).max(350)).min(1).max(20)}).strict()).min(1).max(30),
  reasoningSummary:z.string().min(1).max(4000),recommendedTier:z.number().int().min(1).max(10).nullable(),riskFlags:z.array(z.enum(['critical_security','correctness','missing_tests','unresolved_feedback','trivial','prompt_injection','incomplete_evidence'])).max(20),manualReviewRequired:z.boolean(),substantial:z.boolean()
}).strict().refine(s=>Object.values(s.subscores).reduce((a,b)=>a+b,0)===s.totalScore,{message:'Subscores must sum to totalScore'});
export type Evidence=z.infer<typeof evidenceSchema>;
export type Score=z.infer<typeof scoreSchema>;
export type Tier=z.infer<typeof tierSchema>&{enabled:boolean;disabledReason?:string};
export type BountyRuleInput=z.infer<typeof bountyRuleSchema>;
