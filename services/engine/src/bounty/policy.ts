import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { type Sql } from '../db.js';
import { scoreSchema, type Evidence, type Score, type Tier } from './schemas.js';

/** Best-effort redaction, applied before storage AND before the external model boundary. */
export function redact<T>(value:T):T {
  function clean(v:unknown):unknown {
    if(typeof v==='string')return v
      .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?-----END [^-]+-----/g,'[REDACTED PRIVATE KEY]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED TOKEN]')
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,'[REDACTED BOT TOKEN]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [REDACTED]')
      .replace(/((?:password|secret|api[_-]?key|access[_-]?token|token)\s*[=:]\s*["'`]?)[^\s"'`,;]+/gi,'$1[REDACTED]');
    if(Array.isArray(v))return v.map(clean);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x)]));
    return v;
  }
  return clean(value) as T;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const evidenceHash=(e:Evidence)=>createHash('sha256').update(canonical(e)).digest('hex');
export function references(e:Evidence):string[] {
  return [...(e.title||e.description?['goal']:[]),...e.files.map(f=>`file:${f.path}`),...e.commits.map(c=>`commit:${c.sha}`),...e.checks.map(c=>`check:${c.id}`),...e.reviews.map(r=>`review:${r.id}`),...e.linkedIssues.map(i=>`issue:${i.number}`)];
}
export function selectTier(score:number,threshold:number,tiers:Tier[]):{index:number;tier:Tier}|null {
  if(!Number.isInteger(score)||score<0||score>100||score<Math.max(50,threshold))return null;
  const index=tiers.findIndex(t=>score>=t.minScore&&score<=t.maxScore);
  return index<0?null:{index:index+1,tier:tiers[index]!};
}
export function evidenceProblems(e:Evidence,allowPrivate:boolean):string[] {
  const problems=[];
  if(e.repositoryPrivate&&!allowPrivate)problems.push('PRIVATE_REPOSITORY_CONSENT_REQUIRED');
  if(e.evidenceTruncated||e.files.some(f=>f.patchTruncated))problems.push('EVIDENCE_TRUNCATED');
  if(e.files.length===0||e.files.some(f=>f.patch===null))problems.push('INSUFFICIENT_DIFF_CONTEXT');
  if(e.files.length>50||JSON.stringify(e).length>120000)problems.push('CHANGE_TOO_LARGE');
  if(new Date(e.collectedAt).getTime()>Date.now()+300000)problems.push('FUTURE_EVIDENCE');
  return problems;
}
export function validateScore(raw:unknown,e:Evidence,maintainerGithubUserId?:number):Score {
  const score=scoreSchema.parse(raw);
  const refs=new Set(references(e));
  if(score.findings.some(f=>f.evidenceRefs.some(ref=>!refs.has(ref))))throw new AppError('INVALID_EVIDENCE_REFERENCE','Model referenced nonexistent evidence');
  if(score.subscores.tests>0&&!e.checks.some(c=>c.headSha===e.headSha&&c.status==='completed'))throw new AppError('UNSUPPORTED_TEST_SCORE','No completed checks support a tests score');
  if(score.subscores.feedback>0&&!e.reviews.some(r=>r.headSha===e.headSha&&(maintainerGithubUserId===undefined||r.reviewerGithubUserId===maintainerGithubUserId)))throw new AppError('UNSUPPORTED_FEEDBACK_SCORE','No current maintainer review evidence');
  const cited=new Set(score.findings.flatMap(f=>f.evidenceRefs));
  if(score.subscores.tests>0&&!e.checks.some(c=>c.headSha===e.headSha&&c.status==='completed'&&cited.has(`check:${c.id}`)))throw new AppError('UNSUPPORTED_TEST_SCORE','Completed check evidence must be cited');
  if(score.subscores.feedback>0&&!e.reviews.some(r=>r.headSha===e.headSha&&(maintainerGithubUserId===undefined||r.reviewerGithubUserId===maintainerGithubUserId)&&cited.has(`review:${r.id}`)))throw new AppError('UNSUPPORTED_FEEDBACK_SCORE','Maintainer review evidence must be cited');
  // No reward for whitespace-only/metadata-only changes, regardless of model confidence.
  const changes=e.files.flatMap(f=>(f.patch??'').split('\n').filter(l=>/^[+-](?![+-])/.test(l)).map(l=>l.slice(1).replace(/\s/g,'')));
  const added=changes.filter(Boolean);
  const plus=e.files.flatMap(f=>(f.patch??'').split('\n').filter(l=>/^\+(?!\+)/.test(l)).map(l=>l.slice(1).replace(/\s/g,''))).sort().join('');
  const minus=e.files.flatMap(f=>(f.patch??'').split('\n').filter(l=>/^-(?!-)/.test(l)).map(l=>l.slice(1).replace(/\s/g,''))).sort().join('');
  if(score.totalScore>=50&&(!score.substantial||added.length===0||plus===minus||score.riskFlags.includes('trivial')))throw new AppError('UNSUPPORTED_HIGH_SCORE','Insufficient substantive evidence for a bounty score');
  return redact(score);
}
export interface Policy {
  requiredLabel:string; requireSuccessfulCI:boolean; scoreThreshold:number; minimumConfidence:number;
  allowSelfReward:boolean;ownerGithubUserId:number;tiers:Tier[];
}
export function eligibility(e:Evidence,score:Score,policy:Policy,linked:boolean):{reasons:string[];candidate:ReturnType<typeof selectTier>} {
  const reasons:string[]=[];
  if(!e.merged)reasons.push('FINAL_MERGED_REVIEW_REQUIRED');
  if(e.authorIsBot||/\[bot\]$/i.test(e.authorLogin))reasons.push('BOT_AUTHOR');
  if(!linked)reasons.push('GITHUB_AUTHOR_NOT_LINKED');
  if(!policy.allowSelfReward&&e.authorGithubUserId===policy.ownerGithubUserId)reasons.push('SELF_REWARD_NOT_ALLOWED');
  if(!e.labels.includes(policy.requiredLabel))reasons.push('REQUIRED_LABEL_MISSING');
  const auth=e.maintainerAuthorization;
  if(!auth||auth.actorGithubUserId!==policy.ownerGithubUserId||auth.headSha!==e.headSha||auth.label!==policy.requiredLabel||new Date(auth.authorizedAt)>new Date(e.collectedAt))reasons.push('MAINTAINER_AUTHORIZATION_MISSING');
  if(auth?.source==='github_api_review'&&!e.reviews.some(r=>r.reviewerGithubUserId===policy.ownerGithubUserId&&r.headSha===e.headSha&&r.state==='APPROVED'&&r.feedbackResolved))reasons.push('MAINTAINER_APPROVAL_NOT_EVIDENCED');
  const required=e.checks.filter(c=>c.required);
  if(policy.requireSuccessfulCI&&(!e.ciComplete||required.length===0))reasons.push('REQUIRED_CI_MISSING');
  if(required.some(c=>c.headSha!==e.headSha||c.status!=='completed'||c.conclusion!=='success'))reasons.push('REQUIRED_CI_NOT_SUCCESSFUL');
  if(e.reviews.some(r=>r.headSha===e.headSha&&r.state==='CHANGES_REQUESTED'&&!r.feedbackResolved))reasons.push('UNRESOLVED_CHANGES_REQUESTED');
  if(score.confidence<policy.minimumConfidence)reasons.push('LOW_CONFIDENCE');
  if(score.manualReviewRequired||score.findings.some(f=>f.severity==='critical')||score.riskFlags.some(f=>['critical_security','prompt_injection','incomplete_evidence'].includes(f)))reasons.push('MANUAL_REVIEW_REQUIRED');
  const candidate=selectTier(score.totalScore,policy.scoreThreshold,policy.tiers);
  if(!candidate)reasons.push('BELOW_THRESHOLD_OR_NO_TIER');
  else if(!candidate.tier.enabled)reasons.push('TIER_DISABLED');
  return {reasons,candidate};
}
/** Runs under the existing rule/purchase lock immediately before invoice and payment intent. */
export async function assertBountyPurchase(c:Sql,purchaseId:string) {
  const {rows}=await c.query(`SELECT a.reviewed_head_sha,a.author_github_user_id,a.recipient_chat_id,v.head_sha,v.state,v.eligibility_state,
    v.valid_until>now() AS fresh,l.telegram_user_id,r.installation_id=v.installation_id AS installation_matches
    FROM bounty_awards a JOIN contribution_reviews v ON v.id=a.review_id
    JOIN connected_repositories r ON r.repository_id=a.repository_id
    LEFT JOIN github_identity_links l ON l.github_user_id=a.author_github_user_id
    WHERE a.purchase_id=$1 FOR UPDATE OF v`,[purchaseId]);
  const a=rows[0];
  if(!a||a.state!=='REVIEWED'||a.eligibility_state!=='ELIGIBLE'||!a.fresh||!a.installation_matches||a.head_sha!==a.reviewed_head_sha||a.telegram_user_id!==a.recipient_chat_id)throw new AppError('BOUNTY_REVIEW_NOT_AUTHORIZED','Bounty review is stale, held, expired or identity changed');
}
