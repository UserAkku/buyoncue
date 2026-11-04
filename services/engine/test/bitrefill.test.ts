import { describe, it, expect, vi } from 'vitest';
import { Bitrefill, invoiceCents, normalizeProduct, type Invoice } from '../src/bitrefill.js';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';

const rawProduct={id:'documented-fixture',name:'TEST product',country_code:'IN',currency:'INR',in_stock:true,
  packages:[{id:'documented-fixture<&>50',value:'50',price:1.25}],recipient_type:'none'};
const quote:Invoice={id:'fixture-invoice',status:'unpaid',payment:{method:'balance',currency:'USD',price:1.25},orders:[{id:'fixture-order',status:'created'}]};
function mockApi() {
  const requests:{url:string;init:RequestInit}[]=[];
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);requests.push({url,init:init??{}});
    let data:unknown=quote;
    if (url.endsWith('/ping')) data={message:'pong'};
    else if (url.endsWith('/accounts/balance')) data={balance:10,currency:'USD'};
    else if (url.includes('/products/search')) data=[rawProduct];
    else if (url.includes('/products/')) data=rawProduct;
    else if (url.includes('/orders/')) data={id:'fixture-order',status:'delivered',product:{id:rawProduct.id},invoice:{id:quote.id},redemption_info:{code:'SENSITIVE',pin:null}};
    return new Response(JSON.stringify({meta:{},data}),{status:200,headers:{'Content-Type':'application/json'}});
  }) as unknown as typeof fetch;
  return {api:new Bitrefill('fake-key','https://api.bitrefill.com/v2','https://engine.example',fetcher),requests};
}
describe('Bitrefill REST adapter, all network requests replaced',()=>{
  it('uses documented bearer auth, read-only ping and balance paths',async()=>{
    const {api,requests}=mockApi();expect(await api.ping()).toEqual({ok:true});expect(await api.balance()).toEqual({balance:10,currency:'USD'});
    expect(requests.map(r=>new URL(r.url).pathname)).toEqual(['/v2/ping','/v2/accounts/balance']);
    expect(requests.every(r=>r.init.method==='GET'&&(r.init.headers as Record<string,string>).Authorization==='Bearer fake-key')).toBe(true);
    expect(requests.every(r=>r.init.redirect==='error'&&r.init.signal)).toBe(true);
  });
  it('uses real response package IDs and local country filtering without inventing denominations',async()=>{
    const {api,requests}=mockApi();const p=await api.product(rawProduct.id);expect(p.country).toBe('IN');
    expect(p.packages).toEqual([{packageId:'documented-fixture<&>50',value:50}]);
    expect(await api.search('gift & card','IN')).toEqual([p]);expect(await api.search('gift','US')).toEqual([]);
    expect(requests[1]!.url).toContain('q=gift%20%26%20card');expect(requests[1]!.url).not.toContain('country=');
  });
  it('supports documented package_id and country guide fields and the singleton schema variant',()=>{
    const p=normalizeProduct({...rawProduct,country_code:undefined,country:'IN',packages:{package_id:'exact-package',value:50}});
    expect(p.packages[0]!.packageId).toBe('exact-package');expect(p.country).toBe('IN');
  });
  it('does not offer products requiring recipient fields this contract cannot authorize',()=>{
    expect(normalizeProduct({...rawProduct,recipient_type:'phone_number'}).inStock).toBe(false);
  });
  it('creates an unpaid balance invoice and pays only the existing ID with an empty body',async()=>{
    const {api,requests}=mockApi();expect(await api.createInvoice(rawProduct.id,'exact-package','purchase')).toEqual(quote);
    const body=JSON.parse(String(requests[0]!.init.body));expect(body).toEqual({products:[{product_id:rawProduct.id,package_id:'exact-package',quantity:1}],payment_method:'balance',auto_pay:false,webhook_url:'https://engine.example/webhooks/bitrefill'});
    await api.invoice(quote.id);await api.pay(quote.id);expect(requests[2]!.url).toBe('https://api.bitrefill.com/v2/invoices/fixture-invoice/pay');
    expect(requests[2]!.init.method).toBe('POST');expect(requests[2]!.init.body).toBe('{}');
    expect(requests.filter(r=>r.init.method==='POST')).toHaveLength(2);
  });
  it('retrieves authenticated order and redemption details separately',async()=>{
    const {api}=mockApi();const o=await api.order('fixture-order');expect(o.status).toBe('delivered');expect(o.redemption).toMatchObject({code:'SENSITIVE'});
  });
  it('provider error bodies and credentials are not exposed',async()=>{
    const fetcher=vi.fn(async()=>new Response('SENSITIVE CODE API KEY',{status:403})) as unknown as typeof fetch;
    const api=new Bitrefill('fake-key','https://api.bitrefill.com/v2','https://engine.example',fetcher);
    await expect(api.ping()).rejects.toMatchObject({code:'PROVIDER_ERROR',message:'Bitrefill request failed (HTTP 403)'});
  });
  it('no key fails closed without a network request',async()=>{
    const fetcher=vi.fn() as unknown as typeof fetch;const api=new Bitrefill('','https://api.bitrefill.com/v2','https://engine.example',fetcher);
    await expect(api.search('gift')).rejects.toMatchObject({code:'CATALOGUE_UNAVAILABLE'});expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('Integer money and configuration',()=>{
  it.each([['0.01',1],['1.1',110],['19.99',1999],['20000000',2000000000]])('parses %s to %i cents exactly',(price,cents)=>{
    expect(invoiceCents({...quote,payment:{method:'balance',currency:'USD',price}})).toBe(cents);
  });
  it.each(['0','-1','1.001','1e2','NaN','Infinity','20000000.01','',undefined])('rejects unsafe price %s',price=>{
    expect(()=>invoiceCents({...quote,payment:{method:'balance',currency:'USD',price}})).toThrow();
  });
  it('live defaults false and requires explicit valid production configuration',()=>{
    const env={DATABASE_URL:'postgresql://user:password@localhost/test',INTERNAL_API_TOKEN:'a'.repeat(32),PUBLIC_ENGINE_URL:'http://localhost:3001',REDEMPTION_ENCRYPTION_KEY:'42'.repeat(32)};
    expect(loadConfig(env).LIVE_PURCHASES_ENABLED).toBe('false');
    expect(()=>loadConfig({...env,LIVE_PURCHASES_ENABLED:'true'})).toThrow('requires');
    expect(()=>loadConfig({...env,LIVE_PURCHASES_ENABLED:'true',BITREFILL_API_KEY:'TEST',PUBLIC_ENGINE_URL:'https://engine.example'})).toThrow('AUTHORIZED_RECIPIENT_CHAT_ID');
    expect(()=>loadConfig({...env,LIVE_PURCHASES_ENABLED:'yes'})).toThrow('Invalid configuration');
    expect(()=>loadConfig({...env,BITREFILL_BASE_URL:'https://attacker.example'})).toThrow('Invalid configuration');
  });
  it('encryption binds the code to a particular recipient and notification',()=>{
    const box=new SecretBox('42'.repeat(32));const cipher=box.seal({code:'PRIVATE'},'id:recipient:purchase');
    expect(cipher).not.toContain('PRIVATE');expect(box.open(cipher,'id:recipient:purchase')).toEqual({code:'PRIVATE'});
    expect(()=>box.open(cipher,'id:another-recipient:purchase')).toThrow();
  });
});
