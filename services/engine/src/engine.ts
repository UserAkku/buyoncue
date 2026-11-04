import { randomUUID } from 'node:crypto';
import { type Catalogue, type Purchasing, type Invoice, type Order, type Redemption, invoiceCents } from './bitrefill.js';
import { type Db, type Sql, publicRow, transaction } from './db.js';
import { AppError } from './errors.js';
import { SecretBox } from './crypto.js';
import { chatId, ruleSchema, triggerSchema, type RuleInput, type TriggerInput } from './schemas.js';

interface Rule {
  id: string; owner_chat_id: string; recipient_chat_id: string; name: string; repository: string;
  required_label: string; product_id: string; package_id: string; status: string;
  per_purchase_cap_usd_cents: number; daily_cap_usd_cents: number; monthly_cap_usd_cents: number;
  auto_approve_up_to_usd_cents: number;
}
interface Purchase {
  id: string; rule_id: string; status: string; invoice_id: string | null; amount_usd_cents: number | null;
  mode: 'live' | 'test'; payment_attempted_at: Date | null;
}
interface Note {
  key: string; chatId: string; type: string; text: string; purchaseId?: string;
  invoiceId?: string | null; approvalPurchaseId?: string; redemption?: Redemption;
}
const activeStatuses = ['QUEUED','INVOICE_CREATING','QUOTED','PENDING_APPROVAL','READY_TO_PAY','PAYMENT_PROCESSING','PAYMENT_UNCERTAIN'];
const terminalInvoice = new Set(['denied', 'payment_error', 'blocked']);

export class Engine {
  constructor(readonly db: Db, readonly catalogue: Catalogue, readonly purchasing: Purchasing,
    readonly liveEnabled: boolean, private secrets: SecretBox, private approvalTtl = 900,
    private readOnlyReconciler?: Pick<Purchasing,'invoice'|'order'>,
    private authorizedRecipientChatId?: string) {
    if (purchasing.mode === 'live' && !liveEnabled) throw new Error('Live purchasing adapter forbidden while disabled');
  }
  private async notify(c: Sql, n: Note) {
    const id = randomUUID();
    const context = `${id}:${n.chatId}:${n.purchaseId ?? ''}`;
    await c.query(`INSERT INTO notification_outbox
      (id,dedupe_key,chat_id,type,text,purchase_id,invoice_id,approval_purchase_id,redemption_ciphertext)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
    [id,n.key,n.chatId,n.type,n.text,n.purchaseId ?? null,n.invoiceId ?? null,n.approvalPurchaseId ?? null,
      n.redemption ? this.secrets.seal(n.redemption, context) : null]);
  }
  async validatePackage(productId: string, packageId: string) {
    const p = await this.catalogue.product(productId);
    if (p.id !== productId || !p.inStock || !p.packages.some(x => x.packageId === packageId)) {
      throw new AppError('INVALID_PACKAGE', 'Select an exact in-stock catalogue product and package');
    }
    return p;
  }
  async createRule(input: RuleInput) {
    const r = ruleSchema.parse(input);
    if (this.authorizedRecipientChatId && r.recipientChatId!==this.authorizedRecipientChatId) throw new AppError('RECIPIENT_NOT_AUTHORIZED','Recipient is not the configured pre-linked private chat');
    await this.validatePackage(r.productId, r.packageId);
    const result = await this.db.query(`INSERT INTO commerce_rules
      (id,owner_chat_id,recipient_chat_id,name,repository,required_label,product_id,package_id,
       per_purchase_cap_usd_cents,daily_cap_usd_cents,monthly_cap_usd_cents,auto_approve_up_to_usd_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [randomUUID(),r.ownerChatId,r.recipientChatId,r.name,r.repository,r.requiredLabel,r.productId,r.packageId,
      r.perPurchaseCapUsdCents,r.dailyCapUsdCents,r.monthlyCapUsdCents,r.autoApproveUpToUsdCents]);
    return publicRow(result.rows[0]);
  }
  async listRules(ownerChatId: string) {
    chatId.parse(ownerChatId);
    return (await this.db.query('SELECT * FROM commerce_rules WHERE owner_chat_id=$1 ORDER BY created_at,id', [ownerChatId])).rows.map(publicRow);
  }
  private async ownedRule(c: Sql, id: string, owner: string): Promise<Rule> {
    const { rows } = await c.query<Rule>('SELECT * FROM commerce_rules WHERE id=$1 FOR UPDATE', [id]);
    const r = rows[0];
    if (!r || r.owner_chat_id !== owner) throw new AppError('RULE_NOT_FOUND', 'Rule not found for this owner', 404);
    return r;
  }
  async changeRule(id: string, ownerChatId: string, action: 'enable' | 'pause' | 'resume') {
    chatId.parse(ownerChatId);
    // Check ownership before contacting the catalogue, then re-check under lock.
    const found = await this.db.query<Rule>('SELECT * FROM commerce_rules WHERE id=$1 AND owner_chat_id=$2', [id,ownerChatId]);
    const initial = found.rows[0];
    if (!initial) throw new AppError('RULE_NOT_FOUND', 'Rule not found for this owner', 404);
    if (action !== 'pause') await this.validatePackage(initial.product_id, initial.package_id);
    return transaction(this.db, async c => {
      const r = await this.ownedRule(c,id,ownerChatId);
      if (action!=='pause' && this.authorizedRecipientChatId && r.recipient_chat_id!==this.authorizedRecipientChatId) throw new AppError('RECIPIENT_NOT_AUTHORIZED','Recipient is not the configured pre-linked private chat');
      const target = action === 'pause' ? 'paused' : 'enabled';
      if (r.status === target) return publicRow(r as unknown as Record<string, unknown>);
      if ((action === 'enable' && r.status !== 'draft') || (action === 'resume' && r.status !== 'paused') || (action === 'pause' && r.status !== 'enabled')) {
        throw new AppError('INVALID_RULE_STATE', 'This rule cannot make the requested transition', 409);
      }
      const updated = await c.query(`UPDATE commerce_rules SET status=$2,
        enabled_at=CASE WHEN $2='enabled' THEN COALESCE(enabled_at,now()) ELSE enabled_at END WHERE id=$1 RETURNING *`, [id,target]);
      await this.notify(c,{ key:`rule:${id}:${action}:${randomUUID()}`,chatId:r.owner_chat_id,type:`rule_${target}`,
        text:`Rule ${target}. ${this.liveEnabled ? 'Live purchasing is enabled.' : 'TEST MODE: no real purchases.'}` });
      return publicRow(updated.rows[0]);
    });
  }
  async trigger(input: TriggerInput) {
    const event = triggerSchema.parse(input);
    return transaction(this.db, async c => {
      const eventId = randomUUID();
      const inserted = await c.query(`INSERT INTO trigger_events(id,delivery_id,payload) VALUES($1,$2,$3)
        ON CONFLICT(delivery_id) DO NOTHING RETURNING id`,[eventId,event.deliveryId,event]);
      if (!inserted.rowCount) {
        const old = await c.query('SELECT id FROM trigger_events WHERE delivery_id=$1',[event.deliveryId]);
        return { accepted:true,eventId:old.rows[0].id as string,reason:'duplicate_delivery' };
      }
      let reason = event.merged ? 'no_eligible_rule' : 'not_merged';
      if (event.merged) {
        // Lock matching rules so enable/pause and event acceptance have a defined order.
        const rules = await c.query<Rule>("SELECT * FROM commerce_rules WHERE repository=$1 AND status='enabled' ORDER BY id FOR UPDATE",[event.repository]);
        let count = 0;
        for (const r of rules.rows) {
          if (!event.labels.includes(r.required_label)) continue;
          const purchaseId = randomUUID();
          const purchase = await c.query(`INSERT INTO purchases(id,rule_id,event_id,repository,pr_number,mode,status)
            VALUES($1,$2,$3,$4,$5,$6,'QUEUED') ON CONFLICT(rule_id,repository,pr_number) DO NOTHING RETURNING id`,
          [purchaseId,r.id,eventId,event.repository,event.prNumber,this.purchasing.mode]);
          if (purchase.rowCount) count++;
          else {
            reason='duplicate_pr';
            await this.notify(c,{key:`duplicate:${eventId}:${r.id}`,chatId:r.owner_chat_id,type:'duplicate_event_skipped',text:'Duplicate PR reward skipped.'});
          }
        }
        if (count) reason='queued';
      }
      await c.query('UPDATE trigger_events SET reason=$2 WHERE id=$1',[eventId,reason]);
      return {accepted:true,eventId,reason};
    });
  }
  async listPurchases(ownerChatId: string) {
    chatId.parse(ownerChatId);
    const result = await this.db.query(`SELECT p.id,p.rule_id,p.status,p.invoice_id,p.amount_usd_cents,p.created_at,p.mode,p.error_code
      FROM purchases p JOIN commerce_rules r ON r.id=p.rule_id WHERE r.owner_chat_id=$1 ORDER BY p.created_at,p.id`, [ownerChatId]);
    return result.rows.map(publicRow);
  }
  private async budget(c: Sql, p: Purchase, r: Rule, amount: number) {
    if (amount > r.per_purchase_cap_usd_cents) throw new AppError('BUDGET_EXCEEDED','Per-purchase hard cap exceeded');
    const { rows } = await c.query(`SELECT
      COALESCE(sum(amount_usd_cents) FILTER (WHERE state='reserved' OR committed_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS daily,
      COALESCE(sum(amount_usd_cents) FILTER (WHERE state='reserved' OR committed_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS monthly
      FROM spending_ledger WHERE rule_id=$1 AND mode=$2 AND state <> 'released' AND purchase_id <> $3`,[r.id,p.mode,p.id]);
    if (BigInt(rows[0].daily) + BigInt(amount) > BigInt(r.daily_cap_usd_cents) || BigInt(rows[0].monthly) + BigInt(amount) > BigInt(r.monthly_cap_usd_cents)) {
      throw new AppError('BUDGET_EXCEEDED','Daily or monthly hard cap exceeded');
    }
  }
  private async reserve(c: Sql, p: Purchase, r: Rule, amount: number) {
    await this.budget(c,p,r,amount);
    await c.query(`INSERT INTO spending_ledger(purchase_id,rule_id,mode,amount_usd_cents,state)
      VALUES($1,$2,$3,$4,'reserved') ON CONFLICT(purchase_id) DO UPDATE SET amount_usd_cents=$4,state='reserved'`,[p.id,r.id,p.mode,amount]);
  }
  private async fail(c: Sql, p: Purchase, r: Rule, code: string) {
    await c.query("UPDATE purchases SET status='FAILED',error_code=$2,updated_at=now() WHERE id=$1",[p.id,code]);
    // Once a payment was attempted, keep the charge encumbered until an operator verifies a refund.
    await c.query(`UPDATE spending_ledger SET state=CASE WHEN $2::boolean THEN 'committed' ELSE 'released' END,
      committed_at=CASE WHEN $2::boolean THEN COALESCE(committed_at,now()) ELSE committed_at END WHERE purchase_id=$1`,[p.id,!!p.payment_attempted_at]);
    await this.notify(c,{ key:`failed:${p.id}`,chatId:r.owner_chat_id,type:code==='BUDGET_EXCEEDED'?'budget_exceeded':'purchase_failed',
      text:`${p.mode==='test'?'TEST MODE: ':''}Purchase stopped (${code}).`,purchaseId:p.id,invoiceId:p.invoice_id });
  }
  private async pair(c: Sql, id: string): Promise<{p: Purchase; r: Rule}> {
    // Consistent rule -> purchase lock order across worker, approvals and rule transitions.
    const lookup = await c.query<{rule_id:string}>('SELECT rule_id FROM purchases WHERE id=$1',[id]);
    if (!lookup.rows[0]) throw new AppError('PURCHASE_NOT_FOUND','Purchase not found',404);
    const rule = await c.query<Rule>('SELECT * FROM commerce_rules WHERE id=$1 FOR UPDATE',[lookup.rows[0].rule_id]);
    const purchase = await c.query<Purchase>('SELECT * FROM purchases WHERE id=$1 FOR UPDATE',[id]);
    return { p:purchase.rows[0]!,r:rule.rows[0]! };
  }
  async approval(id: string, owner: string, decision: 'approve' | 'reject') {
    chatId.parse(owner);
    const outcome = await transaction(this.db,async c => {
      const {p,r} = await this.pair(c,id);
      if (r.owner_chat_id !== owner) throw new AppError('PURCHASE_NOT_FOUND','Purchase not found for this owner',404);
      const result = await c.query("SELECT *,expires_at <= now() AS expired FROM approvals WHERE purchase_id=$1 FOR UPDATE",[id]);
      const a = result.rows[0];
      if (p.status !== 'PENDING_APPROVAL' || !a || a.status !== 'pending') throw new AppError('APPROVAL_NOT_PENDING','Approval is not pending',409);
      if (a.expired) {
        await c.query("UPDATE approvals SET status='expired',decided_at=now() WHERE purchase_id=$1",[id]);
        await this.fail(c,p,r,'APPROVAL_EXPIRED');
        return 'APPROVAL_EXPIRED';
      }
      if (decision === 'reject') {
        await c.query("UPDATE approvals SET status='rejected',decided_at=now() WHERE purchase_id=$1",[id]);
        await this.fail(c,p,r,'APPROVAL_REJECTED');
      } else {
        if (r.status !== 'enabled') throw new AppError('RULE_PAUSED','Rule is not enabled',409);
        await this.budget(c,p,r,a.amount_usd_cents);
        await c.query("UPDATE approvals SET status='approved',decided_at=now() WHERE purchase_id=$1",[id]);
        await c.query("UPDATE purchases SET status='READY_TO_PAY',next_attempt_at=now(),updated_at=now() WHERE id=$1",[id]);
      }
      return null;
    });
    if (outcome) throw new AppError(outcome,'Approval expired',409);
    return {ok:true};
  }
  async notifications(limit: number) {
    const result = await this.db.query(`SELECT * FROM notification_outbox WHERE acked_at IS NULL ORDER BY created_at,id LIMIT $1`,[limit]);
    const items = [];
    for (const n of result.rows) {
      let redemption: unknown = null;
      if (n.redemption_ciphertext) {
        // Defense in depth: delivery authorization is rechecked at read time.
        const auth = await this.db.query(`SELECT 1 FROM purchases p JOIN commerce_rules r ON r.id=p.rule_id
          WHERE p.id=$1 AND ((p.status='DELIVERED' AND p.mode='live') OR (p.status='TEST_DELIVERED' AND p.mode='test' AND $4='test_purchase_delivered'))
          AND r.recipient_chat_id=$2 AND p.invoice_id=$3`,[n.purchase_id,n.chat_id,n.invoice_id,n.type]);
        if (auth.rowCount) redemption=this.secrets.open(n.redemption_ciphertext,`${n.id}:${n.chat_id}:${n.purchase_id}`);
      }
      items.push({id:n.id,chatId:n.chat_id,type:n.type,text:n.text,purchaseId:n.purchase_id,invoiceId:n.invoice_id,approvalPurchaseId:n.approval_purchase_id,redemption});
    }
    return items;
  }
  async ack(id: string) {
    await this.db.query('UPDATE notification_outbox SET acked_at=COALESCE(acked_at,now()),redemption_ciphertext=NULL WHERE id=$1',[id]);
    return {ok:true};
  }
  async webhook(invoiceId: string) {
    // Hints only. No status, order ID or redemption from the unauthenticated payload is trusted.
    await this.db.query(`UPDATE purchases SET next_attempt_at=LEAST(next_attempt_at,now())
      WHERE invoice_id=$1 AND status IN ('PAYMENT_PROCESSING','PAYMENT_UNCERTAIN')`,[invoiceId]);
    return {ok:true};
  }
  async tick(limit = 20) {
    const jobs = await this.db.query<{id:string}>(`SELECT id FROM purchases WHERE status=ANY($1::text[]) AND next_attempt_at<=now()
      ORDER BY next_attempt_at,id LIMIT $2`,[activeStatuses,limit]);
    for (const {id} of jobs.rows) await this.process(id);
  }
  async process(id: string) {
    // Session lock spans I/O; durable state is committed BEFORE each external side effect.
    const lock = await this.db.connect();
    const got = await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[`purchase:${id}`]);
    if (!got.rows[0].locked) { lock.release(); return; }
    try { await this.advance(id); }
    catch {
      // No provider payloads or exception messages enter logs or persistence.
      await this.db.query("UPDATE purchases SET next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[id]);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`purchase:${id}`]);
      lock.release();
    }
  }
  private async advance(id: string) {
    let result = await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id]);
    let p = result.rows[0];
    if (!p || !activeStatuses.includes(p.status)) return;
    // Changing the live flag on restart must never send a live invoice through a test adapter (or vice versa).
    if (p.mode !== this.purchasing.mode || (p.mode==='live' && !this.liveEnabled)) {
      if (p.mode==='live' && this.readOnlyReconciler && ['PAYMENT_PROCESSING','PAYMENT_UNCERTAIN'].includes(p.status)) {
        await this.reconcile(id,this.readOnlyReconciler);
      } else await this.db.query("UPDATE purchases SET next_attempt_at=now()+interval '5 minutes' WHERE id=$1",[id]);
      return;
    }
    if (p.status === 'INVOICE_CREATING') {
      await transaction(this.db,async c => {
        const {p,r}=await this.pair(c,id);
        await c.query("UPDATE purchases SET status='INVOICE_UNCERTAIN',error_code='INVOICE_CREATION_UNCERTAIN' WHERE id=$1",[id]);
        await this.notify(c,{key:`invoice-uncertain:${id}`,chatId:r.owner_chat_id,type:'payment_uncertain',purchaseId:id,
          text:'Invoice creation response was lost. No payment will be attempted; inspect the provider account.'});
      });
      return;
    }
    if (p.status === 'QUEUED') {
      const r = (await this.db.query<Rule>('SELECT * FROM commerce_rules WHERE id=$1',[p.rule_id])).rows[0]!;
      try { await this.validatePackage(r.product_id,r.package_id); }
      catch (error) {
        if (error instanceof AppError && error.code==='INVALID_PACKAGE') {
          await transaction(this.db,async c => {const {p,r}=await this.pair(c,id);await this.fail(c,p,r,'INVALID_PACKAGE');});
        }
        throw error;
      }
      const mayCreate = await transaction(this.db,async c => {
        const {p,r}=await this.pair(c,id);
        if (r.status!=='enabled' || !chatId.safeParse(r.recipient_chat_id).success || (this.authorizedRecipientChatId && r.recipient_chat_id!==this.authorizedRecipientChatId)) {await this.fail(c,p,r,'RULE_INELIGIBLE');return false;}
        await c.query("UPDATE purchases SET status='INVOICE_CREATING',updated_at=now() WHERE id=$1",[id]);
        return true;
      });
      if (!mayCreate) return;
      // Failure after this point leaves INVOICE_CREATING. On restart it is quarantined, never recreated.
      const invoice = await this.purchasing.createInvoice(r.product_id,r.package_id,id);
      await transaction(this.db,async c => {
        await c.query('INSERT INTO invoices(id,purchase_id,status,order_statuses) VALUES($1,$2,$3,$4)',[invoice.id,id,invoice.status,JSON.stringify(invoice.orders)]);
        await c.query("UPDATE purchases SET status='QUOTED',invoice_id=$2,updated_at=now() WHERE id=$1",[id,invoice.id]);
        await this.notify(c,{key:`invoice:${id}`,chatId:r.owner_chat_id,type:'invoice_created',purchaseId:id,invoiceId:invoice.id,
          text:`${p!.mode==='test'?'TEST MODE (simulated invoice): ':''}Invoice created; payment policy checks pending.`});
      });
      await this.quote(id,invoice);
    }
    result = await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id]); p=result.rows[0]!;
    if (p.status==='QUOTED') await this.quote(id,await this.purchasing.invoice(p.invoice_id!));
    if (p.status==='PENDING_APPROVAL') {
      await transaction(this.db,async c=>{
        const {p,r}=await this.pair(c,id);
        const expired=await c.query("UPDATE approvals SET status='expired',decided_at=now() WHERE purchase_id=$1 AND status='pending' AND expires_at<=now() RETURNING purchase_id",[id]);
        if (expired.rowCount && p.status==='PENDING_APPROVAL') await this.fail(c,p,r,'APPROVAL_EXPIRED');
        else await c.query("UPDATE purchases SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",[id]);
      });
      return;
    }
    p=(await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id])).rows[0]!;
    if (p.status==='READY_TO_PAY') await this.pay(id);
    p=(await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id])).rows[0]!;
    if (p.status==='PAYMENT_PROCESSING' || p.status==='PAYMENT_UNCERTAIN') await this.reconcile(id);
  }
  private async quote(id: string, invoice: Invoice) {
    await transaction(this.db,async c => {
      const {p,r}=await this.pair(c,id);
      if (p.status!=='QUOTED') return;
      try {
        if (invoice.id!==p.invoice_id) throw new AppError('PROVIDER_MISMATCH','Invoice mismatch');
        const amount=invoiceCents(invoice);
        if (invoice.orders.length!==1) throw new AppError('UNEXPECTED_INVOICE_ORDERS','Exactly one ordered item is required');
        if (r.status!=='enabled' || !chatId.safeParse(r.recipient_chat_id).success || (this.authorizedRecipientChatId && r.recipient_chat_id!==this.authorizedRecipientChatId)) throw new AppError('RULE_INELIGIBLE','Rule unavailable');
        if (invoice.status!=='unpaid') throw new AppError('UNEXPECTED_INVOICE_STATUS','New invoice is not unpaid');
        await this.reserve(c,p,r,amount);
        const approval=amount>r.auto_approve_up_to_usd_cents;
        await c.query('UPDATE purchases SET amount_usd_cents=$2,status=$3,updated_at=now() WHERE id=$1',[id,amount,approval?'PENDING_APPROVAL':'READY_TO_PAY']);
        if (approval) {
          await c.query(`INSERT INTO approvals(purchase_id,status,amount_usd_cents,expires_at)
            VALUES($1,'pending',$2,now()+$3*interval '1 second')`,[id,amount,this.approvalTtl]);
          await this.notify(c,{key:`approval:${id}`,chatId:r.owner_chat_id,type:'purchase_pending_approval',purchaseId:id,
            invoiceId:p.invoice_id,approvalPurchaseId:id,text:`${p.mode==='test'?'TEST MODE: ':''}Approval required for USD ${Math.trunc(amount/100)}.${String(amount%100).padStart(2,'0')}; expires in ${this.approvalTtl} seconds.`});
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await this.fail(c,p,r,error.code);
      }
    });
  }
  private async pay(id: string) {
    const p=(await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id])).rows[0]!;
    const rule=(await this.db.query<Rule>('SELECT * FROM commerce_rules WHERE id=$1',[p.rule_id])).rows[0]!;
    let product;
    try { product=await this.validatePackage(rule.product_id,rule.package_id); }
    catch(error) {
      if (error instanceof AppError && error.code==='INVALID_PACKAGE') {
        await transaction(this.db,async c=>{const {p,r}=await this.pair(c,id);await this.fail(c,p,r,'INVALID_PACKAGE');});
      }
      throw error;
    }
    // Test simulation never calls the live adapter, even for an invoice lookup.
    const current = await this.purchasing.invoice(p.invoice_id!);
    const order = current?.orders.length===1 ? await this.purchasing.order(current.orders[0]!.id) : null;
    const mayPay=await transaction(this.db,async c=>{
      const {p,r}=await this.pair(c,id);
      if (p.status!=='READY_TO_PAY') return false;
      try {
        if (r.status!=='enabled' || !chatId.safeParse(r.recipient_chat_id).success || (this.authorizedRecipientChatId && r.recipient_chat_id!==this.authorizedRecipientChatId)) throw new AppError('RULE_INELIGIBLE','Rule unavailable');
        if (current && (current.status!=='unpaid' || invoiceCents(current)!==p.amount_usd_cents)) throw new AppError('INVOICE_CHANGED','Invoice price or status changed; new authorization required');
        if (current && (!order || order.status!=='created' || order.productId!==r.product_id || order.invoiceId!==p.invoice_id ||
          order.productCurrency!==product.currency || Number(order.productValue)!==product.packages.find(x=>x.packageId===r.package_id)!.value)) {
          throw new AppError('INVOICE_ORDER_MISMATCH','Invoice order does not match the authorized product and package');
        }
        const a=(await c.query('SELECT *,expires_at<=now() AS expired FROM approvals WHERE purchase_id=$1',[id])).rows[0];
        if (p.amount_usd_cents!>r.auto_approve_up_to_usd_cents && (!a || a.status!=='approved' || a.expired || a.amount_usd_cents!==p.amount_usd_cents)) throw new AppError('APPROVAL_EXPIRED','Valid approval required');
        await this.budget(c,p,r,p.amount_usd_cents!);
        await c.query("UPDATE purchases SET status='PAYMENT_PROCESSING',payment_attempted_at=now(),updated_at=now() WHERE id=$1",[id]);
        await this.notify(c,{key:`paying:${id}`,chatId:r.owner_chat_id,type:'payment_processing',purchaseId:id,invoiceId:p.invoice_id,
          text:`${p.mode==='test'?'TEST MODE: simulating payment.':'Payment submitted; delivery verification pending.'}`});
        return true;
      } catch(error) {
        if (!(error instanceof AppError)) throw error;
        await this.fail(c,p,r,error.code);return false;
      }
    });
    if (!mayPay) return;
    // This is the ONLY paid request. All exceptions are ambiguous. This state NEVER re-enters pay().
    try { await this.purchasing.pay(p.invoice_id!); }
    catch {
      await transaction(this.db,async c=>{
        const {p,r}=await this.pair(c,id);
        await c.query("UPDATE purchases SET status='PAYMENT_UNCERTAIN',error_code='PAYMENT_UNCERTAIN',next_attempt_at=now()+interval '30 seconds' WHERE id=$1",[id]);
        await this.notify(c,{key:`uncertain:${id}`,chatId:r.owner_chat_id,type:'payment_uncertain',purchaseId:id,invoiceId:p.invoice_id,
          text:'Payment outcome uncertain. Funds remain reserved; reconciling the existing invoice without retrying payment.'});
      });
    }
  }
  private async reconcile(id: string, adapter: Pick<Purchasing,'invoice'|'order'> = this.purchasing) {
    const p=(await this.db.query<Purchase>('SELECT * FROM purchases WHERE id=$1',[id])).rows[0]!;
    const invoice=await adapter.invoice(p.invoice_id!);
    const orders: Order[]=[];
    // Never assume an empty or partial order list implies delivery. Exactly one was ordered.
    if (invoice.orders.length===1) orders.push(await adapter.order(invoice.orders[0]!.id));
    await transaction(this.db,async c=>{
      const {p,r}=await this.pair(c,id);
      if (!['PAYMENT_PROCESSING','PAYMENT_UNCERTAIN'].includes(p.status)) return;
      await c.query('UPDATE invoices SET status=$2,order_statuses=$3,updated_at=now() WHERE id=$1',
        [p.invoice_id,invoice.status,JSON.stringify(orders.map(o=>({id:o.id,status:o.status})))]);
      if (terminalInvoice.has(invoice.status) || orders.some(o=>o.status==='failed'||o.status==='refunded')) {
        await this.fail(c,p,r,'PROVIDER_DELIVERY_FAILED');return;
      }
      if (invoice.orders.length===1 && orders.length===1 && orders.every(o=>o.status==='delivered'&&o.productId===r.product_id&&(!o.invoiceId||o.invoiceId===p.invoice_id)) && invoice.status==='complete') {
        const redemption=orders[0]!.redemption;
        if (!redemption || !Object.values(redemption).some(Boolean)) {
          await c.query("UPDATE purchases SET next_attempt_at=now()+interval '30 seconds',error_code='REDEMPTION_PENDING' WHERE id=$1",[id]);return;
        }
        await c.query('UPDATE purchases SET status=$2,error_code=NULL,updated_at=now() WHERE id=$1',[id,p.mode==='live'?'DELIVERED':'TEST_DELIVERED']);
        await c.query("UPDATE spending_ledger SET state='committed',committed_at=COALESCE(committed_at,now()) WHERE purchase_id=$1",[id]);
        await this.notify(c,{key:`delivered:${id}`,chatId:r.recipient_chat_id,type:p.mode==='live'?'purchase_delivered':'test_purchase_delivered',
          text:p.mode==='live'?'Your purchase was delivered.':'TEST MODE: simulated delivery only. No real purchase or redeemable code.',
          purchaseId:id,invoiceId:p.invoice_id,redemption});
        if (r.owner_chat_id!==r.recipient_chat_id) await this.notify(c,{key:`receipt:${id}`,chatId:r.owner_chat_id,type:'purchase_receipt',
          text:`${p.mode==='test'?'TEST MODE: simulated delivery.':'Purchase delivered to the authorized private recipient.'} Invoice and order delivery verified. Charge: USD ${Math.trunc(p.amount_usd_cents!/100)}.${String(p.amount_usd_cents!%100).padStart(2,'0')}.`,purchaseId:id,invoiceId:p.invoice_id});
      } else {
        // A crash between the committed payment intent and its response is also an uncertain outcome.
        const uncertain=p.status==='PAYMENT_UNCERTAIN'||invoice.status==='unpaid';
        await c.query("UPDATE purchases SET status=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[id,uncertain?'PAYMENT_UNCERTAIN':'PAYMENT_PROCESSING']);
        if (uncertain) await this.notify(c,{key:`uncertain:${id}`,chatId:r.owner_chat_id,type:'payment_uncertain',purchaseId:id,invoiceId:p.invoice_id,text:'Payment remains uncertain. Existing invoice is being reconciled; payment will not be retried.'});
      }
    });
  }
}
