// Regression tests for scripts/audit-config.mjs: it must classify configuration correctly and NEVER print a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../../scripts/audit-config.mjs');
const dir = mkdtempSync(join(tmpdir(), 'buyoncue-audit-'));
const hex = (n: number) => randomBytes(n).toString('hex');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const pem = join(dir, 'app.pem');
writeFileSync(pem, privateKey);
chmodSync(pem, 0o600);

const shared = hex(24);
const secrets = {
  TELEGRAM_BOT_TOKEN: `123456789:${randomBytes(27).toString('base64url')}`,
  GITHUB_WEBHOOK_SECRET: hex(32), GITHUB_APP_CLIENT_SECRET: hex(20), AWS_BEARER_TOKEN_BEDROCK: `ABSK${hex(30)}`,
  REDEMPTION_ENCRYPTION_KEY: hex(32), BITREFILL_API_KEY: hex(24), INTERNAL_API_TOKEN: shared,
};
const chatEnv = (o: Record<string, string> = {}) => ({
  TELEGRAM_BOT_TOKEN: secrets.TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_USER_ID: '1001', ENGINE_URL: 'http://localhost:3001', INTERNAL_API_TOKEN: shared,
  GITHUB_WEBHOOK_SECRET: secrets.GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID: '5609798', GITHUB_APP_CLIENT_ID: 'Iv23ligq8KkwCysuqvO9', GITHUB_APP_CLIENT_SECRET: secrets.GITHUB_APP_CLIENT_SECRET,
  GITHUB_APP_PRIVATE_KEY_PATH: pem, PUBLIC_CHAT_URL: 'https://chat.buyoncue-demo.test', GITHUB_OAUTH_CALLBACK_URL: 'https://chat.buyoncue-demo.test/auth/github/callback',
  GITHUB_APP_INSTALL_URL: 'https://github.com/apps/buyoncue/installations/new', LLM_PROVIDER: 'bedrock', AWS_REGION: 'ap-south-1', AWS_BEARER_TOKEN_BEDROCK: secrets.AWS_BEARER_TOKEN_BEDROCK,
  BEDROCK_CHAT_MODEL_ID: 'global.anthropic.claude-haiku-5-5', PORT: '3002', ...o,
});
const engineEnv = (o: Record<string, string> = {}) => ({
  DATABASE_URL: 'postgresql://buyoncue@127.0.0.1:5432/buyoncue_dev', INTERNAL_API_TOKEN: shared, BITREFILL_API_KEY: secrets.BITREFILL_API_KEY, PUBLIC_ENGINE_URL: 'https://engine.buyoncue-demo.test',
  LIVE_PURCHASES_ENABLED: 'false', AUTHORIZED_RECIPIENT_CHAT_ID: '2002', REDEMPTION_ENCRYPTION_KEY: secrets.REDEMPTION_ENCRYPTION_KEY, PORT: '3001', LLM_PROVIDER: 'bedrock', AWS_REGION: 'ap-south-1',
  AWS_BEARER_TOKEN_BEDROCK: secrets.AWS_BEARER_TOKEN_BEDROCK, BEDROCK_REVIEW_MODEL_ID: 'global.anthropic.claude-sonnet-5-5', ...o,
});
function run(chat: Record<string, string>, engine: Record<string, string>) {
  const write = (name: string, env: Record<string, string>) => { const f = join(dir, name); writeFileSync(f, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 }); return f; };
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(k in chat) && !(k in engine)));
  try {
    const stdout = execFileSync(process.execPath, [script, '--json', '--chat-env', write('chat.env', chat), '--engine-env', write('engine.env', engine)], { env: cleanEnv, encoding: 'utf8' });
    return { code: 0, stdout, report: JSON.parse(stdout) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout, report: JSON.parse(e.stdout) };
  }
}
const status = (r: { report: { variables: { svc: string; name: string; status: string }[] } }, svc: string, name: string) => r.report.variables.find((v) => v.svc === svc && v.name === name)?.status;
const assertNoSecrets = (stdout: string) => { for (const v of Object.values(secrets)) assert.ok(!stdout.includes(v), 'a secret value appeared in the audit output'); };

test('a complete, well-formed configuration passes offline and prints no value', () => {
  const r = run(chatEnv(), engineEnv());
  assertNoSecrets(r.stdout);
  assert.equal(r.code, 0, JSON.stringify(r.report.checks.filter((c: { priority: string }) => c.priority === 'P0')));
  for (const n of ['TELEGRAM_BOT_TOKEN', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PUBLIC_CHAT_URL', 'GITHUB_OAUTH_CALLBACK_URL']) assert.equal(status(r, 'chat', n), 'PRESENT_AND_VALID', n);
  for (const n of ['REDEMPTION_ENCRYPTION_KEY', 'DATABASE_URL', 'AUTHORIZED_RECIPIENT_CHAT_ID']) assert.equal(status(r, 'engine', n), 'PRESENT_AND_VALID', n);
  assert.equal(r.report.checks.find((c: { check: string }) => c.check.startsWith('INTERNAL_API_TOKEN identical')).result, 'PASS');
  assert.equal(r.report.checks.find((c: { check: string }) => c.check === 'services/chat loadConfig()').result, 'PASS');
  assert.equal(r.report.checks.find((c: { check: string }) => c.check === 'services/engine loadConfig()').result, 'PASS');
});

test('example-file placeholders and malformed values are flagged as blockers', () => {
  const r = run(chatEnv({ PUBLIC_CHAT_URL: 'https://CHAT_HOST', GITHUB_APP_INSTALL_URL: 'https://github.com/apps/<your-app-slug>/installations/new' }), engineEnv({ DATABASE_URL: 'postgresql://pactpilot:password@localhost:5432/pactpilot', INTERNAL_API_TOKEN: 'replace-with-at-least-32-random-characters', REDEMPTION_ENCRYPTION_KEY: 'nothex' }));
  assertNoSecrets(r.stdout);
  assert.equal(r.code, 1);
  assert.equal(status(r, 'chat', 'PUBLIC_CHAT_URL'), 'PLACEHOLDER');
  assert.equal(status(r, 'chat', 'GITHUB_APP_INSTALL_URL'), 'PLACEHOLDER');
  assert.equal(status(r, 'engine', 'DATABASE_URL'), 'PLACEHOLDER');
  assert.equal(status(r, 'engine', 'INTERNAL_API_TOKEN'), 'PLACEHOLDER');
  assert.equal(status(r, 'engine', 'REDEMPTION_ENCRYPTION_KEY'), 'PRESENT_BUT_INVALID');
});

test('different INTERNAL_API_TOKEN values are detected without printing either', () => {
  const other = hex(24);
  const r = run(chatEnv(), engineEnv({ INTERNAL_API_TOKEN: other }));
  assertNoSecrets(r.stdout);
  assert.ok(!r.stdout.includes(other));
  assert.equal(r.report.checks.find((c: { check: string }) => c.check.startsWith('INTERNAL_API_TOKEN identical')).result, 'FAIL');
});

test('live spending enabled, a wrong callback and both key forms are blockers', () => {
  const r = run(chatEnv({ GITHUB_OAUTH_CALLBACK_URL: 'https://chat.buyoncue-demo.test/callback', GITHUB_APP_PRIVATE_KEY: 'inline' }), engineEnv({ LIVE_PURCHASES_ENABLED: 'true' }));
  assertNoSecrets(r.stdout);
  assert.equal(r.code, 1);
  assert.equal(status(r, 'engine', 'LIVE_PURCHASES_ENABLED'), 'PRESENT_BUT_INVALID');
  assert.equal(status(r, 'chat', 'GITHUB_OAUTH_CALLBACK_URL'), 'PRESENT_BUT_INVALID');
  assert.equal(status(r, 'chat', 'GITHUB_APP_PRIVATE_KEY(_PATH)'), 'PRESENT_BUT_INVALID');
});

test('Bedrock selected but incomplete is reported (the services would refuse to start)', () => {
  const r = run(chatEnv({ AWS_BEARER_TOKEN_BEDROCK: '' }), engineEnv({ BEDROCK_REVIEW_MODEL_ID: '' }));
  assertNoSecrets(r.stdout);
  assert.equal(status(r, 'chat', 'AWS_BEARER_TOKEN_BEDROCK'), 'MISSING');
  assert.equal(status(r, 'engine', 'BEDROCK_REVIEW_MODEL_ID'), 'MISSING');
  assert.equal(r.code, 1);
});
