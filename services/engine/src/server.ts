import { loadConfig } from './config.js';
import { database } from './db.js';
import { Bitrefill, TestPurchasing } from './bitrefill.js';
import { Engine } from './engine.js';
import { SecretBox } from './crypto.js';
import { buildApp } from './app.js';

async function main() {
  const config=loadConfig();
  const db=database(config.DATABASE_URL);
  await db.query('SELECT 1');
  const provider=new Bitrefill(config.BITREFILL_API_KEY,config.BITREFILL_BASE_URL,config.PUBLIC_ENGINE_URL);
  const live=config.LIVE_PURCHASES_ENABLED==='true';
  const engine=new Engine(db,provider,live?provider:new TestPurchasing(),live,new SecretBox(config.REDEMPTION_ENCRYPTION_KEY),config.APPROVAL_TTL_SECONDS,provider);
  const app=buildApp(engine,config.INTERNAL_API_TOKEN);
  let running:Promise<void>|undefined;
  let stopping=false;
  const work=()=>{
    if (running || stopping) return;
    running=engine.tick().catch(()=>{console.error('Engine worker database operation failed; retrying');}).finally(()=>{running=undefined;});
  };
  const timer=setInterval(work,config.WORKER_INTERVAL_MS);
  app.addHook('onClose',async()=>{stopping=true;clearInterval(timer);await running;await db.end();});
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
