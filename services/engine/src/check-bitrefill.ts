import { loadConfig } from './config.js';
import { Bitrefill } from './bitrefill.js';
const c=loadConfig();
const api=new Bitrefill(c.BITREFILL_API_KEY,c.BITREFILL_BASE_URL,c.PUBLIC_ENGINE_URL);
try {
  await api.ping();
  const balance=await api.balance();
  // Confirm currency only: avoid logging private account balances.
  console.log(`Bitrefill authenticated; account currency=${balance.currency}. No purchase requests sent.`);
} catch { console.error('Bitrefill read-only check failed; verify key and connectivity');process.exitCode=1; }
