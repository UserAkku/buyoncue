import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { database, type Db } from '../../services/engine/src/db.js';
import { migrate } from '../../services/engine/src/migrate.js';
import { Engine } from '../../services/engine/src/engine.js';
import { buildApp } from '../../services/engine/src/app.js';
import { SecretBox } from '../../services/engine/src/crypto.js';
import { TestPurchasing, type Catalogue, type Purchasing, type Invoice, type Order } from '../../services/engine/src/bitrefill.js';
import { EngineClient } from '../../services/chat/src/engine/client.js';
import { Controller } from '../../services/chat/src/bot/controller.js';
import { createBot } from '../../services/chat/src/bot/bot.js';
import { NotificationWorker, type Sender } from '../../services/chat/src/notifications/worker.js';
import { createApp } from '../../services/chat/src/webhook/github.js';
import type { Logger } from '../../services/chat/src/logger.js';

// No real external transports are reachable from this suite, even if secrets exist locally.
assert.equal(process.env.LIVE_PURCHASES_ENABLED, 'false');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== '127.0.0.1') throw new Error('External network forbidden in integration tests');
  return nativeFetch(input, init);
};
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database');
const root = database(testUrl);
const schema = `baseline_test_${randomUUID().replaceAll('-', '')}`;
const token = 'TEST-INTERNAL-API-TOKEN-at-least-32-chars';
const secret = 'TEST-GITHUB-HMAC-SECRET';
const owner = { userId:'1001',chatId:'1001',chatType:'private' };
const recipient = '3003';
const box = new SecretBox('43'.repeat(32));
const product = {id:'TEST-MOCK-flipkart-in',name:'TEST MOCK Indian gift card',country:'IN',currency:'INR',inStock:true,packages:[{packageId:'TEST-MOCK-package-50',value:50}]};
const catalogue: Catalogue = {
  async search(q, country) { return q==='flipkart' && country==='IN' ? [product] : []; },
  async product(id) { if (id!==product.id) throw new Error('Unknown product');return product; }
};
class FakePayments implements Purchasing {
  readonly mode='test' as const;
  creates:{productId:string;packageId:string;purchaseId:string}[]=[];
  pays:string[]=[];
  paid=new Set<string>();
  price:string|undefined='1.25'; currency='USD'; timeout=false; insufficient=false; orderFailed=false;
  async createInvoice(productId:string,packageId:string,purchaseId:string) {
    this.creates.push({productId,packageId,purchaseId});return this.invoice(`TEST-MOCK-invoice-${purchaseId}`);
  }
  async invoice(id:string):Promise<Invoice> {
    return {id,status:this.paid.has(id)?'complete':'unpaid',payment:{method:'balance',currency:this.currency,price:this.price},orders:[{id:`${id}:order`,status:this.paid.has(id)?'delivered':'created'}]};
  }
  async pay(id:string) {
    assert.match(id,/^TEST-MOCK-/);this.pays.push(id);
    if (this.timeout || this.insufficient) throw new Error(this.insufficient?'TEST insufficient balance':'TEST timeout');
    this.paid.add(id);
  }
  async order(id:string):Promise<Order> {
    const invoiceId=id.replace(/:order$/,'');const paid=this.paid.has(invoiceId);
    return {id,invoiceId,productId:product.id,productValue:'50',productCurrency:'INR',status:paid?(this.orderFailed?'failed':'delivered'):'created',
      ...(paid?{redemption:{code:'TEST-MOCK-NOT-REDEEMABLE',pin:'TEST-MOCK-PIN',link:null,instructions:'TEST MOCK only; no monetary value'}}:{})};
  }
}
let db:Db;
let payments:FakePayments;
let engine:Engine;
let api:ReturnType<typeof buildApp>;
let chatServer:Server;
let engineUrl:string;
let chatUrl:string;
let client:EngineClient;
let controller:Controller;
let worker:NotificationWorker;
let now=0;
let sent:{chatId:string;html:string;buttons?:unknown}[]=[];
let timeline:string[]=[];
let logs:string[]=[];
let failTelegram=false;
let lookupUnavailable=false;
const logger:Logger=Object.fromEntries(['info','warn','error'].map(k=>[k,(msg:string,f?:unknown)=>logs.push(msg+JSON.stringify(f??{}))])) as unknown as Logger;
const sender:Sender={
  async chatType(id){return lookupUnavailable?null:[owner.userId,recipient].includes(id)?'private':'group';},
  async sendMessage(chatId,html,buttons){
    if(failTelegram)throw new Error('TEST-MOCK-NOT-REDEEMABLE');
    timeline.push(`send:${chatId}`);sent.push({chatId,html,buttons});
  }
};
function buildEngine() {return new Engine(db,catalogue,payments,false,box,60,undefined,recipient);}
function makeController(interpreter:ConstructorParameters<typeof Controller>[0]['interpreter']=null){
  return new Controller({engine:client,interpreter,ownerUserId:owner.userId,logger,verifyRecipient:async id=>(await sender.chatType(id))==='private'});
}
async function startEngine(){
  api=buildApp(engine,token);
  api.addHook('onResponse',async req=>{if(req.url.endsWith('/ack'))timeline.push('ack:'+req.url.split('/')[3]);});
  engineUrl=await api.listen({host:'127.0.0.1',port:0});
  client=new EngineClient({baseUrl:engineUrl,token,timeoutMs:1000});
}
before(async()=>{
  await root.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(testUrl!);url.searchParams.set('options',`-c search_path=${schema}`);db=database(url.toString());
  await migrate(db);await migrate(db);
});
after(async()=>{globalThis.fetch=nativeFetch;if(api)await api.close();if(chatServer)await new Promise<void>(r=>chatServer.close(()=>r()));if(db)await db.end();await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();});
beforeEach(async()=>{
  if(api)await api.close();if(chatServer)await new Promise<void>(r=>chatServer.close(()=>r()));
  await db.query('TRUNCATE notification_outbox,invoices,approvals,spending_ledger,purchases,trigger_events,commerce_rules CASCADE');
  payments=new FakePayments();engine=buildEngine();await startEngine();
  const app=createApp({secret,engine:client,logger});chatServer=app.listen(0,'127.0.0.1');await once(chatServer,'listening');
  chatUrl=`http://127.0.0.1:${(chatServer.address() as {port:number}).port}`;
  now=100_000;sent=[];timeline=[];logs=[];failTelegram=false;lookupUnavailable=false;
  controller=makeController();worker=new NotificationWorker({engine:client,sender,ownerChatId:owner.userId,logger,now:()=>now});
});
const ruleBody=(overrides={})=>({ownerChatId:owner.userId,recipientChatId:recipient,name:'TEST-MOCK PR reward',repository:'UserAkku/buyoncue',requiredLabel:'reward-ready',productId:product.id,packageId:product.packages[0].packageId,perPurchaseCapUsdCents:200,dailyCapUsdCents:500,monthlyCapUsdCents:2000,autoApproveUpToUsdCents:150,...overrides});
async function rule(overrides={},enable=true){const r=await client.createRule(ruleBody(overrides));assert.equal(r.status,'draft');if(enable)await client.enableRule(r.id,owner.userId);return r;}
const payload=(overrides:Record<string,unknown>={})=>({action:'closed',repository:{full_name:'UserAkku/buyoncue'},pull_request:{number:42,merged:true,merged_at:'2026-11-04T12:00:00Z',labels:[{name:'reward-ready'}],user:{login:'fixture-contributor'},title:'UNTRUSTED TITLE',body:'UNTRUSTED BODY'},...overrides});
async function webhook(data=payload(),id=randomUUID(),signature:string|null='valid',event='pull_request'){
  const raw=JSON.stringify(data);const headers:Record<string,string>={'Content-Type':'application/json','X-GitHub-Event':event,'X-GitHub-Delivery':id};
  if(signature!==null)headers['X-Hub-Signature-256']=signature.startsWith('valid')?`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}${signature==='valid-with-junk'?'zz':''}`:signature;
  return fetch(`${chatUrl}/webhooks/github`,{method:'POST',headers,body:raw});
}
async function purchases(){return client.listPurchases(owner.userId);}
async function processEvent(data=payload()){const response=await webhook(data);assert.equal(response.status,202);await engine.tick();return (await purchases()).at(-1)!;}
async function due(){now+=60_000;await db.query('UPDATE purchases SET next_attempt_at=now()');}
function text(replies:{text:string}[]){return replies.map(r=>r.text).join('\n');}

// Exercises the actual bot controller, client, servers, PostgreSQL, payments boundary and sender.
test('complete guided Telegram -> signed GitHub -> policy -> fake payment -> private redemption -> ACK',async()=>{
  const health=await client.health();assert.equal(health.livePurchasesEnabled,false);
  assert.equal((await fetch(`${chatUrl}/healthz`)).status,200);
  await controller.handleCommand(owner,'newrule','');
  await controller.handleText(owner,'UserAkku/buyoncue');await controller.handleText(owner,'reward-ready');
  const search=await controller.handleText(owner,'flipkart');assert.match(JSON.stringify(search),/TEST MOCK Indian/);
  await controller.handleCallback(owner,'pr:0');await controller.handleCallback(owner,'pk:0');
  await controller.handleText(owner,recipient);
  for(const cap of ['2','5','20'])await controller.handleText(owner,cap);
  const draft=await controller.handleText(owner,'1.50');assert.match(text(draft),/draft/);
  const saved=(await client.listRules(owner.userId))[0];assert.equal(saved.status,'draft');assert.equal(saved.repository,'userakku/buyoncue');assert.equal(saved.recipientChatId,recipient);
  assert.equal(payments.creates.length,0);
  const enable=await controller.handleCallback(owner,`en:${saved.id}`);assert.equal(enable.toast,'Rule enabled');
  const response=await webhook();assert.equal(response.status,202);assert.equal((await response.json() as {reason:string}).reason,'queued');
  const event=(await db.query('SELECT payload FROM trigger_events')).rows[0].payload;assert.equal(event.repository,'userakku/buyoncue');assert.equal(event.prNumber,42);assert.ok(!('body' in event));
  await engine.tick();const p=(await purchases())[0];assert.equal(p.status,'TEST_DELIVERED');assert.match(p.invoiceId!,/^TEST-MOCK-/);assert.equal(p.amountUsdCents,125);
  assert.deepEqual(payments.creates,[{productId:product.id,packageId:product.packages[0].packageId,purchaseId:p.id}]);assert.equal(payments.pays.length,1);
  const invoice=(await db.query('SELECT status,order_statuses FROM invoices')).rows[0];assert.equal(invoice.status,'complete');assert.equal(invoice.order_statuses[0].status,'delivered');
  const outbox=JSON.stringify((await db.query('SELECT * FROM notification_outbox')).rows);assert.ok(!outbox.includes('TEST-MOCK-NOT-REDEEMABLE'));
  const pending=await client.listNotifications(100);const delivery=pending.find(n=>n.type==='test_purchase_delivered')!;assert.equal(delivery.chatId,recipient);assert.equal(delivery.redemption?.code,'TEST-MOCK-NOT-REDEEMABLE');
  await worker.tick();assert.equal((await client.listNotifications(100)).length,0);
  assert.ok(sent.find(n=>n.chatId===recipient&&n.html.includes('TEST MODE')&&n.html.includes('TEST-MOCK-NOT-REDEEMABLE')));
  assert.ok(sent.find(n=>n.chatId===owner.userId&&n.html.includes(p.invoiceId!)&&n.html.includes('delivery verified')));
  assert.ok(sent.filter(n=>n.chatId===owner.userId).every(n=>!n.html.includes('TEST-MOCK-NOT-REDEEMABLE')));
  for (const n of pending) assert.ok(timeline.indexOf(`send:${n.chatId}`)<timeline.indexOf(`ack:${n.id}`));
  assert.ok(!logs.join('').includes('TEST-MOCK-NOT-REDEEMABLE'));assert.ok(!JSON.stringify(await purchases()).includes('TEST-MOCK-NOT-REDEEMABLE'));
  assert.equal((await db.query('SELECT redemption_ciphertext FROM notification_outbox WHERE id=$1',[delivery.id])).rows[0].redemption_ciphertext,null);
});

test('natural-language proposal uses real client catalogue, explicit caps and draft enable confirmation',async()=>{
  const c=makeController({async interpret(){return {intent:'create_rule',repository:'UserAkku/buyoncue',requiredLabel:'reward-ready',productQuery:'flipkart',country:'IN',packageValue:50,packageCurrency:'INR',budgetHints:[]};}});
  await c.handleText(owner,'Reward a merged PR with an Indian gift card');await c.handleCallback(owner,'pr:0');await c.handleText(owner,recipient);
  for(const cap of ['2','5','20','1.50'])await c.handleText(owner,cap);
  assert.equal((await client.listRules(owner.userId))[0].status,'draft');assert.equal(payments.pays.length,0);
});
for(const signature of [null,'sha256=00','sha256='+'0'.repeat(64),'valid-with-junk'])test(`rejects missing/invalid signature ${signature===null?'missing':signature.length}`,async()=>{await rule();assert.equal((await webhook(payload(),randomUUID(),signature)).status,401);assert.equal((await purchases()).length,0);});
for(const [name,change,event] of [
  ['unmerged PR',{pull_request:{...payload().pull_request,merged:false}},'pull_request'],
  ['missing label',{pull_request:{...payload().pull_request,labels:[]}},'pull_request'],
  ['unauthorized repository',{repository:{full_name:'evil/repo'}},'pull_request'],
  ['unrelated event',{},'issues'],
  ['open PR',{action:'opened'},'pull_request']
] as const)test(`no purchase for ${name}`,async()=>{await rule();await webhook(payload(change),randomUUID(),'valid',event);await engine.tick();assert.equal(payments.creates.length,0);});
test('repository casing matches safely',async()=>{await rule();const p=await processEvent(payload({repository:{full_name:'USERAKKU/BUYONCUE'}}));assert.equal(p.status,'TEST_DELIVERED');});
test('disabled and paused rules never purchase',async()=>{const r=await rule({},false);await processEvent();assert.equal(payments.pays.length,0);await client.enableRule(r.id,owner.userId);await client.pauseRule(r.id,owner.userId);await processEvent();assert.equal(payments.creates.length,0);await client.resumeRule(r.id,owner.userId);await processEvent();assert.equal(payments.pays.length,1);});
test('unknown recipient and wrong package are rejected before enabling or payment',async()=>{
  await assert.rejects(client.createRule(ruleBody({recipientChatId:'9999'})));await assert.rejects(client.createRule(ruleBody({packageId:'invented'})));await assert.rejects(client.createRule(ruleBody({productId:'invented'})));
  assert.equal((await client.listRules(owner.userId)).length,0);assert.equal(payments.pays.length,0);
});
test('chat refuses an unlinked recipient even when their ID is syntactically valid',async()=>{
  const draft={repository:'UserAkku/buyoncue',requiredLabel:'reward-ready',product,pkg:product.packages[0],recipientChatId:'9999',perPurchaseCapUsdCents:200,dailyCapUsdCents:500,monthlyCapUsdCents:2000,autoApproveUpToUsdCents:150};
  await assert.rejects(controller.createDraftRule(owner.userId,draft),/verified/);assert.equal((await client.listRules(owner.userId)).length,0);
});
test('duplicate delivery, different deliveries for same PR, concurrent requests and workers charge once',async()=>{
  await rule();const id=randomUUID();await Promise.all([webhook(payload(),id),webhook(payload(),id),webhook(),webhook()]);
  await Promise.all([engine.tick(),buildEngine().tick()]);await engine.tick();assert.equal(payments.creates.length,1);assert.equal(payments.pays.length,1);assert.equal((await purchases()).length,1);
});
for(const [name,caps] of [['per-purchase',{perPurchaseCapUsdCents:100,autoApproveUpToUsdCents:100}],['daily',{perPurchaseCapUsdCents:200,dailyCapUsdCents:200}],['monthly',{perPurchaseCapUsdCents:200,dailyCapUsdCents:200,monthlyCapUsdCents:200}]] as const)test(`${name} cap blocks excess payment atomically`,async()=>{
  await rule(caps);
  if(name==='per-purchase'){const p=await processEvent();assert.equal(p.errorCode,'BUDGET_EXCEEDED');assert.equal(payments.pays.length,0);return;}
  await processEvent();if(name==='monthly')await db.query("UPDATE spending_ledger SET committed_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
  await Promise.all([webhook(payload({pull_request:{...payload().pull_request,number:43}})),webhook(payload({pull_request:{...payload().pull_request,number:44}}))]);
  const pending=(await purchases()).filter(p=>p.status==='QUEUED');await Promise.all(pending.map(p=>engine.process(p.id)));assert.equal(payments.pays.length,1);assert.equal((await purchases()).filter(p=>p.errorCode==='BUDGET_EXCEEDED').length,2);
});
test('approval must come from owner and uses the real purchase ID, then pays once',async()=>{
  await rule({autoApproveUpToUsdCents:100});const p=await processEvent();assert.equal(p.status,'PENDING_APPROVAL');assert.equal(payments.pays.length,0);
  await worker.tick();assert.ok(JSON.stringify(sent).includes(`ap:${p.id}`));
  const denied=await controller.handleCallback({userId:'9999',chatId:'9999',chatType:'private'},`ap:${p.id}`);assert.equal(denied.toast,'Not authorized');
  await assert.rejects(client.decideApproval(p.id,'9999','approve'));assert.equal(payments.pays.length,0);
  assert.equal((await controller.handleCallback(owner,`ap:${p.id}`)).toast,'Approved');await engine.tick();assert.equal(payments.pays.length,1);
});
test('expired approval and explicit rejection cannot pay',async()=>{
  await rule({autoApproveUpToUsdCents:100});const p=await processEvent();await db.query("UPDATE approvals SET expires_at=now()-interval '1 second'");await assert.rejects(client.decideApproval(p.id,owner.userId,'approve'));assert.equal(payments.pays.length,0);
  const p2=await processEvent(payload({pull_request:{...payload().pull_request,number:43}}));await client.decideApproval(p2.id,owner.userId,'reject');await engine.tick();assert.equal(payments.pays.length,0);
});
test('unknown invoice currency blocks payment; denomination is never a USD price',async()=>{payments.currency='INR';await rule();const p=await processEvent();assert.equal(p.errorCode,'UNSAFE_INVOICE_PRICE');assert.equal(payments.pays.length,0);});
test('actual invoice price, not card face value or estimate, enforces cap',async()=>{payments.price='2.01';await rule();const p=await processEvent();assert.equal(p.errorCode,'BUDGET_EXCEEDED');assert.equal(payments.pays.length,0);});
test('unknown invoice price blocks payment',async()=>{payments.price=undefined;await rule();assert.equal((await processEvent()).errorCode,'UNSAFE_INVOICE_PRICE');assert.equal(payments.pays.length,0);});
test('changed invoice charge after approval does not inherit old authorization',async()=>{await rule({autoApproveUpToUsdCents:100});const p=await processEvent();await client.decideApproval(p.id,owner.userId,'approve');payments.price='1.26';await engine.tick();assert.equal((await purchases())[0].errorCode,'INVOICE_CHANGED');assert.equal(payments.pays.length,0);});
for(const cause of ['timeout','insufficient'] as const)test(`${cause} stays uncertain across worker restart and never retries payment`,async()=>{
  payments[cause]=true;await rule();const p=await processEvent();assert.equal(p.status,'PAYMENT_UNCERTAIN');assert.equal(payments.pays.length,1);
  engine=buildEngine();await due();await engine.tick();await due();await engine.tick();assert.equal(payments.pays.length,1);assert.equal(payments.creates.length,1);
  assert.equal((await db.query('SELECT state FROM spending_ledger')).rows[0].state,'reserved');
  payments.paid.add(p.invoiceId!);await due();await engine.tick();assert.equal((await purchases())[0].status,'TEST_DELIVERED');assert.equal(payments.pays.length,1);
});
test('complete invoice with failed order is not delivered and paid budget remains counted',async()=>{payments.orderFailed=true;await rule();const p=await processEvent();assert.equal(p.status,'FAILED');assert.ok(!(await client.listNotifications(100)).some(n=>n.type==='test_purchase_delivered'));assert.equal((await db.query('SELECT state FROM spending_ledger')).rows[0].state,'committed');});
test('duplicate Bitrefill webhooks cannot duplicate redemption notification',async()=>{
  payments.timeout=true;await rule();const p=await processEvent();payments.paid.add(p.invoiceId!);
  for(let i=0;i<2;i++)await fetch(`${engineUrl}/webhooks/bitrefill`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.invoiceId,status:'complete',redemption_info:'UNTRUSTED'})});
  await Promise.all([engine.tick(),buildEngine().tick()]);await worker.tick();await worker.tick();assert.equal(sent.filter(s=>s.html.includes('TEST-MOCK-NOT-REDEEMABLE')).length,1);assert.equal(payments.pays.length,1);
});
for(const outage of ['send','lookup'])test(`Telegram ${outage} outage retains encrypted redemption and recovers`,async()=>{
  await rule();await processEvent();failTelegram=outage==='send';lookupUnavailable=outage==='lookup';await worker.tick();
  assert.ok((await client.listNotifications(100)).some(n=>n.type==='test_purchase_delivered'));assert.ok(!logs.join('').includes('TEST-MOCK-NOT-REDEEMABLE'));
  failTelegram=false;lookupUnavailable=false;now+=60_000;await worker.tick();assert.equal(sent.filter(n=>n.html.includes('TEST-MOCK-NOT-REDEEMABLE')).length,1);
});
test('failed ACK retries ACK only, not a second Telegram delivery',async()=>{
  await rule();await processEvent();const original=client.ackNotification.bind(client);let fail=true;
  client.ackNotification=async id=>{if(fail)throw new Error('TEST ack outage');await original(id);};
  await worker.tick();const count=sent.length;assert.ok(count>0);fail=false;now+=60_000;await worker.tick();assert.equal(sent.length,count);assert.equal((await client.listNotifications(100)).length,0);
});
test('HTTP authentication rejects incorrect internal token',async()=>{const bad=new EngineClient({baseUrl:engineUrl,token:'incorrect'});await assert.rejects(bad.listRules(owner.userId),{kind:'unauthorized'});assert.equal(payments.pays.length,0);});
test('engine offline surfaces a retryable webhook error, redelivery succeeds safely',async()=>{
  await rule();const old=engineUrl;await api.close();assert.equal((await webhook()).status,502);await assert.rejects(client.listRules(owner.userId));
  const port=Number(new URL(old).port);api=buildApp(engine,token);engineUrl=await api.listen({host:'127.0.0.1',port});await processEvent();assert.equal(payments.pays.length,1);
});
test('grammY real update handlers use real HTTP client and restrict owner controls',async()=>{
  const bot=createBot({token:'123:TEST-ONLY',controller,logger,botInfo:{id:123,is_bot:true,first_name:'TEST',username:'test_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false} as never});
  const calls:{method:string;payload:unknown}[]=[];bot.api.config.use(async(_prev,method,payload)=>{calls.push({method,payload});return {ok:true,result:true} as never;});
  const msg=(id:number,command:string)=>({update_id:id,message:{message_id:1,date:0,chat:{id,type:'private',first_name:'TEST'},from:{id,is_bot:false,first_name:'TEST'},text:command}});
  for(const command of ['/start','/help','/whoami','/rules','/status','/enable','/pause','/resume'])await bot.handleUpdate(msg(1001,command) as never);
  const denied=await controller.handleCommand({userId:'9999',chatId:'9999',chatType:'private'},'newrule','');assert.match(text(denied),/Only its owner/);
  assert.ok(calls.filter(c=>c.method==='sendMessage').length>=8);assert.equal(payments.pays.length,0);
});
test('built-in test adapter uses PostgreSQL state across adapter restarts and clearly marks synthetic redemption',async()=>{
  const adapter=new TestPurchasing(catalogue,db);engine=new Engine(db,catalogue,adapter,false,box,60,undefined,recipient);await rule();
  const p=await processEvent();assert.equal(p.status,'TEST_DELIVERED');assert.match(p.invoiceId!,/^test:/);assert.equal(payments.pays.length,0);
  assert.equal((await new TestPurchasing(catalogue,db).invoice(p.invoiceId!)).status,'complete');
});

test('recipient is revalidated before enable or resume',async()=>{
  const r=await rule({},false);lookupUnavailable=true;
  const result=await controller.handleCallback(owner,`en:${r.id}`);
  assert.equal(result.toast,undefined);assert.equal((await client.listRules(owner.userId))[0].status,'draft');assert.equal(payments.pays.length,0);
});
test('reconfiguring the allowed recipient cannot authorize an older queued rule',async()=>{
  await rule();await webhook();engine=new Engine(db,catalogue,payments,false,box,60,undefined,'4004');await engine.tick();
  assert.equal(payments.creates.length,0);assert.equal((await purchases())[0].status,'FAILED');
});
test('empty or extra invoice orders fail before any payment',async()=>{
  const original=payments.invoice.bind(payments);payments.invoice=async id=>({...await original(id),orders:[]});await rule();
  assert.equal((await processEvent()).errorCode,'UNEXPECTED_INVOICE_ORDERS');assert.equal(payments.pays.length,0);
});

test('new GitHub App client contract mismatch is rejected safely by the actual engine',async()=>{
  await assert.rejects(client.linkGithub({githubUserId:'202',githubLogin:'contributor',telegramUserId:recipient,chatId:recipient}),{kind:'http',status:400});
  assert.equal(payments.creates.length,0);
});
