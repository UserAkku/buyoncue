#!/usr/bin/env node
// BuyOnCue configuration audit.
//
//   node scripts/audit-config.mjs            # offline: validate both services' configuration
//   node scripts/audit-config.mjs --probe    # also run read-only network checks (no spending, no messages sent)
//   options: --json  --repo owner/name (demo repository, default UserAkku/buyoncue)  --write-missing
//            --chat-env <file> --engine-env <file> (audit other env files; used by tests)
//
// Safety rules this script follows:
//  * It never prints a secret value, nor its length, prefix, suffix, hash or any other derived fingerprint.
//  * It never creates or pays a Bitrefill invoice, never sends a Telegram message and never consumes updates
//    (no getUpdates), never changes GitHub settings, and never calls a metered model (see check-bedrock.mjs).
//  * It never writes .env files. --write-missing writes services/<svc>/.env.missing.example containing
//    ONLY variable names and format hints (git-ignored).
// Exit code: 1 if any P0 blocker remains, else 0.
import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createSign } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const JSON_OUT = args.includes('--json');
const WRITE_MISSING = args.includes('--write-missing');
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const DEMO_REPO = opt('--repo') ?? 'UserAkku/buyoncue';
const ENV_FILE = { chat: opt('--chat-env'), engine: opt('--engine-env') };
const KNOWN_APP_ID = '5609798';
const KNOWN_CLIENT_ID = 'Iv23ligq8KkwCysuqvO9';

const requireFrom = createRequire(resolve(root, 'services/engine/package.json'));
const dotenv = requireFrom('dotenv');

// ------------------------------------------------------------------ load (dotenv semantics: the shell wins)
function load(svc) {
  const file = ENV_FILE[svc] ? resolve(ENV_FILE[svc]) : resolve(root, `services/${svc}/.env`);
  const info = { file: ENV_FILE[svc] ? `${svc} env file` : `services/${svc}/.env`, exists: existsSync(file), empty: true, mode: null, values: {}, shell: new Set() };
  let parsed = {};
  if (info.exists) {
    const raw = readFileSync(file, 'utf8');
    info.empty = raw.trim() === '';
    info.mode = (statSync(file).mode & 0o777).toString(8);
    parsed = dotenv.parse(raw);
  }
  info.values = { ...parsed };
  for (const [k, v] of Object.entries(process.env)) {
    if (k in parsed || KNOWN[svc].has(k)) {
      if (v !== undefined) { info.values[k] = v; info.shell.add(k); }
    }
  }
  return info;
}
const CHAT_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_USER_ID', 'ENGINE_URL', 'INTERNAL_API_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_OAUTH_CALLBACK_URL', 'GITHUB_APP_INSTALL_URL', 'PUBLIC_CHAT_URL', 'GITHUB_API_URL', 'GITHUB_WEB_URL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'BEDROCK_CHAT_MODEL_ID', 'BEDROCK_MAX_OUTPUT_TOKENS', 'BEDROCK_MAX_INPUT_CHARS', 'PORT', 'CHAT_STATE_FILE'];
const ENGINE_VARS = ['DATABASE_URL', 'INTERNAL_API_TOKEN', 'BITREFILL_API_KEY', 'BITREFILL_BASE_URL', 'PUBLIC_ENGINE_URL', 'LIVE_PURCHASES_ENABLED', 'AUTHORIZED_RECIPIENT_CHAT_ID', 'REDEMPTION_ENCRYPTION_KEY', 'APPROVAL_TTL_SECONDS', 'WORKER_INTERVAL_MS', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'BEDROCK_REVIEW_MODEL_ID', 'BEDROCK_MAX_OUTPUT_TOKENS', 'BEDROCK_MAX_INPUT_CHARS', 'LLM_REVIEW_MAX_CALLS_PER_PR', 'AI_REVIEW_MIN_CONFIDENCE', 'AI_REVIEW_MAX_AGE_SECONDS', 'AI_ALLOW_PRIVATE_REPOSITORIES', 'PORT'];
const KNOWN = { chat: new Set(CHAT_VARS), engine: new Set(ENGINE_VARS) };
const chat = load('chat');
const engine = load('engine');

// ------------------------------------------------------------------ helpers
const rows = [];
/** status ∈ PRESENT_AND_VALID | PRESENT_BUT_INVALID | MISSING | PLACEHOLDER | NOT_APPLICABLE | REQUIRES_LIVE_VERIFICATION */
function row(svc, name, status, reason, priority = null) {
  rows.push({ svc, name, status, reason, priority: ['PRESENT_AND_VALID', 'NOT_APPLICABLE', 'REQUIRES_LIVE_VERIFICATION'].includes(status) ? null : priority });
}
const probes = [];
function probe(component, check, result, detail, priority = 'P0') {
  probes.push({ component, check, result, detail, priority: result === 'PASS' || result === 'INFO' ? null : priority });
}
const isSet = (v) => typeof v === 'string' && v.trim() !== '';
const PLACEHOLDER = /(replace[-_ ]?with|changeme|change[-_]me|your[-_ ]|<[^>]*>|\bxxx+\b|\btodo\b|\btbd\b|\bdummy\b|placeholder|example\.com|CHAT_HOST|ENGINE_HOST|:password@|COPY_REAL|^\.\.\.$)/i;
const placeholder = (v) => PLACEHOLDER.test(v);
function url(v) { try { return new URL(v); } catch { return null; } }
const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1'].includes(h);

/** Standard per-variable check. `validate(v)` returns null when valid, or a reason string. */
function check(svc, env, name, { required = false, priority = 'P0', validate = () => null, secret = false, defaultNote = null, na = null } = {}) {
  const v = env.values[name];
  if (na) return row(svc, name, 'NOT_APPLICABLE', na);
  if (!isSet(v)) {
    if (defaultNote) return row(svc, name, required ? 'MISSING' : 'NOT_APPLICABLE', `unset; code default applies (${defaultNote})`, required ? priority : null);
    return row(svc, name, 'MISSING', required ? 'required' : 'optional, unset', required ? priority : null);
  }
  if (placeholder(v)) return row(svc, name, 'PLACEHOLDER', 'looks like a placeholder from an example file', priority);
  const problem = validate(v.trim());
  if (problem) return row(svc, name, 'PRESENT_BUT_INVALID', problem, priority);
  const where = env.shell.has(name) ? ' (from shell environment)' : '';
  row(svc, name, 'PRESENT_AND_VALID', (secret ? 'set; value not shown' : 'set') + where);
}
const intIn = (lo, hi) => (v) => (/^\d+$/.test(v) && +v >= lo && +v <= hi ? null : `must be an integer ${lo}–${hi}`);
const numIn = (lo, hi) => (v) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? null : `must be a number ${lo}–${hi}`);
const httpUrl = (v) => { const u = url(v); return u && /^https?:$/.test(u.protocol) ? null : 'must be an http(s) URL'; };
const strongSecret = (v) => (v.length >= 32 ? null : 'too short; use at least 32 random characters (e.g. openssl rand -hex 32)');

// ------------------------------------------------------------------ files
for (const s of [chat, engine]) {
  if (!s.exists) row(s === chat ? 'chat' : 'engine', '(.env file)', 'MISSING', `${s.file} does not exist`, 'P0');
  else if (s.empty && s.shell.size === 0) row(s === chat ? 'chat' : 'engine', '(.env file)', 'MISSING', `${s.file} exists but is empty, and no variables are set in the shell`, 'P0');
  else row(s === chat ? 'chat' : 'engine', '(.env file)', 'PRESENT_AND_VALID', `${s.file} present${s.empty ? ' (empty; values from shell)' : ''}`);
  if (s.exists && s.mode && s.mode !== '600') row(s === chat ? 'chat' : 'engine', '(.env permissions)', 'PRESENT_BUT_INVALID', `file mode ${s.mode}; restrict with chmod 600 ${s.file}`, 'P2');
}

// ------------------------------------------------------------------ chat
const c = chat.values;
check('chat', chat, 'TELEGRAM_BOT_TOKEN', { required: true, secret: true, validate: (v) => (/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'not in BotFather token format <digits>:<secret>') });
check('chat', chat, 'TELEGRAM_OWNER_USER_ID', { required: true, validate: (v) => (/^[1-9]\d{0,14}$/.test(v) ? null : 'must be your positive numeric Telegram user ID (send /whoami to the bot)') });
check('chat', chat, 'ENGINE_URL', { defaultNote: 'http://localhost:3001', validate: httpUrl });
check('chat', chat, 'INTERNAL_API_TOKEN', { required: true, secret: true, validate: strongSecret });
check('chat', chat, 'GITHUB_WEBHOOK_SECRET', { required: true, secret: true, validate: (v) => (v.length >= 20 ? null : 'too short; use a long random value (e.g. openssl rand -hex 32)') });
check('chat', chat, 'PORT', { defaultNote: '3002', validate: intIn(1, 65535) });
check('chat', chat, 'CHAT_STATE_FILE', { defaultNote: '.data/chat-state.json, relative to services/chat', validate: () => null });

// GitHub App group: all-or-none (mirrors services/chat/src/config.ts)
const GH = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_OAUTH_CALLBACK_URL', 'GITHUB_APP_INSTALL_URL', 'PUBLIC_CHAT_URL'];
const hasKey = isSet(c.GITHUB_APP_PRIVATE_KEY) || isSet(c.GITHUB_APP_PRIVATE_KEY_PATH);
const ghAny = GH.some((k) => isSet(c[k])) || hasKey;
const ghReq = { required: true, priority: 'P0' };
check('chat', chat, 'GITHUB_APP_ID', { ...ghReq, validate: (v) => (!/^\d+$/.test(v) ? 'must be numeric' : v !== KNOWN_APP_ID ? `differs from the registered BuyOnCue App ID ${KNOWN_APP_ID}` : null) });
check('chat', chat, 'GITHUB_APP_CLIENT_ID', { ...ghReq, validate: (v) => (v !== KNOWN_CLIENT_ID ? 'differs from the registered BuyOnCue client ID' : null) });
check('chat', chat, 'GITHUB_APP_CLIENT_SECRET', { ...ghReq, secret: true, validate: (v) => (/^[0-9a-f]{40}$/i.test(v) ? null : 'not in GitHub client-secret format (40 hex characters)') });
let pemOk = false;
if (isSet(c.GITHUB_APP_PRIVATE_KEY) && isSet(c.GITHUB_APP_PRIVATE_KEY_PATH)) {
  row('chat', 'GITHUB_APP_PRIVATE_KEY(_PATH)', 'PRESENT_BUT_INVALID', 'both inline key and path are set; the service refuses to start. Keep only GITHUB_APP_PRIVATE_KEY_PATH', 'P0');
} else if (isSet(c.GITHUB_APP_PRIVATE_KEY_PATH)) {
  row('chat', 'GITHUB_APP_PRIVATE_KEY', 'NOT_APPLICABLE', 'path form used (preferred)');
  const p = c.GITHUB_APP_PRIVATE_KEY_PATH.trim();
  const abs = isAbsolute(p) ? p : resolve(root, 'services/chat', p);
  if (placeholder(p)) row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PLACEHOLDER', 'placeholder path', 'P0');
  else if (!existsSync(abs)) row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PRESENT_BUT_INVALID', 'file does not exist (relative paths resolve from services/chat, where npm start runs)', 'P0');
  else {
    let readable = true;
    try { accessSync(abs, constants.R_OK); } catch { readable = false; }
    if (!readable) row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PRESENT_BUT_INVALID', 'file exists but is not readable by this user', 'P0');
    else {
      try {
        const k = createPrivateKey(readFileSync(abs));
        if (k.asymmetricKeyType !== 'rsa') throw new Error();
        pemOk = true;
        const mode = (statSync(abs).mode & 0o777).toString(8);
        const insideRepo = abs.startsWith(root + '/');
        row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PRESENT_AND_VALID', `readable RSA PEM${insideRepo ? ' inside the checkout (git-ignored by *.pem, but prefer outside the repo)' : ''}`);
        if (mode !== '600' && mode !== '400') row('chat', '(private key permissions)', 'PRESENT_BUT_INVALID', `key file mode ${mode}; run chmod 600 on it`, 'P2');
      } catch { row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'PRESENT_BUT_INVALID', 'file is not a valid RSA private key PEM', 'P0'); }
    }
  }
} else if (isSet(c.GITHUB_APP_PRIVATE_KEY)) {
  row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'NOT_APPLICABLE', 'inline key form used; a file path is safer');
  let key = c.GITHUB_APP_PRIVATE_KEY.trim().replace(/^"|"$/g, '');
  if (!key.includes('BEGIN')) { try { key = Buffer.from(key, 'base64').toString('utf8'); } catch { /* invalid */ } }
  key = key.replace(/\\n/g, '\n');
  try { createPrivateKey(key); pemOk = true; row('chat', 'GITHUB_APP_PRIVATE_KEY', 'PRESENT_AND_VALID', 'valid PEM; value not shown'); } catch { row('chat', 'GITHUB_APP_PRIVATE_KEY', 'PRESENT_BUT_INVALID', 'not a valid PEM private key (raw, \\n-escaped or base64)', 'P0'); }
} else {
  row('chat', 'GITHUB_APP_PRIVATE_KEY_PATH', 'MISSING', 'required (or inline GITHUB_APP_PRIVATE_KEY); download from the App settings', 'P0');
  row('chat', 'GITHUB_APP_PRIVATE_KEY', 'NOT_APPLICABLE', 'use GITHUB_APP_PRIVATE_KEY_PATH instead');
}
const pub = url(c.PUBLIC_CHAT_URL ?? '');
check('chat', chat, 'PUBLIC_CHAT_URL', { ...ghReq, validate: (v) => { const u = url(v); if (!u) return 'not a URL'; if (u.protocol !== 'https:') return 'must be https (GitHub OAuth and Telegram URL buttons require it)'; if (isLocalHost(u.hostname)) return 'must be a public hostname (tunnel or deployment), not localhost'; if (u.pathname !== '/' || u.search) return 'must be a bare origin without path'; return null; } });
check('chat', chat, 'GITHUB_OAUTH_CALLBACK_URL', { ...ghReq, validate: (v) => (pub && v.replace(/\/+$/, '') !== `${pub.origin}/auth/github/callback` ? 'must equal PUBLIC_CHAT_URL + /auth/github/callback' : null) });
check('chat', chat, 'GITHUB_APP_INSTALL_URL', { ...ghReq, validate: (v) => (/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new\/?$/.test(v) ? null : 'must be https://github.com/apps/<app-slug>/installations/new') });
check('chat', chat, 'GITHUB_API_URL', { defaultNote: 'https://api.github.com (test/GHES hook only)', validate: httpUrl });
check('chat', chat, 'GITHUB_WEB_URL', { defaultNote: 'https://github.com (test/GHES hook only)', validate: httpUrl });
if (!ghAny) {
  const stagingFile = resolve(root, 'services/chat/.env.github-app.pending');
  const staged = existsSync(stagingFile) ? dotenv.parse(readFileSync(stagingFile, 'utf8')) : {};
  const group = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_OAUTH_CALLBACK_URL', 'GITHUB_APP_INSTALL_URL', 'PUBLIC_CHAT_URL'];
  const have = group.filter((k) => isSet(staged[k]));
  probe('chat', 'GitHub App feature', 'BLOCKED', have.length
    ? `group staged in services/chat/.env.github-app.pending (${have.length}/${group.length}); still missing: ${group.filter((k) => !have.includes(k)).join(', ')}. Then: npm run env:github-activate`
    : 'no GitHub App variable is set, so the bounty commands answer "not configured"');
}

// LLM (chat parser) — Bedrock takes precedence; LLM_PROVIDER=bedrock with missing parts aborts startup
function llmChecks(svc, env, modelVar, priority) {
  const v = env.values;
  const provider = (v.LLM_PROVIDER ?? '').trim();
  if (provider && provider !== 'bedrock') row(svc, 'LLM_PROVIDER', 'PRESENT_BUT_INVALID', 'only "bedrock" is recognised; leave empty for the OpenAI-compatible variables', priority);
  else if (provider === 'bedrock') row(svc, 'LLM_PROVIDER', 'PRESENT_AND_VALID', 'bedrock');
  else row(svc, 'LLM_PROVIDER', 'MISSING', 'unset: Bedrock disabled', priority);
  const bedrock = provider === 'bedrock';
  const na = bedrock ? null : 'LLM_PROVIDER is not bedrock';
  check(svc, env, 'AWS_REGION', { required: bedrock, priority, na, validate: (r) => (/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(r) ? null : 'not an AWS region name') });
  check(svc, env, 'AWS_BEARER_TOKEN_BEDROCK', { required: bedrock, priority, na, secret: true, validate: () => null });
  check(svc, env, modelVar, { required: bedrock, priority, na, validate: (m) => (/^[a-z0-9.:_-]+$/i.test(m) ? null : 'unexpected characters for a model/inference-profile ID') });
  check(svc, env, 'BEDROCK_MAX_OUTPUT_TOKENS', { defaultNote: '2048', na, validate: intIn(1, 8192) });
  check(svc, env, 'BEDROCK_MAX_INPUT_CHARS', { defaultNote: '120000', na, validate: intIn(1000, 1_000_000) });
  const trio = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'];
  const set = trio.filter((k) => isSet(v[k]));
  for (const k of trio) {
    if (bedrock && isSet(v[k])) row(svc, k, 'NOT_APPLICABLE', 'ignored: Bedrock takes precedence');
    else if (bedrock) row(svc, k, 'NOT_APPLICABLE', 'not needed with Bedrock');
    else if (set.length && set.length < 3 && !isSet(v[k])) row(svc, k, 'MISSING', 'partial OpenAI-compatible configuration: all three are required together', priority);
    else check(svc, env, k, { secret: k === 'LLM_API_KEY', validate: k === 'LLM_BASE_URL' ? httpUrl : () => null });
  }
  if (bedrock && isSet(v[modelVar])) row(svc, `${modelVar} (availability)`, 'REQUIRES_LIVE_VERIFICATION', 'an ID in configuration is not proof the model/inference profile exists or is accessible in this account and region');
  return bedrock || set.length === 3;
}
const chatLlm = llmChecks('chat', chat, 'BEDROCK_CHAT_MODEL_ID', 'P1');

// ------------------------------------------------------------------ engine
const e = engine.values;
check('engine', engine, 'DATABASE_URL', { required: true, validate: (v) => { const u = url(v); return u && /^postgres(ql)?:$/.test(u.protocol) ? null : 'must be a postgresql:// URL'; } });
check('engine', engine, 'INTERNAL_API_TOKEN', { required: true, secret: true, validate: strongSecret });
check('engine', engine, 'REDEMPTION_ENCRYPTION_KEY', { required: true, secret: true, validate: (v) => (/^[a-fA-F0-9]{64}$/.test(v) ? null : 'must be 64 hex characters (openssl rand -hex 32)') });
check('engine', engine, 'BITREFILL_API_KEY', { required: true, secret: true, validate: () => null });
check('engine', engine, 'BITREFILL_BASE_URL', { defaultNote: 'https://api.bitrefill.com/v2', validate: (v) => (v === 'https://api.bitrefill.com/v2' ? null : 'the engine only accepts https://api.bitrefill.com/v2') });
const live = (e.LIVE_PURCHASES_ENABLED ?? 'false').trim();
check('engine', engine, 'PUBLIC_ENGINE_URL', { required: true, validate: (v) => { const u = url(v); if (!u) return 'not a URL'; if (live === 'true' && u.protocol !== 'https:') return 'live mode requires https (Bitrefill webhook callback)'; return null; } });
if (live !== 'false' && live !== 'true') row('engine', 'LIVE_PURCHASES_ENABLED', 'PRESENT_BUT_INVALID', 'must be "true" or "false"', 'P0');
else if (live === 'true') row('engine', 'LIVE_PURCHASES_ENABLED', 'PRESENT_BUT_INVALID', 'LIVE SPENDING IS ENABLED. Keep false until the owner explicitly authorizes a real purchase', 'P0');
else row('engine', 'LIVE_PURCHASES_ENABLED', isSet(e.LIVE_PURCHASES_ENABLED) ? 'PRESENT_AND_VALID' : 'NOT_APPLICABLE', isSet(e.LIVE_PURCHASES_ENABLED) ? 'false (test mode)' : 'unset; defaults to false (test mode)');
check('engine', engine, 'AUTHORIZED_RECIPIENT_CHAT_ID', { required: true, priority: 'P0', validate: (v) => (/^[1-9]\d{0,14}$/.test(v) ? null : 'must be the positive numeric private chat ID of the contributor') });
check('engine', engine, 'PORT', { defaultNote: '3001', validate: intIn(1, 65535) });
check('engine', engine, 'APPROVAL_TTL_SECONDS', { defaultNote: '900', validate: intIn(30, 86400) });
check('engine', engine, 'WORKER_INTERVAL_MS', { defaultNote: '2000', validate: intIn(250, 60000) });
check('engine', engine, 'LLM_REVIEW_MAX_CALLS_PER_PR', { defaultNote: '6', validate: intIn(1, 10) });
check('engine', engine, 'AI_REVIEW_MIN_CONFIDENCE', { defaultNote: '0.8', validate: numIn(0.5, 1) });
check('engine', engine, 'AI_REVIEW_MAX_AGE_SECONDS', { defaultNote: '3600', validate: intIn(60, 86400) });
check('engine', engine, 'AI_ALLOW_PRIVATE_REPOSITORIES', { defaultNote: 'false', validate: (v) => (['true', 'false'].includes(v) ? null : 'must be true or false') });
const engineLlm = llmChecks('engine', engine, 'BEDROCK_REVIEW_MODEL_ID', 'P0');
if (!engineLlm) probe('engine', 'AI reviewer', 'BLOCKED', 'no reviewer configured: every contribution review is held as MODEL_UNAVAILABLE, so no bounty can ever be eligible');

// ------------------------------------------------------------------ cross-service
if (isSet(c.INTERNAL_API_TOKEN) && isSet(e.INTERNAL_API_TOKEN)) {
  if (c.INTERNAL_API_TOKEN.trim() === e.INTERNAL_API_TOKEN.trim()) probe('cross', 'INTERNAL_API_TOKEN identical in both services', 'PASS', 'equal (values not shown)');
  else probe('cross', 'INTERNAL_API_TOKEN identical in both services', 'FAIL', 'the two services have different tokens; every chat→engine call will get 401');
} else probe('cross', 'INTERNAL_API_TOKEN identical in both services', 'BLOCKED', 'not set in both services');
const engUrl = url(c.ENGINE_URL || 'http://localhost:3001');
const engPort = e.PORT || '3001';
if (engUrl && isLocalHost(engUrl.hostname) && (engUrl.port || (engUrl.protocol === 'https:' ? '443' : '80')) !== engPort) probe('cross', 'chat ENGINE_URL port matches engine PORT', 'FAIL', `ENGINE_URL points at port ${engUrl.port || 'default'} but engine PORT is ${engPort}`, 'P0');
else probe('cross', 'chat ENGINE_URL port matches engine PORT', 'PASS', `engine expected at ${engUrl ? engUrl.origin : '?'}`);
if (isSet(c.TELEGRAM_OWNER_USER_ID) && isSet(e.AUTHORIZED_RECIPIENT_CHAT_ID)) {
  probe('cross', 'owner vs recipient', 'INFO', c.TELEGRAM_OWNER_USER_ID.trim() === e.AUTHORIZED_RECIPIENT_CHAT_ID.trim() ? 'recipient IS the owner: bounty policies forbid self-reward unless allowSelfReward; use the contributor\'s chat ID' : 'recipient differs from the owner (expected for a contributor reward)');
}
if (isSet(c.AWS_BEARER_TOKEN_BEDROCK) || isSet(e.AWS_BEARER_TOKEN_BEDROCK)) probe('cross', 'Bedrock credentials', 'INFO', 'each service reads its own AWS_* variables; the same API key may be used in both files');
for (const [name, a, b] of [['PORT', c.PORT || '3002', e.PORT || '3001']]) if (a === b) probe('cross', `${name} collision`, 'FAIL', 'chat and engine are configured for the same port', 'P0');

// ------------------------------------------------------------------ application validators (the real code paths)
async function appValidators() {
  try {
    const { loadConfig } = await import(resolve(root, 'services/chat/dist/config.js'));
    try { const cfg = loadConfig({ ...c }); probe('chat', 'services/chat loadConfig()', 'PASS', `starts; GitHub App feature ${cfg.github ? 'ON' : 'OFF'}; AI parser ${cfg.llm ? 'ON' : 'OFF (guided mode)'}; owner ${cfg.ownerUserId ? 'set' : 'unset (setup mode)'}`); }
    catch (err) { probe('chat', 'services/chat loadConfig()', 'FAIL', redactMsg(err), 'P0'); }
  } catch { probe('chat', 'services/chat loadConfig()', 'NOT_TESTED', 'build missing: run npm run build', 'P1'); }
  try {
    const { loadConfig } = await import(resolve(root, 'services/engine/dist/src/config.js'));
    try { loadConfig({ ...e }); probe('engine', 'services/engine loadConfig()', 'PASS', `starts in ${(e.LIVE_PURCHASES_ENABLED ?? 'false') === 'true' ? 'LIVE' : 'test'} mode`); }
    catch (err) { probe('engine', 'services/engine loadConfig()', 'FAIL', redactMsg(err), 'P0'); }
    try { const { bedrockConfig } = await import(resolve(root, 'services/engine/dist/src/bedrock.js')); bedrockConfig({ ...e }, 'REVIEW'); }
    catch (err) { probe('engine', 'Bedrock reviewer configuration', 'FAIL', `${redactMsg(err)} (the engine will refuse to start)`, 'P0'); }
  } catch { probe('engine', 'services/engine loadConfig()', 'NOT_TESTED', 'build missing: run npm run build', 'P1'); }
}
/** Validator messages name variables, never values; still strip anything that looks like a credential. */
function redactMsg(err) {
  return String(err?.message ?? err).replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-:.+/=]{24,}/g, (m) => (/^[A-Z][A-Z0-9_]+$/.test(m) ? m : '[redacted]')).slice(0, 300);
}

// ------------------------------------------------------------------ read-only probes
async function http(urlStr, init = {}) {
  const res = await fetch(urlStr, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...init });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body, headers: res.headers };
}
function appJwt(appId, pem) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(pem, 'base64url')}`;
}
function pemText() {
  if (isSet(c.GITHUB_APP_PRIVATE_KEY_PATH)) { const p = c.GITHUB_APP_PRIVATE_KEY_PATH.trim(); return readFileSync(isAbsolute(p) ? p : resolve(root, 'services/chat', p), 'utf8'); }
  let key = c.GITHUB_APP_PRIVATE_KEY.trim().replace(/^"|"$/g, '');
  if (!key.includes('BEGIN')) key = Buffer.from(key, 'base64').toString('utf8');
  return key.replace(/\\n/g, '\n');
}

async function probeDatabase() {
  if (!isSet(e.DATABASE_URL)) return probe('postgres', 'connect with engine DATABASE_URL', 'BLOCKED', 'DATABASE_URL not set');
  const pg = requireFrom('pg');
  const client = new pg.Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const v = (await client.query('SHOW server_version')).rows[0].server_version;
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    probe('postgres', 'connect with engine DATABASE_URL', 'PASS', `PostgreSQL ${v}, database "${db}"`);
    const mig = await client.query("SELECT name FROM engine_migrations ORDER BY name").catch(() => null);
    const files = ['001_initial.sql', '002_ai_bounties.sql', '003_identity_revocation.sql'];
    const applied = mig ? mig.rows.map((r) => r.name) : [];
    const missing = files.filter((f) => !applied.includes(f));
    probe('postgres', 'migrations 001–003 applied', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.join(', ')} — run: cd services/engine && npm run migrate (additive, safe to re-run)` : 'all applied');
    const uncertain = await client.query("SELECT count(*)::int AS n FROM purchases WHERE status IN ('PAYMENT_UNCERTAIN','INVOICE_UNCERTAIN','INVOICE_CREATION_UNCERTAIN','PAYMENT_PROCESSING')").catch(() => null);
    if (uncertain) probe('postgres', 'no unresolved uncertain payments', uncertain.rows[0].n === 0 ? 'PASS' : 'FAIL', uncertain.rows[0].n === 0 ? 'none' : `${uncertain.rows[0].n} purchase(s) need reconciliation before any live run; do NOT retry by hand`);
  } catch { probe('postgres', 'connect with engine DATABASE_URL', 'BLOCKED', 'connection failed (server down, wrong host/port/user/database, or auth)'); }
  finally { await client.end().catch(() => {}); }
}

async function probeServices() {
  const engineBase = (c.ENGINE_URL || 'http://localhost:3001').replace(/\/+$/, '');
  try {
    const h = await http(`${engineBase}/health`);
    if (h.status === 200 && h.body?.service === 'engine') {
      probe('engine', 'GET /health', 'PASS', `running; livePurchasesEnabled=${h.body.livePurchasesEnabled}`);
      if (h.body.livePurchasesEnabled !== false) probe('engine', 'running engine is in test mode', 'FAIL', 'the RUNNING engine reports live purchases enabled', 'P0');
      if (isSet(c.INTERNAL_API_TOKEN)) {
        const a = await http(`${engineBase}/v1/rules?ownerChatId=${encodeURIComponent(c.TELEGRAM_OWNER_USER_ID || '1')}`, { headers: { Authorization: `Bearer ${c.INTERNAL_API_TOKEN}` } });
        probe('cross', 'chat token accepted by running engine', a.status === 200 ? 'PASS' : 'FAIL', a.status === 200 ? 'authenticated request OK' : `engine answered HTTP ${a.status}`);
      }
    } else probe('engine', 'GET /health', 'BLOCKED', `no engine at ${engineBase} (HTTP ${h.status})`, 'P0');
  } catch { probe('engine', 'GET /health', 'BLOCKED', `engine not reachable at ${engineBase} (not started?)`, 'P0'); }
  const chatPort = c.PORT || '3002';
  try { const h = await http(`http://127.0.0.1:${chatPort}/healthz`); probe('chat', 'GET /healthz (local)', h.status === 200 ? 'PASS' : 'BLOCKED', `HTTP ${h.status}`); }
  catch { probe('chat', 'GET /healthz (local)', 'BLOCKED', `chat service not reachable on port ${chatPort} (not started?)`, 'P0'); }
  if (pub) {
    try { const h = await http(`${pub.origin}/healthz`); probe('chat', 'GET PUBLIC_CHAT_URL/healthz (tunnel)', h.status === 200 ? 'PASS' : 'FAIL', `HTTP ${h.status}`); }
    catch { probe('chat', 'GET PUBLIC_CHAT_URL/healthz (tunnel)', 'BLOCKED', 'public URL not reachable (tunnel down or URL changed)'); }
  }
}

async function probeTelegram() {
  const token = c.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return probe('telegram', 'getMe', 'BLOCKED', 'TELEGRAM_BOT_TOKEN missing');
  const call = async (m, params = {}) => { const u = new URL(`https://api.telegram.org/bot${token}/${m}`); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); const r = await http(u); return r.body?.ok ? r.body.result : Promise.reject(Object.assign(new Error('telegram'), { status: r.status, code: r.body?.error_code })); };
  try {
    const me = await call('getMe');
    probe('telegram', 'getMe', me.username === 'buyoncueBot' ? 'PASS' : 'FAIL', me.username === 'buyoncueBot' ? 'authenticated as @buyoncueBot' : `token belongs to @${me.username}, not @buyoncueBot`);
    const wh = await call('getWebhookInfo');
    probe('telegram', 'no Telegram webhook (long polling)', wh.url ? 'FAIL' : 'PASS', wh.url ? 'a webhook is set; long polling will fail. Run deleteWebhook (see docs/TELEGRAM_SETUP.md)' : `ok; ${wh.pending_update_count} pending update(s)`);
    for (const [label, id] of [['owner', c.TELEGRAM_OWNER_USER_ID], ['recipient (AUTHORIZED_RECIPIENT_CHAT_ID)', e.AUTHORIZED_RECIPIENT_CHAT_ID]]) {
      if (!isSet(id)) { probe('telegram', `${label} private chat reachable`, 'BLOCKED', 'ID not configured'); continue; }
      try { const chatInfo = await call('getChat', { chat_id: id.trim() }); probe('telegram', `${label} private chat reachable`, chatInfo.type === 'private' ? 'PASS' : 'FAIL', `chat type ${chatInfo.type}`); }
      catch { probe('telegram', `${label} private chat reachable`, 'FAIL', 'Telegram cannot see this chat: that person must open @buyoncueBot and press Start'); }
    }
  } catch (err) { probe('telegram', 'getMe', err.code === 401 || err.status === 401 ? 'FAIL' : 'BLOCKED', err.code === 401 || err.status === 401 ? 'token rejected by Telegram (revoked or mistyped)' : 'Telegram API unreachable'); }
}

async function probeGithubApp() {
  if (!(isSet(c.GITHUB_APP_ID) && pemOk)) return probe('github-app', 'App JWT authentication', 'BLOCKED', 'GITHUB_APP_ID and a valid private key are required');
  const api = (c.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const jwt = appJwt(c.GITHUB_APP_ID.trim(), pemText());
  const H = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'buyoncue-audit' };
  const app = await http(`${api}/app`, { headers: H }).catch(() => null);
  if (!app || app.status !== 200) return probe('github-app', 'App JWT authentication', 'FAIL', `GET /app → HTTP ${app?.status ?? 'unreachable'} (wrong App ID, key from another app, or revoked key)`);
  const p = app.body.permissions ?? {};
  probe('github-app', 'App JWT authentication', 'PASS', `app "${app.body.slug}" (id ${app.body.id})`);
  if (isSet(c.GITHUB_APP_CLIENT_ID) && app.body.client_id && app.body.client_id !== c.GITHUB_APP_CLIENT_ID.trim()) probe('github-app', 'client ID matches app', 'FAIL', 'GITHUB_APP_CLIENT_ID is not this app\'s client ID');
  if (isSet(c.GITHUB_APP_INSTALL_URL) && !c.GITHUB_APP_INSTALL_URL.includes(`/apps/${app.body.slug}/`)) probe('github-app', 'install URL slug', 'FAIL', `GITHUB_APP_INSTALL_URL must use slug "${app.body.slug}"`);
  else probe('github-app', 'install URL slug', 'INFO', `expected https://github.com/apps/${app.body.slug}/installations/new`);
  const need = { pull_requests: 'read', checks: 'read', statuses: 'read', issues: 'read', metadata: 'read' };
  const missingPerm = Object.keys(need).filter((k) => !p[k]);
  const writes = Object.entries(p).filter(([, v]) => v === 'write' || v === 'admin').map(([k]) => k);
  probe('github-app', 'read permissions granted', missingPerm.length ? 'FAIL' : 'PASS', missingPerm.length ? `missing: ${missingPerm.join(', ')}` : 'pull_requests, checks, statuses, issues, metadata');
  if (writes.length) probe('github-app', 'no write permissions', 'FAIL', `write/admin granted on: ${writes.join(', ')} (not needed; remove)`, 'P1');
  probe('github-app', 'pull_request events subscribed', (app.body.events ?? []).includes('pull_request') ? 'PASS' : 'FAIL', (app.body.events ?? []).includes('pull_request') ? 'subscribed' : 'tick "Pull request" under Subscribe to events');
  const hook = await http(`${api}/app/hook/config`, { headers: H }).catch(() => null);
  if (hook?.status === 200) {
    const hu = url(hook.body.url ?? '');
    const expected = pub ? `${pub.origin}/webhooks/github` : null;
    const bad = !hu || /example\.com/i.test(hu.hostname) || hu.protocol !== 'https:';
    probe('github-app', 'webhook URL', bad ? 'FAIL' : expected && hook.body.url !== expected ? 'FAIL' : 'PASS', bad ? 'webhook URL is a placeholder or not https (e.g. https://example.com/buyoncue-webhook-disabled)' : expected && hook.body.url !== expected ? `webhook URL must be ${expected}` : 'matches PUBLIC_CHAT_URL/webhooks/github');
    probe('github-app', 'webhook SSL verification', String(hook.body.insecure_ssl) === '0' ? 'PASS' : 'FAIL', String(hook.body.insecure_ssl) === '0' ? 'enabled' : 'SSL verification disabled; enable it');
    probe('github-app', 'webhook content type', hook.body.content_type === 'json' ? 'PASS' : 'FAIL', `content_type=${hook.body.content_type}`);
    probe('github-app', 'webhook secret matches GITHUB_WEBHOOK_SECRET', 'REQUIRES_LIVE_VERIFICATION', 'GitHub never returns the secret; verify with a Redeliver/ping (expect HTTP 202, not 401)');
  } else probe('github-app', 'webhook config readable', 'BLOCKED', `GET /app/hook/config → HTTP ${hook?.status ?? 'unreachable'}`);
  const inst = await http(`${api}/app/installations?per_page=20`, { headers: H }).catch(() => null);
  const list = inst?.status === 200 ? inst.body : [];
  if (!list.length) return probe('github-app', 'installation on demo repo', 'FAIL', 'the app has no installations: install it (Only select repositories → demo repo)');
  const [owner, name] = DEMO_REPO.split('/');
  let found = null;
  for (const i of list.slice(0, 10)) {
    if (i.suspended_at) { probe('github-app', `installation ${i.id} (${i.account?.login})`, 'FAIL', 'suspended'); continue; }
    const t = await http(`${api}/app/installations/${i.id}/access_tokens`, { method: 'POST', headers: H }).catch(() => null);
    if (t?.status !== 201) { probe('github-app', `installation ${i.id} access token`, 'FAIL', `HTTP ${t?.status ?? 'unreachable'}`); continue; }
    const IH = { Authorization: `Bearer ${t.body.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'buyoncue-audit' };
    const repos = await http(`${api}/installation/repositories?per_page=100`, { headers: IH }).catch(() => null);
    const names = (repos?.body?.repositories ?? []).map((r) => r.full_name.toLowerCase());
    if (names.includes(DEMO_REPO.toLowerCase())) {
      found = i.id;
      probe('github-app', 'installation on demo repo', 'PASS', `installation ${i.id} can read ${DEMO_REPO} (access token obtained and discarded)`);
      const rules = await http(`${api}/repos/${owner}/${name}/rules/branches/${encodeURIComponent((await http(`${api}/repos/${owner}/${name}`, { headers: IH })).body?.default_branch ?? 'main')}`, { headers: IH }).catch(() => null);
      probe('github-app', 'can read branch rules (required checks)', rules?.status === 200 ? 'PASS' : 'FAIL', rules?.status === 200 ? `${(rules.body ?? []).filter((r) => r.type === 'required_status_checks').length} required-status-check rule(s) visible` : `HTTP ${rules?.status}`);
      const gql = await http(`${api}/graphql`, { method: 'POST', headers: { ...IH, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequests(first:1){nodes{reviewThreads(first:1){totalCount}}}}}` }) }).catch(() => null);
      probe('github-app', 'GraphQL review threads readable', gql?.status === 200 && !gql.body?.errors ? 'PASS' : 'FAIL', gql?.status === 200 && !gql.body?.errors ? 'readable' : `HTTP ${gql?.status}`);
    }
    await http(`${api}/installation/token`, { method: 'DELETE', headers: IH }).catch(() => {}); // revoke the short-lived token
    if (found) break;
  }
  if (!found) probe('github-app', 'installation on demo repo', 'FAIL', `none of the app's installations can read ${DEMO_REPO}`);
}

async function probeDemoRepo() {
  // Public, unauthenticated, read-only.
  const api = 'https://api.github.com';
  const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'buyoncue-audit' };
  const repo = await http(`${api}/repos/${DEMO_REPO}`, { headers: H }).catch(() => null);
  if (repo?.status !== 200) return probe('demo-repo', `${DEMO_REPO} readable`, 'BLOCKED', `HTTP ${repo?.status ?? 'unreachable'} (private repo needs the App probe)`);
  const branch = repo.body.default_branch;
  const wf = await http(`${api}/repos/${DEMO_REPO}/actions/workflows`, { headers: H }).catch(() => null);
  const n = wf?.body?.total_count ?? 0;
  probe('demo-repo', 'CI workflow exists', n > 0 ? 'PASS' : 'FAIL', n > 0 ? `${n} workflow(s)` : `no GitHub Actions workflow in ${DEMO_REPO}: add .github/workflows/ci.yml that runs on pull_request`);
  const rules = await http(`${api}/repos/${DEMO_REPO}/rules/branches/${branch}`, { headers: H }).catch(() => null);
  const req = (rules?.body ?? []).filter?.((r) => r.type === 'required_status_checks') ?? [];
  const contexts = req.flatMap((r) => (r.parameters?.required_status_checks ?? []).map((x) => x.context));
  probe('demo-repo', `ruleset requires a status check on ${branch}`, contexts.length ? 'PASS' : 'FAIL', contexts.length ? `required: ${contexts.join(', ')}` : 'no ruleset requires a status check: the engine will hold every reward with REQUIRED_CI_MISSING');
  if (contexts.length) {
    const sha = (await http(`${api}/repos/${DEMO_REPO}/commits/${branch}`, { headers: H }).catch(() => null))?.body?.sha;
    const runs = sha ? await http(`${api}/repos/${DEMO_REPO}/commits/${sha}/check-runs`, { headers: H }).catch(() => null) : null;
    const runNames = (runs?.body?.check_runs ?? []).map((r) => r.name);
    const unmatched = contexts.filter((x) => !runNames.includes(x));
    probe('demo-repo', 'required check names match real check runs', unmatched.length ? 'FAIL' : 'PASS', unmatched.length ? `no check run named: ${unmatched.join(', ')} on the latest ${branch} commit` : 'names match');
  }
  const labels = await http(`${api}/repos/${DEMO_REPO}/labels?per_page=100`, { headers: H }).catch(() => null);
  const has = (labels?.body ?? []).some?.((l) => l.name === 'reward-ready');
  probe('demo-repo', 'label "reward-ready" exists', has ? 'PASS' : 'FAIL', has ? 'exists' : 'create it (Issues → Labels → New label)', 'P1');
}

async function probeBedrockRegion() {
  for (const [svc, env] of [['chat', c], ['engine', e]]) {
    if ((env.LLM_PROVIDER ?? '').trim() !== 'bedrock' || !isSet(env.AWS_REGION)) continue;
    try { await lookup(`bedrock-runtime.${env.AWS_REGION.trim()}.amazonaws.com`); probe('bedrock', `${svc}: bedrock-runtime endpoint for region exists`, 'PASS', `bedrock-runtime.${env.AWS_REGION.trim()}.amazonaws.com resolves`); }
    catch { probe('bedrock', `${svc}: bedrock-runtime endpoint for region exists`, 'FAIL', 'region has no Bedrock runtime endpoint (or DNS unavailable)'); }
  }
  probe('bedrock', 'model invocation', 'NOT_TESTED', 'metered: run scripts/check-bedrock.mjs CHAT|REVIEW --confirm-metered only after approving the cost', 'P0');
}

async function probeBitrefill() {
  const key = e.BITREFILL_API_KEY?.trim();
  if (!key) return probe('bitrefill', 'authenticated read-only API', 'BLOCKED', 'BITREFILL_API_KEY missing (needed even in test mode: the catalogue is always the real one)');
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const ping = await http('https://api.bitrefill.com/v2/ping', { headers: H }).catch(() => null);
  if (ping?.status !== 200) return probe('bitrefill', 'authenticated read-only API', 'FAIL', `GET /ping → HTTP ${ping?.status ?? 'unreachable'} (invalid key, or a key for a different API)`);
  const bal = await http('https://api.bitrefill.com/v2/accounts/balance', { headers: H }).catch(() => null);
  const cur = bal?.body?.data?.currency;
  probe('bitrefill', 'account balance readable', bal?.status === 200 ? 'PASS' : 'FAIL', bal?.status === 200 ? `readable; currency ${cur} (amount not printed). The engine only pays when the balance currency is USD` : `HTTP ${bal?.status}`);
  if (bal?.status === 200 && cur !== 'USD') probe('bitrefill', 'balance currency is USD', 'FAIL', 'the engine enforces USD caps against a USD balance; non-USD balances block payment', 'P0');
  probe('bitrefill', 'Indian catalogue / packages', 'INFO', 'run `npm run check:live` for the catalogue search (read-only)');
}

// ------------------------------------------------------------------ run
await appValidators();
if (PROBE) {
  await probeDatabase();
  await probeServices();
  await probeTelegram();
  await probeGithubApp();
  await probeDemoRepo();
  await probeBedrockRegion();
  await probeBitrefill();
} else probes.push({ component: 'audit', check: 'network probes', result: 'NOT_TESTED', detail: 'run with --probe for read-only network checks', priority: null });

if (WRITE_MISSING) {
  for (const [svc] of [['chat'], ['engine']]) {
    const missing = rows.filter((r) => r.svc === svc && ['MISSING', 'PLACEHOLDER', 'PRESENT_BUT_INVALID'].includes(r.status) && r.priority && /^[A-Z_]+$/.test(r.name));
    const text = `# Generated by scripts/audit-config.mjs — names and hints only, never values. Copy what you need into services/${svc}/.env.\n` + missing.map((r) => `# ${r.priority} ${r.status}: ${r.reason}\n${r.name}=`).join('\n') + '\n';
    writeFileSync(resolve(root, `services/${svc}/.env.missing.example`), text, { mode: 0o600 });
  }
}

const blockers = [...rows, ...probes].filter((r) => r.priority === 'P0');
if (JSON_OUT) {
  console.log(JSON.stringify({ demoRepo: DEMO_REPO, probe: PROBE, variables: rows, checks: probes, p0Blockers: blockers.length }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`BuyOnCue configuration audit (${PROBE ? 'with read-only probes' : 'offline'}; demo repo ${DEMO_REPO}). Values are never printed.\n`);
  console.log(`${pad('SERVICE', 8)} ${pad('VARIABLE', 34)} ${pad('STATUS', 27)} ${pad('PRI', 4)} REASON`);
  for (const r of rows) console.log(`${pad(r.svc, 8)} ${pad(r.name, 34)} ${pad(r.status, 27)} ${pad(r.priority ?? '', 4)} ${r.reason}`);
  console.log(`\n${pad('AREA', 11)} ${pad('CHECK', 48)} ${pad('RESULT', 27)} ${pad('PRI', 4)} DETAIL`);
  for (const p of probes) console.log(`${pad(p.component, 11)} ${pad(p.check, 48)} ${pad(p.result, 27)} ${pad(p.priority ?? '', 4)} ${p.detail}`);
  const valid = rows.filter((r) => r.status === 'PRESENT_AND_VALID').length;
  console.log(`\n${valid} variable(s) valid · ${blockers.length} P0 blocker(s) · ${[...rows, ...probes].filter((r) => r.priority === 'P1').length} P1 · ${[...rows, ...probes].filter((r) => r.priority === 'P2').length} P2`);
}
process.exitCode = blockers.length ? 1 : 0;
