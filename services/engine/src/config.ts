import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  DATABASE_URL: z.string().url(),
  INTERNAL_API_TOKEN: z.string().min(32),
  BITREFILL_API_KEY: z.string().default(''),
  BITREFILL_BASE_URL: z.literal('https://api.bitrefill.com/v2').default('https://api.bitrefill.com/v2'),
  PUBLIC_ENGINE_URL: z.string().url(),
  LIVE_PURCHASES_ENABLED: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  REDEMPTION_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  APPROVAL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(2000)
});
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(x => x.path.join('.')).join(', ')}`);
  const c = result.data;
  if (c.LIVE_PURCHASES_ENABLED === 'true' && (!c.BITREFILL_API_KEY || !c.PUBLIC_ENGINE_URL.startsWith('https://'))) {
    throw new Error('Live mode requires BITREFILL_API_KEY and an HTTPS PUBLIC_ENGINE_URL');
  }
  return c;
}
