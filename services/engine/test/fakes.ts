import { randomUUID } from 'node:crypto';
import type { Catalogue, Purchasing, Invoice, Order, Product } from '../src/bitrefill.js';
export const fixtureProduct: Product = {
  id:'fixture-gift-in', name:'TEST FIXTURE: Indian Gift Card',country:'IN',currency:'INR',inStock:true,
  packages:[{packageId:'fixture-package-50',value:50}]
};
export class FakeCatalogue implements Catalogue {
  async product(id: string) { return {...fixtureProduct,id}; }
  async search(query: string,country?: string) { return (!country||country==='IN')&&query.includes('gift')?[fixtureProduct]:[]; }
}
export class FakePurchasing implements Purchasing {
  readonly mode='test' as const; // In-process fake; no network access, tests exercise the live state machine.
  creates=0; pays=0; orderReads=0;
  price: string | undefined='1.00'; currency: string | undefined='USD';
  timeout=false; failedOrder=false; failCreate=false; missingRedemption=false;
  paid=new Set<string>();
  async createInvoice(_product: string,_package: string,_purchase: string): Promise<Invoice> {
    this.creates++;
    if (this.failCreate) throw new Error('Simulated response loss');
    return this.invoice(`TEST-MOCK-${randomUUID()}`);
  }
  async invoice(id: string): Promise<Invoice> {
    const paid=this.paid.has(id);
    return {id,status:paid?'complete':'unpaid',payment:{method:'balance',currency:this.currency,price:this.price},
      orders:[{id:`order:${id}`,status:paid?'delivered':'created'}]};
  }
  async pay(id: string) {
    this.pays++;
    if (this.timeout) throw new Error('Simulated timeout');
    this.paid.add(id);
  }
  async order(id: string): Promise<Order> {
    this.orderReads++;
    const invoiceId=id.slice(6);
    const delivered=this.paid.has(invoiceId);
    return {id,invoiceId,productId:fixtureProduct.id,productValue:'50',productCurrency:'INR',status:delivered&&this.failedOrder?'failed':delivered?'delivered':'created',
      ...(delivered&&!this.missingRedemption?{redemption:{code:'TEST-SECRET-CODE',pin:'TEST-PIN',link:null,instructions:'TEST instructions'}}:{})};
  }
}
