import { bedrockConfig } from './bedrock.js';
import { loadConfig } from './config.js';
import { database } from './db.js';
import { Bitrefill, TestPurchasing } from './bitrefill.js';
import { Engine } from './engine.js';
import { SecretBox } from './crypto.js';
import { buildApp } from './app.js';
import { BountyService } from './bounty/service.js';
import { CompatibleReviewer, UnconfiguredReviewer } from './bounty/reviewer.js';

async function main() {
  const config=loadConfig();
  const db=database(config.DATABASE_URL);
  await db.query('SELECT 1');
  const provider=new Bitrefill(config.BITREFILL_API_KEY,config.BITREFILL_BASE_URL,config.PUBLIC_ENGINE_URL);
  const live=config.LIVE_PURCHASES_ENABLED==='true';
  const engine=new Engine(db,provider,live?provider:new TestPurchasing(provider,db),live,new SecretBox(config.REDEMPTION_ENCRYPTION_KEY),config.APPROVAL_TTL_SECONDS,provider,config.AUTHORIZED_RECIPIENT_CHAT_ID);
  const bedrock=bedrockConfig(process.env,'REVIEW');
  const reviewer=bedrock?new CompatibleReviewer(bedrock.model,bedrock.apiKey,bedrock.baseUrl,bedrock.fetchImpl):config.LLM_API_KEY&&config.LLM_BASE_URL&&config.LLM_MODEL?new CompatibleReviewer(config.LLM_MODEL,config.LLM_API_KEY,config.LLM_BASE_URL):new UnconfiguredReviewer();
  const bounties=new BountyService(engine,reviewer,{maxCallsPerPr:config.LLM_REVIEW_MAX_CALLS_PER_PR,minimumConfidence:config.AI_REVIEW_MIN_CONFIDENCE,reviewMaxAgeSeconds:config.AI_REVIEW_MAX_AGE_SECONDS,allowPrivateRepositories:config.AI_ALLOW_PRIVATE_REPOSITORIES==='true'});
  const app=buildApp(engine,config.INTERNAL_API_TOKEN,bounties);
  let running:Promise<void>|undefined;
  let reviewing:Promise<void>|undefined;
  let stopping=false;
  const work=()=>{
    if (stopping) return;
    if(!running)running=engine.tick().catch(()=>{console.error('Engine worker database operation failed; retrying');}).finally(()=>{running=undefined;});
    if(!reviewing)reviewing=bounties.tick(1).catch(()=>{console.error('Contribution review worker failed; retrying');}).finally(()=>{reviewing=undefined;});
  };
  const timer=setInterval(work,config.WORKER_INTERVAL_MS);
  app.addHook('onClose',async()=>{stopping=true;clearInterval(timer);await Promise.all([running,reviewing]);await db.end();});
  const shutdown=async()=>{await app.close();};
  process.once('SIGTERM',()=>void shutdown());
  process.once('SIGINT',()=>void shutdown());
  try {
    await db.query('SELECT id FROM commerce_rules LIMIT 0');
    await app.listen({host:'0.0.0.0',port:config.PORT});
  } catch(error) { await app.close();throw error; }
  console.log(`Engine listening on port ${config.PORT}; mode=${live?'live':'test (no real purchases)'}`);
  work();
}
main().catch(()=>{console.error('Engine failed to start; verify configuration, database and migrations');process.exitCode=1;});
