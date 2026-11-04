import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Engine } from '../src/engine.js';
import { buildApp } from '../src/app.js';
import { SecretBox } from '../src/crypto.js';
import { TestPurchasing } from '../src/bitrefill.js';
import { FakeCatalogue, FakePurchasing, fixtureProduct } from './fakes.js';
import type { RuleInput, TriggerInput } from '../src/schemas.js';

const url=process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required: integration tests use real PostgreSQL in an isolated schema.');
const schema=`engine_test_${randomUUID().replaceAll('-','')}`;
const base=database(url);
let db: Db;
let provider: FakePurchasing;
let engine: Engine;
const box=new SecretBox('42'.repeat(32));
const token='test-internal-token-32-characters-long';
const ruleInput: RuleInput = {
  ownerChatId:'123',recipientChatId:'456',name:'PR reward',repository:'owner/repo',requiredLabel:'reward-ready',
  productId:fixtureProduct.id,packageId:fixtureProduct.packages[0]!.packageId,
  perPurchaseCapUsdCents:200,dailyCapUsdCents:500,monthlyCapUsdCents:2000,autoApproveUpToUsdCents:150
};
const event=(overrides:Partial<TriggerInput>={}):TriggerInput=>({deliveryId:randomUUID(),repository:'owner/repo',prNumber:42,
  merged:true,labels:['reward-ready'],authorLogin:'contributor',mergedAt:'2026-11-04T12:00:00Z',...overrides});
async function enabled(overrides:Partial<RuleInput>={}) {
  const r=await engine.createRule({...ruleInput,...overrides});
  await engine.changeRule(String(r.id),'123','enable');return r;
}
async function buy(overrides:Partial<TriggerInput>={}) {await engine.trigger(event(overrides));await engine.tick();return (await engine.listPurchases('123'))[0]!;}
async function notes() {return engine.notifications(100);}
async function due() {await db.query('UPDATE purchases SET next_attempt_at=now()');}

beforeAll(async()=>{
  await base.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema}`);
  db=database(connection.toString());await migrate(db);await migrate(db);
});
afterAll(async()=>{if(db)await db.end();await base.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await base.end();});
beforeEach(async()=>{
  await db.query('TRUNCATE notification_outbox,invoices,approvals,spending_ledger,purchases,trigger_events,commerce_rules CASCADE');
  provider=new FakePurchasing();engine=new Engine(db,new FakeCatalogue(),provider,true,box);
});

describe('Rules and trusted event eligibility',()=>{
  it('creates rules disabled/draft with no purchase',async()=>{
    const rule=await engine.createRule(ruleInput);expect(rule.status).toBe('draft');
    expect((await engine.trigger(event())).reason).toBe('no_eligible_rule');expect(await engine.listPurchases('123')).toEqual([]);
  });
  it('rejects wrong repository',async()=>{await enabled();expect((await engine.trigger(event({repository:'evil/repo'}))).reason).toBe('no_eligible_rule');await engine.tick();expect(provider.creates).toBe(0);});
  it('rejects missing label',async()=>{await enabled();await buy({labels:[]});expect(provider.creates).toBe(0);});
  it('rejects unmerged PR',async()=>{await enabled();expect((await engine.trigger(event({merged:false}))).reason).toBe('not_merged');await engine.tick();expect(provider.creates).toBe(0);});
  it('processes a valid PR once with real charge separate from INR face value',async()=>{
    await enabled();const p=await buy();expect(p.status).toBe('DELIVERED');expect(p.amountUsdCents).toBe(100);expect(provider.pays).toBe(1);
    expect(p.invoiceId).toBeTruthy();expect((await notes()).filter(n=>n.type==='purchase_delivered')).toHaveLength(1);
  });
  it('deduplicates concurrent deliveries for the same PR across workers',async()=>{
    await enabled();await Promise.all([engine.trigger(event()),engine.trigger(event())]);
    const other=new Engine(db,new FakeCatalogue(),provider,true,box);
    await Promise.all([engine.tick(),other.tick()]);await engine.tick();
    expect(provider.creates).toBe(1);expect(provider.pays).toBe(1);expect(await engine.listPurchases('123')).toHaveLength(1);
    expect((await notes()).some(n=>n.type==='duplicate_event_skipped')).toBe(true);
  });
  it('deduplicates identical delivery IDs',async()=>{
    await enabled();const e=event();const a=await engine.trigger(e);const b=await engine.trigger(e);expect(b.eventId).toBe(a.eventId);expect(b.reason).toBe('duplicate_delivery');
  });
  it('rejects invalid recipient and inconsistent caps',async()=>{
    await expect(engine.createRule({...ruleInput,recipientChatId:'0'})).rejects.toThrow();
    await expect(engine.createRule({...ruleInput,dailyCapUsdCents:100})).rejects.toThrow();
    expect(provider.creates).toBe(0);
  });
  it('requires an exact verified package',async()=>{
    await expect(engine.createRule({...ruleInput,packageId:'invented'})).rejects.toMatchObject({code:'INVALID_PACKAGE'});
  });
  it('checks ownership and pause/resume before spending',async()=>{
    const r=await enabled();await expect(engine.changeRule(String(r.id),'999','pause')).rejects.toMatchObject({code:'RULE_NOT_FOUND'});
    await engine.trigger(event());await engine.changeRule(String(r.id),'123','pause');await engine.tick();expect(provider.pays).toBe(0);
    expect((await engine.listPurchases('123'))[0]!.status).toBe('FAILED');
    await engine.changeRule(String(r.id),'123','resume');await buy({prNumber:43});expect(provider.pays).toBe(1);
  });
  it('protects enabled recipient and repository with a database constraint',async()=>{
    const r=await enabled();await expect(db.query("UPDATE commerce_rules SET recipient_chat_id='999' WHERE id=$1",[r.id])).rejects.toThrow('immutable');
    await expect(db.query("UPDATE commerce_rules SET repository='evil/repo' WHERE id=$1",[r.id])).rejects.toThrow('immutable');
  });
});

describe('Atomic budgets and approvals',()=>{
  it('blocks hard per-purchase cap before payment',async()=>{
    await enabled({perPurchaseCapUsdCents:99,autoApproveUpToUsdCents:99});const p=await buy();expect(p.status).toBe('FAILED');expect(p.errorCode).toBe('BUDGET_EXCEEDED');expect(provider.pays).toBe(0);
  });
  it('serializes concurrent reservations against daily cap',async()=>{
    await enabled({perPurchaseCapUsdCents:100,dailyCapUsdCents:100,autoApproveUpToUsdCents:100});
    await Promise.all([engine.trigger(event()),engine.trigger(event({prNumber:43}))]);
    const ids=(await engine.listPurchases('123')).map(p=>String(p.id));await Promise.all(ids.map(id=>engine.process(id)));
    expect(provider.pays).toBe(1);expect((await engine.listPurchases('123')).filter(p=>p.errorCode==='BUDGET_EXCEEDED')).toHaveLength(1);
  });
  it('enforces monthly cap separately from daily cap',async()=>{
    const r=await enabled({perPurchaseCapUsdCents:100,dailyCapUsdCents:100,monthlyCapUsdCents:100,autoApproveUpToUsdCents:100});
    await buy();await db.query("UPDATE spending_ledger SET committed_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' WHERE rule_id=$1",[r.id]);
    const first=(await engine.listPurchases('123'))[0]!;
    await engine.trigger(event({prNumber:43}));await engine.tick();expect(provider.pays).toBe(1);
    expect((await engine.listPurchases('123')).find(p=>p.id!==first.id)!.errorCode).toBe('BUDGET_EXCEEDED');
  });
  it('requires owner approval above automatic threshold',async()=>{
    await enabled({autoApproveUpToUsdCents:50});const p=await buy();expect(p.status).toBe('PENDING_APPROVAL');expect(provider.pays).toBe(0);
    await expect(engine.approval(String(p.id),'999','approve')).rejects.toMatchObject({code:'PURCHASE_NOT_FOUND'});
    await engine.approval(String(p.id),'123','approve');await engine.tick();expect(provider.pays).toBe(1);
    expect((await engine.listPurchases('123'))[0]!.status).toBe('DELIVERED');
    await expect(engine.approval(String(p.id),'123','approve')).rejects.toMatchObject({code:'APPROVAL_NOT_PENDING'});
  });
  it('does not let approval override hard caps',async()=>{
    const r=await enabled({autoApproveUpToUsdCents:50});const p=await buy();
    await db.query('UPDATE commerce_rules SET per_purchase_cap_usd_cents=75 WHERE id=$1',[r.id]);
    await expect(engine.approval(String(p.id),'123','approve')).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});expect(provider.pays).toBe(0);
  });
  it('expires pending approval and releases unspent reservation',async()=>{
    await enabled({autoApproveUpToUsdCents:50});const p=await buy();
    await db.query("UPDATE approvals SET expires_at=now()-interval '1 second' WHERE purchase_id=$1",[p.id]);
    await expect(engine.approval(String(p.id),'123','approve')).rejects.toMatchObject({code:'APPROVAL_EXPIRED'});
    expect((await engine.listPurchases('123'))[0]!.status).toBe('FAILED');
    expect((await db.query('SELECT state FROM spending_ledger')).rows[0].state).toBe('released');
  });
  it('reconciles pending expiration in the durable worker',async()=>{
    await enabled({autoApproveUpToUsdCents:50});await buy();await db.query("UPDATE approvals SET expires_at=now()-interval '1 second'");await due();await engine.tick();
    expect((await engine.listPurchases('123'))[0]!.errorCode).toBe('APPROVAL_EXPIRED');
  });
  it('rejecting approval never pays',async()=>{
    await enabled({autoApproveUpToUsdCents:50});const p=await buy();await engine.approval(String(p.id),'123','reject');await engine.tick();expect(provider.pays).toBe(0);
  });
  it('blocks an invoice price change after approval',async()=>{
    await enabled({autoApproveUpToUsdCents:50});const p=await buy();await engine.approval(String(p.id),'123','approve');provider.price='1.01';await engine.tick();
    expect(provider.pays).toBe(0);expect((await engine.listPurchases('123'))[0]!.errorCode).toBe('INVOICE_CHANGED');
  });
  it('carries old uncertain reservations into current budgets',async()=>{
    await enabled({perPurchaseCapUsdCents:100,dailyCapUsdCents:100,autoApproveUpToUsdCents:100});provider.timeout=true;await buy();
    await db.query("UPDATE spending_ledger SET reserved_at=now()-interval '40 days'");provider.timeout=false;
    await engine.trigger(event({prNumber:43}));await engine.tick();expect(provider.pays).toBe(1);
    expect((await engine.listPurchases('123')).some(p=>p.errorCode==='BUDGET_EXCEEDED')).toBe(true);
  });
});

describe('Provider uncertainty, delivery and secrets',()=>{
  it.each([{price:undefined,currency:'USD'},{price:'1.00',currency:'INR'},{price:'1.001',currency:'USD'}])('blocks unknown or unsafe price %j',async({price,currency})=>{
    provider.price=price;provider.currency=currency;await enabled();const p=await buy();expect(p.errorCode).toBe('UNSAFE_INVOICE_PRICE');expect(provider.pays).toBe(0);
  });
  it('keeps timeout uncertain across restarts without repeat payment or invoice',async()=>{
    provider.timeout=true;await enabled();const p=await buy();expect(p.status).toBe('PAYMENT_UNCERTAIN');
    engine=new Engine(db,new FakeCatalogue(),provider,true,box);await due();await engine.tick();await due();await engine.tick();
    expect(provider.pays).toBe(1);expect(provider.creates).toBe(1);
    expect((await db.query('SELECT state FROM spending_ledger')).rows[0].state).toBe('reserved');
  });
  it('recovers delivery after a lost payment response using the existing invoice',async()=>{
    provider.timeout=true;await enabled();const p=await buy();provider.paid.add(String(p.invoiceId));await due();await engine.tick();
    expect((await engine.listPurchases('123'))[0]!.status).toBe('DELIVERED');expect(provider.pays).toBe(1);expect(provider.creates).toBe(1);
  });
  it('quarantines lost creation response without creating a second invoice',async()=>{
    provider.failCreate=true;await enabled();await buy();await due();await engine.tick();await due();await engine.tick();
    expect(provider.creates).toBe(1);expect(provider.pays).toBe(0);expect((await engine.listPurchases('123'))[0]!.status).toBe('INVOICE_UNCERTAIN');
  });
  it('a final invoice with failed order is not delivered and does not free paid budget',async()=>{
    provider.failedOrder=true;await enabled();const p=await buy();expect(p.status).toBe('FAILED');expect((await notes()).some(n=>n.type==='purchase_delivered')).toBe(false);
    expect((await db.query('SELECT state FROM spending_ledger')).rows[0].state).toBe('committed');
  });
  it('awaits redemption instead of claiming an incomplete delivery',async()=>{
    provider.missingRedemption=true;await enabled();await buy();expect((await notes()).some(n=>n.type==='purchase_delivered')).toBe(false);
    provider.missingRedemption=false;await due();await engine.tick();expect((await engine.listPurchases('123'))[0]!.status).toBe('DELIVERED');
  });
  it('duplicate webhook does not duplicate delivery; forged status is not proof',async()=>{
    provider.timeout=true;await enabled();const p=await buy();await engine.webhook(String(p.invoiceId));await engine.tick();expect((await notes()).some(n=>n.type==='purchase_delivered')).toBe(false);
    provider.paid.add(String(p.invoiceId));await Promise.all([engine.webhook(String(p.invoiceId)),engine.webhook(String(p.invoiceId))]);await engine.tick();
    await engine.webhook(String(p.invoiceId));await engine.tick();expect((await notes()).filter(n=>n.type==='purchase_delivered')).toHaveLength(1);
  });
  it('encrypts redemption at rest, redacts purchase list, clears secrets on idempotent ack',async()=>{
    await enabled();await buy();const rows=await db.query('SELECT * FROM notification_outbox');
    expect(JSON.stringify(rows.rows)).not.toContain('TEST-SECRET-CODE');expect(JSON.stringify(await engine.listPurchases('123'))).not.toContain('TEST-SECRET-CODE');
    const n=(await notes()).find(n=>n.type==='purchase_delivered')!;expect(n.chatId).toBe('456');expect(n.redemption).toMatchObject({code:'TEST-SECRET-CODE'});
    await engine.ack(n.id);await engine.ack(n.id);expect((await notes()).some(x=>x.id===n.id)).toBe(false);
    expect((await db.query('SELECT redemption_ciphertext FROM notification_outbox WHERE id=$1',[n.id])).rows[0].redemption_ciphertext).toBeNull();
  });
  it('disabled mode cannot construct a live purchasing engine',()=>{
    expect(()=>new Engine(db,new FakeCatalogue(),provider,false,box)).toThrow('forbidden');
  });
  it('disabled mode simulates durably with no live payment or genuine redemption',async()=>{
    engine=new Engine(db,new FakeCatalogue(),new TestPurchasing(),false,box);await enabled();const p=await buy();
    expect(p.status).toBe('TEST_DELIVERED');expect(String(p.invoiceId)).toMatch(/^test:/);expect(provider.creates).toBe(0);expect(provider.pays).toBe(0);
    expect((await notes()).find(n=>n.type==='test_purchase_delivered')!.redemption).toBeNull();
  });
  it('disabling new spending still reconciles an existing paid invoice with read-only calls',async()=>{
    provider.timeout=true;await enabled();const p=await buy();provider.paid.add(String(p.invoiceId));
    engine=new Engine(db,new FakeCatalogue(),new TestPurchasing(),false,box,900,provider);
    await due();await engine.tick();expect((await engine.listPurchases('123'))[0]!.status).toBe('DELIVERED');
    expect(provider.pays).toBe(1);expect(provider.creates).toBe(1);
  });
  it('blocks unexpected products in an invoice before paying',async()=>{
    const original=provider.order.bind(provider);provider.order=async id=>({...await original(id),productId:'another-product'});
    await enabled();const p=await buy();expect(p.errorCode).toBe('INVOICE_ORDER_MISMATCH');expect(provider.pays).toBe(0);
  });
});

describe('HTTP contract',()=>{
  it('implements health, auth, products, rules, triggers, purchases, notifications and ack',async()=>{
    const app=buildApp(engine,token);const headers={authorization:`Bearer ${token}`};
    try {
      expect((await app.inject({url:'/health'})).json()).toEqual({ok:true,service:'engine',livePurchasesEnabled:true});
      expect((await app.inject({url:'/v1/rules?ownerChatId=123'})).statusCode).toBe(401);
      const search=await app.inject({url:'/v1/products/search?query=gift&country=IN',headers});expect(search.json().products[0]).toEqual(fixtureProduct);
      expect((await app.inject({url:`/v1/products/${fixtureProduct.id}`,headers})).json().product).toEqual(fixtureProduct);
      const r=await app.inject({method:'POST',url:'/v1/rules',headers,payload:ruleInput});expect(r.statusCode).toBe(201);const id=r.json().rule.id;
      for (const action of ['enable','pause','resume']) expect((await app.inject({method:'POST',url:`/v1/rules/${id}/${action}`,headers,payload:{ownerChatId:'123'}})).statusCode).toBe(200);
      expect((await app.inject({url:'/v1/rules?ownerChatId=123',headers})).json().rules).toHaveLength(1);
      const t=await app.inject({method:'POST',url:'/v1/triggers/github',headers,payload:event()});expect(t.statusCode).toBe(202);expect(t.json().reason).toBe('queued');await engine.tick();
      expect((await app.inject({url:'/v1/purchases?ownerChatId=123',headers})).json().purchases[0].status).toBe('DELIVERED');
      const ns=(await app.inject({url:'/v1/notifications?limit=20',headers})).json().items;expect(ns.length).toBeGreaterThan(0);
      const ack=await app.inject({method:'POST',url:`/v1/notifications/${ns[0].id}/ack`,headers});expect(ack.json()).toEqual({ok:true});
      const hook=await app.inject({method:'POST',url:'/webhooks/bitrefill',payload:{id:randomUUID(),status:'complete',orders:[],redemption_info:'FORGED'}});expect(hook.json()).toEqual({ok:true});
    } finally {await app.close();}
  });
  it('approval route, ownership, validation, errors and unknown endpoints',async()=>{
    await enabled({autoApproveUpToUsdCents:50});const p=await buy();const app=buildApp(engine,token);const headers={authorization:`Bearer ${token}`};
    try {
      const res=await app.inject({method:'POST',url:`/v1/approvals/${p.id}`,headers,payload:{ownerChatId:'123',decision:'approve'}});expect(res.json()).toEqual({ok:true});
      const bad=await app.inject({url:'/v1/rules?ownerChatId=0',headers});expect(bad.statusCode).toBe(400);expect(bad.json().error.code).toBe('INVALID_INPUT');
      expect((await app.inject({url:'/v1/no-such-route',headers})).json().error.code).toBe('NOT_FOUND');
      expect((await app.inject({url:'/v1/notifications?limit=1000',headers})).statusCode).toBe(400);
    } finally {await app.close();}
  });
});
