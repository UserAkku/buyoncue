// Safe checks only. Never create invoices, pay, send Telegram messages, or consume updates.
import { Bitrefill } from '../services/engine/dist/src/bitrefill.js';
const result = { livePurchasesEnabled: process.env.LIVE_PURCHASES_ENABLED ?? 'false', telegram: {}, bitrefill: {} };
if (result.livePurchasesEnabled !== 'false') throw new Error('Run connectivity checks with LIVE_PURCHASES_ENABLED=false');
const token = process.env.TELEGRAM_BOT_TOKEN;
async function telegram(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Telegram check failed');
  const body = await response.json();
  if (!body.ok) throw new Error('Telegram check failed');
  return body.result;
}
if (!token) result.telegram = { status: 'BLOCKED', reason: 'TELEGRAM_BOT_TOKEN missing' };
else {
  try {
    const me = await telegram('getMe');
    const info = await telegram('getWebhookInfo');
    result.telegram = { status: 'PASS', username: me.username, isBot: me.is_bot, webhookConfigured: !!info.url, pendingUpdates: info.pending_update_count };
    const owner = process.env.TELEGRAM_OWNER_USER_ID;
    result.telegram.ownerConfigured = !!owner;
    if (owner) result.telegram.ownerPrivateChatVerified = (await telegram('getChat', {chat_id: owner})).type === 'private';
  } catch { result.telegram = { status: 'BLOCKED', reason: 'Telegram identity/configuration checks unavailable; credentials and provider error details suppressed' }; }
}
if (!process.env.BITREFILL_API_KEY) result.bitrefill = { status: 'BLOCKED', reason: 'BITREFILL_API_KEY missing; no authenticated catalogue/balance evidence' };
else {
  try {
    const api = new Bitrefill(process.env.BITREFILL_API_KEY, 'https://api.bitrefill.com/v2', process.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3001');
    await api.ping();
    const balance = await api.balance();
    const products = await api.search('flipkart', 'IN');
    const product = products.find(p => p.inStock && p.packages.length);
    const detail = product ? await api.product(product.id) : null;
    result.bitrefill = { status: 'PASS', currency: balance.currency, inStockIndianFixedPackageFound: !!detail, product: detail };
  } catch { result.bitrefill = { status: 'BLOCKED', reason: 'Authenticated read-only API checks unavailable; no provider bodies logged' }; }
}
console.log(JSON.stringify(result, null, 2));
