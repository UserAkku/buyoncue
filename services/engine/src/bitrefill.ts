import { z } from 'zod';
import { AppError } from './errors.js';
import type { Sql } from './db.js';

export interface Product {
  id: string; name: string; country: string; currency: string; inStock: boolean;
  packages: { packageId: string; value: number }[];
}
export interface Invoice {
  id: string; status: string;
  payment?: { method?: string; currency?: string; price?: string | number };
  orders: { id: string; status: string }[];
}
export interface Redemption { code: string | null; pin: string | null; link: string | null; instructions: string | null }
export interface Order {
  id: string; status: string; productId: string; productValue?: string | number; productCurrency?: string;
  invoiceId?: string; redemption?: Redemption;
}
export interface Catalogue {
  search(query: string, country?: string): Promise<Product[]>;
  product(id: string): Promise<Product>;
}
export interface Purchasing {
  readonly mode: 'live' | 'test';
  createInvoice(productId: string, packageId: string, purchaseId: string): Promise<Invoice>;
  invoice(id: string): Promise<Invoice>;
  pay(id: string): Promise<void>;
  order(id: string): Promise<Order>;
}
const id = z.string().min(1).max(500);
const rawPackage = z.object({ package_id: id.optional(), id: id.optional(), value: z.union([z.string(), z.number()]) });
const rawProduct = z.object({
  id, name: z.string(), country: z.string().optional(), country_code: z.string().optional(),
  currency: z.string(), in_stock: z.boolean(),
  packages: z.union([z.array(rawPackage), rawPackage]).optional(),
  recipient_type: z.string().optional()
});
const invoiceSchema = z.object({
  id, status: z.string(),
  payment: z.object({ method: z.string().optional(), currency: z.string().optional(), price: z.union([z.string(), z.number()]).optional() }).optional(),
  orders: z.array(z.object({ id, status: z.string() })).default([])
});
export function normalizeProduct(value: unknown): Product {
  const p = rawProduct.parse(value);
  const packages = p.packages ? (Array.isArray(p.packages) ? p.packages : [p.packages]) : [];
  return {
    id: p.id, name: p.name, country: p.country_code ?? p.country ?? '', currency: p.currency,
    // This contract only pre-authorizes gift cards without extra recipient fields.
    inStock: p.in_stock && (!p.recipient_type || p.recipient_type === 'none'),
    packages: packages.flatMap(x => {
      const packageId = x.package_id ?? x.id;
      const value = Number(x.value);
      return packageId && Number.isFinite(value) && value > 0 ? [{ packageId, value }] : [];
    })
  };
}

/** Parse the documented payment.price decimal into USD cents, without currency arithmetic in floats. */
export function invoiceCents(invoice: Invoice): number {
  if (invoice.payment?.currency !== 'USD' || invoice.payment.method !== 'balance') {
    throw new AppError('UNSAFE_INVOICE_PRICE', 'An exact USD balance charge is required');
  }
  const text = String(invoice.payment.price ?? '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new AppError('UNSAFE_INVOICE_PRICE', 'Invoice charge is unknown or has unsupported precision');
  const [whole = '', fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 2_000_000_000n) throw new AppError('UNSAFE_INVOICE_PRICE', 'Invoice charge is outside supported limits');
  return Number(cents);
}

export class Bitrefill implements Catalogue, Purchasing {
  readonly mode = 'live' as const;
  constructor(private key: string, private baseUrl: string, private publicUrl: string, private fetcher: typeof fetch = fetch) {
    if (baseUrl !== 'https://api.bitrefill.com/v2') throw new Error('Unsupported Bitrefill origin');
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    if (!this.key) throw new AppError('CATALOGUE_UNAVAILABLE', 'Configure BITREFILL_API_KEY for authenticated catalogue access', 503);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(10000)
      });
      // Never forward provider bodies: they can contain codes and payment details.
      if (!response.ok) throw new AppError('PROVIDER_ERROR', `Bitrefill request failed (HTTP ${response.status})`, 502);
      return z.object({ data: z.unknown() }).parse(await response.json()).data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('PROVIDER_UNAVAILABLE', 'Bitrefill response unavailable or invalid', 502);
    }
  }
  async ping() { await this.request('/ping'); return { ok: true }; }
  async balance(): Promise<{ balance: string | number; currency: string }> {
    return z.object({ balance: z.union([z.string(), z.number()]), currency: z.string() }).parse(await this.request('/accounts/balance'));
  }
  async search(query: string, country?: string): Promise<Product[]> {
    const rows = z.array(rawProduct).parse(await this.request(`/products/search?q=${encodeURIComponent(query)}&limit=50`));
    // The documented search response contains Product objects. Filter country locally;
    // the search endpoint does not document a country query parameter.
    return rows.map(normalizeProduct).filter(p => !country || p.country === country);
  }
  async product(productId: string): Promise<Product> {
    const product = normalizeProduct(await this.request(`/products/${encodeURIComponent(productId)}`));
    if (product.id !== productId) throw new AppError('PROVIDER_MISMATCH', 'Catalogue product identity mismatch', 502);
    return product;
  }
  async createInvoice(productId: string, packageId: string, _purchaseId: string): Promise<Invoice> {
    const invoice = invoiceSchema.parse(await this.request('/invoices', {
      products: [{ product_id: productId, package_id: packageId, quantity: 1 }],
      payment_method: 'balance', auto_pay: false,
      webhook_url: `${this.publicUrl.replace(/\/$/, '')}/webhooks/bitrefill`
    }));
    if (invoice.id.startsWith('test:')) throw new AppError('PROVIDER_MISMATCH', 'Invalid live invoice identity', 502);
    return invoice;
  }
  async invoice(invoiceId: string): Promise<Invoice> {
    const invoice = invoiceSchema.parse(await this.request(`/invoices/${encodeURIComponent(invoiceId)}`));
    if (invoice.id !== invoiceId) throw new AppError('PROVIDER_MISMATCH', 'Invoice identity mismatch', 502);
    return invoice;
  }
  async pay(invoiceId: string): Promise<void> { await this.request(`/invoices/${encodeURIComponent(invoiceId)}/pay`, {}); }
  async order(orderId: string): Promise<Order> {
    const row = z.object({
      id, status: z.string(), product: z.object({ id, value:z.union([z.string(),z.number()]).optional(), currency:z.string().optional() }), invoice: z.object({ id }).optional(),
      redemption_info: z.union([z.string(), z.object({
        code: z.string().nullable().optional(), pin: z.string().nullable().optional(),
        link: z.string().nullable().optional(), instructions: z.string().nullable().optional()
      })]).nullable().optional()
    }).parse(await this.request(`/orders/${encodeURIComponent(orderId)}`));
    if (row.id !== orderId) throw new AppError('PROVIDER_MISMATCH', 'Order identity mismatch', 502);
    const r = row.redemption_info;
    return { id: row.id, status: row.status, productId: row.product.id, productValue:row.product.value, productCurrency:row.product.currency, invoiceId: row.invoice?.id,
      ...(row.status !== 'delivered' || !r ? {} : { redemption: typeof r === 'string'
        ? { code: null, pin: null, link: null, instructions: r }
        : { code: r.code ?? null, pin: r.pin ?? null, link: r.link ?? null, instructions: r.instructions ?? null } }) };
  }
}

/** Deterministic, restart-safe development simulation. Never calls the provider or returns real redemption. */
export class TestPurchasing implements Purchasing {
  readonly mode = 'test' as const;
  constructor(private catalogue: Catalogue, private db: Sql) {}
  private async state(id: string) {
    if (!id.startsWith('test:')) throw new Error('Test adapter refuses live invoices');
    const {rows} = await this.db.query(`SELECT p.payment_attempted_at,r.product_id,r.package_id
      FROM purchases p JOIN commerce_rules r ON r.id=p.rule_id WHERE p.id=$1`,[id.slice(5)]);
    const row=rows[0];
    if (!row) throw new Error('Unknown simulated purchase');
    const product=await this.catalogue.product(row.product_id);
    const pkg=product.packages.find(p=>p.packageId===row.package_id);
    if (!pkg) throw new Error('Unknown simulated package');
    return {paid:!!row.payment_attempted_at,product,pkg};
  }
  async createInvoice(_productId: string, _packageId: string, purchaseId: string): Promise<Invoice> {
    const id=`test:${purchaseId}`;
    return {id,status:'unpaid',payment:{method:'balance',currency:'USD',price:'1.00'},orders:[{id,status:'created'}]};
  }
  async invoice(id: string): Promise<Invoice> {
    const {paid}=await this.state(id);
    return {id,status:paid?'complete':'unpaid',payment:{method:'balance',currency:'USD',price:'1.00'},orders:[{id,status:paid?'delivered':'created'}]};
  }
  async pay(id: string) { if (!id.startsWith('test:')) throw new Error('Test adapter refuses live payment'); }
  async order(id: string): Promise<Order> {
    const {paid,product,pkg}=await this.state(id);
    return {id,invoiceId:id,status:paid?'delivered':'created',productId:product.id,productValue:pkg.value,productCurrency:product.currency,
      ...(paid?{redemption:{code:'TEST-NOT-REDEEMABLE',pin:null,link:null,instructions:'Simulation only; no value or real gift card.'}}:{})};
  }
}
