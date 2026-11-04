import { randomUUID } from 'node:crypto';
import { type Engine } from '../engine.js';
import { type Db, type Sql, transaction, publicRow } from '../db.js';
import { AppError } from '../errors.js';
import { bountyRuleSchema, connectSchema, evidenceSchema, finalizeSchema, linkSchema, unlinkSchema, type Evidence, type Score, type Tier } from './schemas.js';
import { eligibility, evidenceHash, evidenceProblems, redact, references, selectTier, validateScore, type Policy } from './policy.js';
import { type Reviewer } from './reviewer.js';
interface RuleRow {
  id:string; owner_chat_id:string; recipient_chat_id:string; repository_id:string; repository_full_name:string; installation_id:string;
  owner_github_user_id:string; repository_private:boolean; required_label:string; status:string; tiers:Tier[]; policy_version:number;
  require_successful_ci:boolean; score_threshold:number; minimum_confidence:string; allow_self_reward:boolean;
}
interface ReviewRow {
  id:string; rule_id:string; repository_id:string; installation_id:string; pr_number:number; head_sha:string; author_github_user_id:string;
  state:string; eligibility_state:string; hold_reasons:string[]; result:Score|null; snapshot:Evidence; valid_until:Date; model:string;
}
const RULE_SQL=`SELECT c.*,b.repository_id,b.policy_version,b.require_successful_ci,b.score_threshold,b.minimum_confidence,b.allow_self_reward,b.tiers,
 r.repository_full_name,r.installation_id,r.owner_github_user_id,r.repository_private FROM bounty_rules b
 JOIN commerce_rules c ON c.id=b.rule_id JOIN connected_repositories r ON r.repository_id=b.repository_id`;
export interface BountyOptions {minimumConfidence?:number;allowPrivateRepositories?:boolean;reviewMaxAgeSeconds?:number;maxCallsPerPr?:number;}
export class BountyService {
  readonly db:Db;
  private minimumConfidence:number;
  private allowPrivate:boolean;
  private maxAge:number;
  private maxCalls:number;
  constructor(readonly engine:Engine,readonly reviewer:Reviewer,options:BountyOptions={}) {
    this.db=engine.db;this.minimumConfidence=options.minimumConfidence??0.8;this.allowPrivate=options.allowPrivateRepositories??false;this.maxAge=options.reviewMaxAgeSeconds??3600;this.maxCalls=options.maxCallsPerPr??3;
  }
  private async rule(c:Sql,id:string,lock=false):Promise<RuleRow> {
    const row=(await c.query<RuleRow>(RULE_SQL+' WHERE c.id=$1'+(lock?' FOR UPDATE OF c':''),[id])).rows[0];
    if(!row)throw new AppError('BOUNTY_RULE_NOT_FOUND','Bounty rule not found',404);return row;
  }
  private policy(r:RuleRow):Policy {
    return {requiredLabel:r.required_label,requireSuccessfulCI:r.require_successful_ci,scoreThreshold:r.score_threshold,minimumConfidence:Number(r.minimum_confidence),allowSelfReward:r.allow_self_reward,ownerGithubUserId:Number(r.owner_github_user_id),tiers:r.tiers};
  }
  private async note(c:Sql,key:string,owner:string,type:string,text:string) {
    await c.query(`INSERT INTO notification_outbox(id,dedupe_key,chat_id,type,text) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING`,[randomUUID(),key,owner,type,text]);
  }
  async link(raw:unknown) {
    const x=linkSchema.parse(raw);
    if(Date.parse(x.verifiedAt)>Date.now()+300000)throw new AppError('INVALID_VERIFICATION_TIME','Verification cannot be in the future');
    try { return await transaction(this.db,async c=>{
      const rows=(await c.query('SELECT * FROM github_identity_links WHERE telegram_user_id=$1 OR github_user_id=$2 FOR UPDATE',[x.telegramUserId,x.githubUserId])).rows;
      if(rows.some(r=>r.telegram_user_id!==x.telegramUserId||Number(r.github_user_id)!==x.githubUserId))throw new AppError('IDENTITY_CONFLICT','Verified identity is already linked to another account',409);
      const result=await c.query(`INSERT INTO github_identity_links(telegram_user_id,github_user_id,github_login,verification_source,verified_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(telegram_user_id) DO UPDATE SET github_login=$3,revoked_at=NULL,verified_at=GREATEST(github_identity_links.verified_at,EXCLUDED.verified_at) WHERE github_identity_links.github_user_id=EXCLUDED.github_user_id RETURNING *`,[x.telegramUserId,x.githubUserId,x.githubLogin,x.verificationSource,x.verifiedAt]);
      if(!result.rows[0])throw new AppError('IDENTITY_CONFLICT','Verified identity ownership conflicts',409);
      return {...publicRow(result.rows[0]),githubUserId:Number(result.rows[0].github_user_id)};
    }); } catch(error) {if((error as {code?:string}).code==='23505')throw new AppError('IDENTITY_CONFLICT','Verified identity ownership conflicts',409);throw error;}
  }
  /** Soft-revokes a link: rewards stop immediately, history keeps its references. Idempotent. */
  async unlink(raw:unknown) {
    const x=unlinkSchema.parse(raw);
    return transaction(this.db,async c=>{
      const row=(await c.query('UPDATE github_identity_links SET revoked_at=now() WHERE telegram_user_id=$1 AND revoked_at IS NULL RETURNING telegram_user_id',[x.telegramUserId])).rows[0];
      return {unlinked:!!row};
    });
  }
  async connect(raw:unknown) {
    const x=connectSchema.parse(raw);
    return transaction(this.db,async c=>{
      const identity=(await c.query('SELECT * FROM github_identity_links WHERE telegram_user_id=$1 AND revoked_at IS NULL FOR UPDATE',[x.ownerTelegramUserId])).rows[0];
      if(!identity)throw new AppError('OWNER_IDENTITY_NOT_VERIFIED','Maintainer must link GitHub through OAuth first',403);
      const old=(await c.query('SELECT * FROM connected_repositories WHERE repository_id=$1 FOR UPDATE',[x.repositoryId])).rows[0];
      if(old&&(old.owner_telegram_user_id!==x.ownerTelegramUserId||Number(old.installation_id)!==x.installationId||old.repository_private!==x.repositoryPrivate))throw new AppError('REPOSITORY_OWNERSHIP_CONFLICT','Repository owner, installation or visibility cannot be silently replaced',409);
      const row=(await c.query(`INSERT INTO connected_repositories(repository_id,owner_telegram_user_id,owner_github_user_id,repository_full_name,installation_id,repository_private)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(repository_id) DO UPDATE SET repository_full_name=$4,verified_at=now() WHERE connected_repositories.owner_telegram_user_id=EXCLUDED.owner_telegram_user_id AND connected_repositories.installation_id=EXCLUDED.installation_id AND connected_repositories.repository_private=EXCLUDED.repository_private RETURNING *`,[x.repositoryId,x.ownerTelegramUserId,identity.github_user_id,x.repositoryFullName,x.installationId,x.repositoryPrivate])).rows[0];
      if(!row)throw new AppError('REPOSITORY_OWNERSHIP_CONFLICT','Repository ownership or installation conflicts',409);
      return this.repoDTO(row);
    });
  }
  private repoDTO(r:Record<string,unknown>) {return {...publicRow(r),repositoryId:Number(r.repository_id),installationId:Number(r.installation_id),ownerGithubUserId:Number(r.owner_github_user_id)};}
  async repositories(owner:string) {return (await this.db.query('SELECT * FROM connected_repositories WHERE owner_telegram_user_id=$1 ORDER BY repository_id',[owner])).rows.map(r=>this.repoDTO(r));}
  async createRule(raw:unknown) {
    const x=bountyRuleSchema.parse(raw);
    const repo=(await this.db.query('SELECT r.* FROM connected_repositories r JOIN github_identity_links l ON l.telegram_user_id=r.owner_telegram_user_id AND l.revoked_at IS NULL WHERE r.repository_id=$1 AND r.owner_telegram_user_id=$2',[x.repositoryId,x.ownerTelegramUserId])).rows[0];
    if(!repo)throw new AppError('REPOSITORY_NOT_AUTHORIZED','Repository is not connected for this maintainer',403);
    const tiers:Tier[]=[];
    for(const t of [...x.tiers].sort((a,b)=>a.minScore-b.minScore)) {
      const p=await this.engine.catalogue.product(t.productId);
      const pkg=p.packages.find(p=>p.packageId===t.packageId);
      if(p.id!==t.productId||p.currency!=='INR'||p.country!=='IN'||!pkg||pkg.value!==t.faceValueINR)throw new AppError('UNVERIFIED_TIER','Tier must match an exact Indian INR catalogue package');
      tiers.push({...t,enabled:p.inStock,...(!p.inStock?{disabledReason:'OUT_OF_STOCK'}:{})});
    }
    const base=tiers.find(t=>t.enabled)??tiers[0]!;
    const id=randomUUID();
    try {await transaction(this.db,async c=>{
      await c.query('SELECT * FROM connected_repositories WHERE repository_id=$1 FOR UPDATE',[x.repositoryId]);
      if((await c.query('SELECT 1 FROM bounty_rules WHERE repository_id=$1',[x.repositoryId])).rowCount)throw new AppError('BOUNTY_POLICY_EXISTS','One versioned bounty policy per repository is supported; no silent replacement',409);
      await c.query(`INSERT INTO commerce_rules(id,owner_chat_id,recipient_chat_id,name,repository,required_label,product_id,package_id,
        per_purchase_cap_usd_cents,daily_cap_usd_cents,monthly_cap_usd_cents,auto_approve_up_to_usd_cents,kind)
        VALUES($1,$2,$3,'AI contribution bounty',$4,$5,$6,$7,$8,$9,$10,$11,'bounty')`,[id,x.ownerTelegramUserId,this.engine.defaultRecipient(x.ownerTelegramUserId),repo.repository_full_name,x.requiredLabel,base.productId,base.packageId,x.perPurchaseCapUsdCents,x.dailyCapUsdCents,x.monthlyCapUsdCents,x.autoApproveUpToUsdCents]);
      await c.query(`INSERT INTO bounty_rules(rule_id,repository_id,mode,require_merged,require_successful_ci,score_threshold,minimum_confidence,allow_self_reward,tiers)
        VALUES($1,$2,$3,true,$4,$5,$6,$7,$8)`,[id,x.repositoryId,x.mode,x.requireSuccessfulCI,x.scoreThreshold,this.minimumConfidence,x.allowSelfReward,JSON.stringify(tiers)]);
    });}catch(error){if((error as {code?:string}).code==='23505')throw new AppError('BOUNTY_POLICY_EXISTS','A policy already exists for this repository',409);throw error;}
    return this.ruleDTO(await this.rule(this.db,id));
  }
  private ruleDTO(r:RuleRow) {return {...publicRow(r as unknown as Record<string,unknown>),repositoryId:Number(r.repository_id),installationId:Number(r.installation_id),ownerGithubUserId:Number(r.owner_github_user_id),ownerTelegramUserId:r.owner_chat_id,minimumConfidence:Number(r.minimum_confidence),mode:'ai_contribution_bounty'};}
  async rules(owner:string) {return (await this.db.query<RuleRow>(RULE_SQL+' WHERE c.owner_chat_id=$1 ORDER BY c.created_at',[owner])).rows.map(r=>this.ruleDTO(r));}
  private async reviewRow(c:Sql,id:string,lock=false):Promise<ReviewRow> {
    const row=(await c.query<ReviewRow>(`SELECT v.*,e.snapshot FROM contribution_reviews v JOIN review_evidence e ON e.review_id=v.id WHERE v.id=$1${lock?' FOR UPDATE OF v':''}`,[id])).rows[0];
    if(!row)throw new AppError('REVIEW_NOT_FOUND','Contribution review not found',404);return row;
  }
  async submit(raw:unknown) {
    const input=evidenceSchema.parse(raw);
    const evidence=redact(input);
    return transaction(this.db,async c=>{
      const found=(await c.query<{rule_id:string}>('SELECT rule_id FROM bounty_rules WHERE repository_id=$1',[input.repositoryId])).rows[0];
      if(!found)throw new AppError('REPOSITORY_NOT_AUTHORIZED','No approved repository bounty policy',403);
      const rule=await this.rule(c,found.rule_id,true);
      if(Number(rule.installation_id)!==input.installationId||rule.repository_full_name!==input.repositoryFullName||rule.repository_private!==input.repositoryPrivate)throw new AppError('REPOSITORY_EVIDENCE_MISMATCH','Repository ID, name, visibility and installation must match the verified connection',403);
      const hash=evidenceHash(evidence);
      const old=(await c.query('SELECT id,state,eligibility_state FROM contribution_reviews WHERE rule_id=$1 AND repository_id=$2 AND pr_number=$3 AND head_sha=$4 AND evidence_hash=$5',[rule.id,input.repositoryId,input.prNumber,input.headSha,hash])).rows[0];
      if(old)return {reviewId:old.id,state:old.state,eligibilityState:old.eligibility_state};
      const attempts=(await c.query('SELECT count(*)::int AS count FROM contribution_reviews WHERE rule_id=$1 AND pr_number=$2',[rule.id,input.prNumber])).rows[0].count;
      if(attempts>=this.maxCalls)throw new AppError('REVIEW_CALL_LIMIT','Review attempt limit reached for this policy and PR',409);
      await c.query("UPDATE contribution_reviews SET state='STALE',eligibility_state='HOLD',hold_reasons='[\"SUPERSEDED_EVIDENCE\"]',updated_at=now() WHERE rule_id=$1 AND pr_number=$2 AND state<>'STALE'",[rule.id,input.prNumber]);
      const id=randomUUID();const validUntil=new Date(Math.min(Date.now(),Date.parse(input.collectedAt))+this.maxAge*1000);
      await c.query(`INSERT INTO contribution_reviews(id,rule_id,repository_id,installation_id,pr_number,head_sha,author_github_user_id,evidence_hash,state,model,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10)`,[id,rule.id,input.repositoryId,input.installationId,input.prNumber,input.headSha,input.authorGithubUserId,hash,this.reviewer.model,validUntil]);
      await c.query('INSERT INTO review_evidence(review_id,snapshot,reference_ids,redactions_applied) VALUES($1,$2,$3,$4)',[id,evidence,references(evidence),JSON.stringify(input)!==JSON.stringify(evidence)]);
      return {reviewId:id,state:'QUEUED',eligibilityState:'HOLD'};
    });
  }
  async get(id:string) {
    const row=await this.reviewRow(this.db,id);const rule=await this.rule(this.db,row.rule_id);
    const expired=row.valid_until.getTime()<=Date.now();
    const candidate=!expired&&row.result&&row.state==='REVIEWED'?selectTier(row.result.totalScore,rule.score_threshold,rule.tiers):null;
    return {reviewId:row.id,ruleId:row.rule_id,policyVersion:rule.policy_version,repositoryId:Number(row.repository_id),prNumber:row.pr_number,headSha:row.head_sha,
      authorGithubUserId:Number(row.author_github_user_id),state:row.state,eligibilityState:expired?'HOLD':row.eligibility_state,reasons:expired?[...new Set([...row.hold_reasons,'EVIDENCE_EXPIRED'])]:row.hold_reasons,
      score:row.result?.totalScore??null,subscores:row.result?.subscores??null,confidence:row.result?.confidence??null,findings:row.result?.findings??[],reasoningSummary:row.result?.reasoningSummary??null,
      riskFlags:row.result?.riskFlags??[],candidateTier:candidate?{tier:candidate.index,...candidate.tier}:null,model:row.model,validUntil:row.valid_until};
  }
  async tick(limit=10) {
    const jobs=await this.db.query<{id:string}>("SELECT id FROM contribution_reviews WHERE state='QUEUED' OR (state='REVIEWING' AND lease_until<=now()) ORDER BY created_at LIMIT $1",[limit]);
    for(const {id} of jobs.rows)await this.process(id);
  }
  async process(id:string) {
    const lock=await this.db.connect();
    const got=await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`review:${id}`]);
    if(!got.rows[0].locked){lock.release();return;}
    try {
      const row=await transaction(this.db,async c=>{
        const v=await this.reviewRow(c,id,true);
        if(v.state==='REVIEWING') {
          await c.query("UPDATE contribution_reviews SET state='NEEDS_REVIEW',hold_reasons='[\"REVIEW_INTERRUPTED\"]',updated_at=now() WHERE id=$1 AND lease_until<=now()",[id]);return null;
        }
        if(v.state!=='QUEUED')return null;
        await c.query("UPDATE contribution_reviews SET state='REVIEWING',lease_until=now()+interval '60 seconds' WHERE id=$1",[id]);return v;
      });
      if(!row)return;
      const rule=await this.rule(this.db,row.rule_id);
      const problems=evidenceProblems(row.snapshot,this.allowPrivate);
      if(row.valid_until.getTime()<=Date.now())problems.push('EVIDENCE_EXPIRED');
      let score:Score|null=null;let state='REVIEWED';let reasons=problems;
      if(problems.length)state='NEEDS_REVIEW';
      else {
        let raw:unknown;
        try{raw=await this.reviewer.review(row.snapshot,rule.tiers,{maintainerGithubUserId:Number(rule.owner_github_user_id)});}catch{state='NEEDS_REVIEW';reasons=['MODEL_UNAVAILABLE'];}
        if(state==='REVIEWED') {
          try{score=validateScore(raw,row.snapshot,Number(rule.owner_github_user_id));if(score.recommendedTier!==null&&score.recommendedTier>rule.tiers.length)throw new Error('Unknown advisory tier');}catch{state='NEEDS_REVIEW';reasons=['INVALID_MODEL_OUTPUT'];}
        }
      }
      if(score) {
        const linked=(await this.db.query('SELECT telegram_user_id FROM github_identity_links WHERE github_user_id=$1 AND revoked_at IS NULL',[row.author_github_user_id])).rows[0];
        const decision=eligibility(row.snapshot,score,this.policy(rule),!!linked);reasons=decision.reasons;
        if(linked&&!this.engine.recipientAllowed(linked.telegram_user_id))reasons.push('RECIPIENT_NOT_PRELINKED');
        if(reasons.includes('LOW_CONFIDENCE'))state='LOW_CONFIDENCE';
        else if(reasons.includes('MANUAL_REVIEW_REQUIRED'))state='NEEDS_REVIEW';
      }
      await transaction(this.db,async c=>{
        const updated=await c.query("UPDATE contribution_reviews SET state=$2,eligibility_state=$3,hold_reasons=$4,result=$5,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='REVIEWING' RETURNING id",[id,state,reasons.length?'HOLD':'ELIGIBLE',JSON.stringify(reasons),score]);
        if(updated.rowCount)await this.note(c,`review:${id}`,rule.owner_chat_id,'contribution_reviewed',`Contribution review ${id}: ${state}; ${score?`score ${score.totalScore}. `:''}${reasons.length?'HOLD: '+reasons.join(', '):'Eligible for deterministic tier selection after trusted finalization.'}`);
      });
    } finally {await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`review:${id}`]);lock.release();}
  }
  async finalize(id:string,raw:unknown) {
    const input=finalizeSchema.parse(raw);
    const initial=await this.reviewRow(this.db,id);
    const r=await this.rule(this.db,initial.rule_id);
    if(Number(initial.repository_id)!==input.repositoryId||initial.pr_number!==input.prNumber)throw new AppError('FINALIZATION_IDENTITY_MISMATCH','Final merged PR must match reviewed repository and number',409);
    if(initial.head_sha!==input.headSha) {
      return transaction(this.db,async c=>{
        await this.rule(c,initial.rule_id,true);
        await c.query("UPDATE contribution_reviews SET state='STALE',eligibility_state='HOLD',hold_reasons='[\"FINAL_SHA_MISMATCH\"]',updated_at=now() WHERE id=$1",[id]);
        return {accepted:false,reviewId:id,state:'STALE',eligibilityState:'HOLD',reasons:['FINAL_SHA_MISMATCH']};
      });
    }
    // Read-only stock refresh before taking financial locks; payment rechecks it again.
    const candidate=initial.result?selectTier(initial.result.totalScore,r.score_threshold,r.tiers):null;
    let available=false;let catalogueUnavailable=false;
    if(candidate?.tier.enabled) {
      try {
        const p=await this.engine.catalogue.product(candidate.tier.productId);
        available=p.id===candidate.tier.productId&&p.inStock&&p.currency==='INR'&&p.country==='IN'&&p.packages.some(p=>p.packageId===candidate.tier.packageId&&p.value===candidate.tier.faceValueINR);
      } catch {catalogueUnavailable=true;}
    }
    return transaction(this.db,async c=>{
      const rule=await this.rule(c,initial.rule_id,true);
      const row=await this.reviewRow(c,id,true);
      if(Number(row.repository_id)!==input.repositoryId||row.pr_number!==input.prNumber)throw new AppError('FINALIZATION_IDENTITY_MISMATCH','Final merged PR must match the reviewed repository and number',409);
      if(input.headSha!==row.head_sha) {
        await c.query("UPDATE contribution_reviews SET state='STALE',eligibility_state='HOLD',hold_reasons='[\"FINAL_SHA_MISMATCH\"]',updated_at=now() WHERE id=$1",[id]);
        return {accepted:false,reviewId:id,state:'STALE',eligibilityState:'HOLD',reasons:['FINAL_SHA_MISMATCH']};
      }
      const oldEvent=(await c.query('SELECT * FROM bounty_finalization_events WHERE delivery_id=$1',[input.githubDeliveryId])).rows[0];
      if(oldEvent) {
        const prior=await this.reviewRow(c,oldEvent.review_id);
        if(oldEvent.head_sha!==input.headSha||prior.rule_id!==row.rule_id||prior.repository_id!==row.repository_id||prior.pr_number!==row.pr_number)throw new AppError('DELIVERY_ID_CONFLICT','Delivery ID was already used for another PR or SHA',409);
      }
      const existing=(await c.query('SELECT id,purchase_id FROM bounty_awards WHERE rule_id=$1 AND repository_id=$2 AND pr_number=$3',[rule.id,input.repositoryId,input.prNumber])).rows[0];
      if(existing)return {accepted:true,reviewId:id,reason:'duplicate_pr',awardId:existing.id,purchaseId:existing.purchase_id};
      const linked=(await c.query('SELECT * FROM github_identity_links WHERE github_user_id=$1 AND revoked_at IS NULL',[row.author_github_user_id])).rows[0];
      const ownerActive=(await c.query('SELECT 1 FROM github_identity_links WHERE github_user_id=$1 AND revoked_at IS NULL',[rule.owner_github_user_id])).rowCount===1;
      const decision=row.result?eligibility(row.snapshot,row.result,this.policy(rule),!!linked):{reasons:['REVIEW_NOT_READY'],candidate:null};
      const reasons=[...decision.reasons];
      if(row.state!=='REVIEWED')reasons.push('REVIEW_NOT_READY');
      if(!input.merged)reasons.push('NOT_MERGED');
      if(rule.status!=='enabled')reasons.push('RULE_NOT_ENABLED');
      if(!ownerActive)reasons.push('OWNER_IDENTITY_REVOKED');
      if(row.valid_until.getTime()<=Date.now())reasons.push('EVIDENCE_EXPIRED');
      if(Number(row.installation_id)!==Number(rule.installation_id))reasons.push('INSTALLATION_CHANGED');
      if(linked&&!this.engine.recipientAllowed(linked.telegram_user_id))reasons.push('RECIPIENT_NOT_PRELINKED');
      if(catalogueUnavailable)reasons.push('CATALOGUE_UNAVAILABLE');
      if(decision.candidate&&!available&&!catalogueUnavailable) {
        reasons.push('TIER_UNAVAILABLE');
        const tiers=rule.tiers.map((t,i)=>i===decision.candidate!.index-1?{...t,enabled:false,disabledReason:'LIVE_CATALOGUE_UNAVAILABLE'}:t);
        await c.query('UPDATE bounty_rules SET tiers=$2 WHERE rule_id=$1',[rule.id,JSON.stringify(tiers)]);
      }
      if(reasons.length) {
        if(input.merged&&row.snapshot.merged)await c.query(`INSERT INTO bounty_finalization_events(delivery_id,review_id,head_sha,state,reasons) VALUES($1,$2,$3,'HOLD',$4)
          ON CONFLICT(delivery_id) DO UPDATE SET review_id=$2,reasons=$4 WHERE bounty_finalization_events.award_id IS NULL`,[input.githubDeliveryId,id,input.headSha,JSON.stringify([...new Set(reasons)])]);
        await c.query("UPDATE contribution_reviews SET eligibility_state='HOLD',hold_reasons=$2,updated_at=now() WHERE id=$1",[id,JSON.stringify([...new Set(reasons)])]);
        return {accepted:false,reviewId:id,state:row.state,eligibilityState:'HOLD',reasons:[...new Set(reasons)]};
      }
      const tier=decision.candidate!;const awardId=randomUUID();const purchaseId=randomUUID();const eventId=randomUUID();
      await c.query("UPDATE contribution_reviews SET eligibility_state='ELIGIBLE',hold_reasons='[]' WHERE id=$1",[id]);
      await c.query('INSERT INTO trigger_events(id,delivery_id,payload,reason) VALUES($1,$2,$3,$4)',[eventId,`bounty:${input.githubDeliveryId}`,{reviewId:id,repositoryId:input.repositoryId,prNumber:input.prNumber,headSha:input.headSha},'bounty_queued']);
      await c.query(`INSERT INTO bounty_awards(id,rule_id,repository_id,pr_number,review_id,reviewed_head_sha,author_github_user_id,recipient_chat_id,tier,score,face_value_inr,policy_version,purchase_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[awardId,rule.id,input.repositoryId,input.prNumber,id,input.headSha,row.author_github_user_id,linked.telegram_user_id,tier.index,row.result!.totalScore,tier.tier.faceValueINR,rule.policy_version,purchaseId]);
      await c.query(`INSERT INTO purchases(id,rule_id,event_id,repository,pr_number,mode,status,reward_product_id,reward_package_id,reward_recipient_chat_id,reward_face_value_inr,requires_owner_approval)
        VALUES($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$9,$10,$11)`,[purchaseId,rule.id,eventId,`github-id:${input.repositoryId}`,input.prNumber,this.engine.purchasing.mode,tier.tier.productId,tier.tier.packageId,linked.telegram_user_id,tier.tier.faceValueINR,tier.tier.requiresApproval||row.result!.totalScore>=85]);
      const receipt={repositoryId:input.repositoryId,repositoryFullName:rule.repository_full_name,prNumber:input.prNumber,reviewedHeadSha:input.headSha,authorGithubUserId:Number(row.author_github_user_id),aiReviewId:id,score:row.result!.totalScore,tier:tier.index,faceValueINR:tier.tier.faceValueINR,ruleId:rule.id,policyVersion:rule.policy_version,productId:tier.tier.productId,packageId:tier.tier.packageId,recipientChatId:linked.telegram_user_id};
      await c.query('INSERT INTO bounty_purchase_receipts(purchase_id,award_id,evidence_receipt) VALUES($1,$2,$3)',[purchaseId,awardId,receipt]);
      await c.query("INSERT INTO bounty_finalization_events(delivery_id,review_id,head_sha,award_id,state) VALUES($1,$2,$3,$4,'QUEUED') ON CONFLICT(delivery_id) DO UPDATE SET review_id=$2,award_id=$4,state='QUEUED',reasons='[]'",[input.githubDeliveryId,id,input.headSha,awardId]);
      await this.note(c,`award:${awardId}`,rule.owner_chat_id,'bounty_queued',`${this.engine.liveEnabled?'':'TEST MODE: '}Bounty tier ${tier.index} authorized for PR #${input.prNumber}; score ${row.result!.totalScore}, review ${id}, SHA ${input.headSha}. Purchase ${purchaseId} will pass exact-charge financial checks.`);
      return {accepted:true,reviewId:id,reason:'queued',awardId,purchaseId};
    });
  }
  async receipt(purchaseId:string) {
    const row=(await this.db.query(`SELECT a.evidence_receipt,p.mode,p.status,p.invoice_id,p.amount_usd_cents,p.error_code,i.status AS invoice_status,i.order_statuses
      FROM bounty_purchase_receipts a JOIN purchases p ON p.id=a.purchase_id LEFT JOIN invoices i ON i.purchase_id=p.id WHERE p.id=$1`,[purchaseId])).rows[0];
    if(!row)throw new AppError('RECEIPT_NOT_FOUND','Bounty receipt not found',404);
    return {...row.evidence_receipt,purchaseId,mode:row.mode,status:row.status,invoiceId:row.invoice_id,amountUsdCents:row.amount_usd_cents,errorCode:row.error_code,invoiceStatus:row.invoice_status,orders:row.order_statuses??[]};
  }
}
