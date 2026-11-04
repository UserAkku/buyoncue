#!/usr/bin/env node
// Local .env helper for BuyOnCue. Idempotent; never prints a value; never rotates an existing secret by itself.
//
//   npm run env:repair                         remove duplicate definitions (keeps the value dotenv already uses: the LAST one),
//                                              add missing non-secret defaults, stage non-secret GitHub App/Bedrock settings, chmod 600
//   npm run env:set -- <chat|engine|both> <VAR> [--replace]
//                                              prompt for a value WITHOUT echo (or read it from a pipe, e.g. `pbpaste | npm run env:set -- …`),
//                                              validate it and save it. Nothing reaches shell history or the terminal.
//   npm run env:github-key -- <downloaded.pem> [--replace]
//                                              copy the GitHub App private key to ~/.buyoncue/github-app.pem (mode 600) and stage its path
//   npm run env:public-url -- https://<host>   stage PUBLIC_CHAT_URL and GITHUB_OAUTH_CALLBACK_URL (and update them if the App is active)
//   npm run env:github-activate                move the complete GitHub App group into services/chat/.env (refuses if anything is missing)
//   npm run env:status                         names-only summary
//
// The GitHub App settings are all-or-none in services/chat (a partial group stops the service), so they are collected in the
// git-ignored staging file services/chat/.env.github-app.pending until complete. Bedrock is switched on (LLM_PROVIDER=bedrock)
// only when the API key is saved, because LLM_PROVIDER=bedrock without a key also stops the services.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// BUYONCUE_SETUP_ROOT / BUYONCUE_KEY_DIR exist only so the tests can run against a temporary copy.
const root = process.env.BUYONCUE_SETUP_ROOT ? resolve(process.env.BUYONCUE_SETUP_ROOT) : repoRoot;
const FILES = {
  chat: resolve(root, 'services/chat/.env'),
  engine: resolve(root, 'services/engine/.env'),
  github: resolve(root, 'services/chat/.env.github-app.pending'),
};
const KEY_DIR = process.env.BUYONCUE_KEY_DIR ? resolve(process.env.BUYONCUE_KEY_DIR) : resolve(homedir(), '.buyoncue');
const KEY_PATH = resolve(KEY_DIR, 'github-app.pem');

const DEFAULTS = {
  engine: {
    DATABASE_URL: 'postgresql://buyoncue_app@127.0.0.1:5432/buyoncue_dev',
    PUBLIC_ENGINE_URL: 'http://localhost:3001',
    BITREFILL_BASE_URL: 'https://api.bitrefill.com/v2',
    LIVE_PURCHASES_ENABLED: 'false',
    PORT: '3001',
    // Bedrock is inert until LLM_PROVIDER=bedrock (set automatically when the API key is saved).
    AWS_REGION: 'ap-south-1',
    BEDROCK_REVIEW_MODEL_ID: 'global.anthropic.claude-sonnet-5-5',
    BEDROCK_MAX_OUTPUT_TOKENS: '2048',
    BEDROCK_MAX_INPUT_CHARS: '120000',
    LLM_REVIEW_MAX_CALLS_PER_PR: '6',
  },
  chat: {
    ENGINE_URL: 'http://localhost:3001',
    PORT: '3002',
    AWS_REGION: 'ap-south-1',
    BEDROCK_CHAT_MODEL_ID: 'global.anthropic.claude-haiku-5-5',
    BEDROCK_MAX_OUTPUT_TOKENS: '2048',
    BEDROCK_MAX_INPUT_CHARS: '120000',
  },
  github: {
    GITHUB_APP_ID: '5609798',
    GITHUB_APP_CLIENT_ID: 'Iv23ligq8KkwCysuqvO9',
    GITHUB_APP_INSTALL_URL: 'https://github.com/apps/buyoncue/installations/new',
  },
};
const GITHUB_GROUP = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_OAUTH_CALLBACK_URL', 'GITHUB_APP_INSTALL_URL', 'PUBLIC_CHAT_URL'];

/** Variables `set` accepts: where they go, whether they are secret, and the format check. */
const SETTABLE = {
  TELEGRAM_BOT_TOKEN: { svc: ['chat'], secret: true, ok: (v) => /^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(v), hint: 'BotFather token: <digits>:<secret>' },
  TELEGRAM_OWNER_USER_ID: { svc: ['chat'], secret: false, ok: (v) => /^[1-9]\d{0,14}$/.test(v), hint: 'numeric Telegram user ID from /whoami' },
  AUTHORIZED_RECIPIENT_CHAT_ID: { svc: ['engine'], secret: false, ok: (v) => /^[1-9]\d{0,14}$/.test(v), hint: "the contributor's numeric private chat ID from /whoami" },
  BITREFILL_API_KEY: { svc: ['engine'], secret: true, ok: (v) => /^\S{16,}$/.test(v), hint: 'Bitrefill Personal API key' },
  AWS_BEARER_TOKEN_BEDROCK: { svc: ['chat', 'engine'], secret: true, ok: (v) => /^\S{20,}$/.test(v), hint: 'Amazon Bedrock API key' },
  BEDROCK_CHAT_MODEL_ID: { svc: ['chat'], secret: false, ok: (v) => /^[a-z0-9.:_-]+$/i.test(v), hint: 'inference-profile ID from the Bedrock console' },
  BEDROCK_REVIEW_MODEL_ID: { svc: ['engine'], secret: false, ok: (v) => /^[a-z0-9.:_-]+$/i.test(v), hint: 'inference-profile ID from the Bedrock console' },
  AWS_REGION: { svc: ['chat', 'engine'], secret: false, ok: (v) => /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(v), hint: 'e.g. ap-south-1' },
  GITHUB_APP_CLIENT_SECRET: { svc: ['github'], secret: true, ok: (v) => /^[0-9a-f]{40}$/i.test(v), hint: 'new client secret from the GitHub App page (40 hex characters)' },
};

// ------------------------------------------------------------------ file model (keeps comments and order)
function read(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/);
}
const keyOf = (line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] ?? null;
function valueOf(line) {
  let v = line.slice(line.indexOf('=') + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}
function get(lines, key) {
  let v; // last definition wins, exactly like dotenv
  for (const l of lines) if (keyOf(l) === key) v = valueOf(l);
  return v;
}
function set(lines, key, value) {
  const out = [];
  let done = false;
  for (const l of lines) {
    if (keyOf(l) !== key) out.push(l);
    else if (!done) { out.push(`${key}=${value}`); done = true; }
  }
  if (!done) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push(`${key}=${value}`);
  }
  return out;
}
function remove(lines, key) { return lines.filter((l) => keyOf(l) !== key); }
function write(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  const text = lines.join('\n').replace(/\n*$/, '\n');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
/** Remove earlier duplicates, keeping the last definition (the one dotenv uses). */
function dedupe(lines) {
  const last = new Map();
  lines.forEach((l, i) => { const k = keyOf(l); if (k) last.set(k, i); });
  const removed = new Set();
  const out = lines.filter((l, i) => { const k = keyOf(l); if (k && last.get(k) !== i) { removed.add(k); return false; } return true; });
  return { out, removed: [...removed] };
}
const say = (s) => process.stdout.write(`${s}\n`);

// ------------------------------------------------------------------ commands
function repair() {
  const report = [];
  for (const svc of ['chat', 'engine']) {
    let lines = read(FILES[svc]);
    const { out, removed } = dedupe(lines);
    lines = out;
    if (removed.length) report.push(`${svc}: removed earlier duplicate definitions of ${removed.join(', ')} (kept the last value, which is what the service already used)`);
    const added = [];
    for (const [k, v] of Object.entries(DEFAULTS[svc])) if (get(lines, k) === undefined || get(lines, k) === '') { lines = set(lines, k, v); added.push(k); }
    if (added.length) report.push(`${svc}: added non-secret defaults ${added.join(', ')}`);
    write(FILES[svc], lines);
  }
  // GitHub App: never put a partial group into chat/.env.
  const chatLines = read(FILES.chat);
  const activeGithub = GITHUB_GROUP.some((k) => get(chatLines, k));
  if (!activeGithub) {
    let g = dedupe(read(FILES.github)).out;
    const added = [];
    for (const [k, v] of Object.entries(DEFAULTS.github)) if (!get(g, k)) { g = set(g, k, v); added.push(k); }
    write(FILES.github, g);
    if (added.length) report.push(`github (staged in services/chat/.env.github-app.pending): ${added.join(', ')}`);
  }
  const c = get(read(FILES.chat), 'INTERNAL_API_TOKEN');
  const e = get(read(FILES.engine), 'INTERNAL_API_TOKEN');
  report.push(c && e ? (c === e ? 'INTERNAL_API_TOKEN: identical in both services' : 'INTERNAL_API_TOKEN: DIFFERENT between services — not changed automatically; run `npm run env:sync-token`') : 'INTERNAL_API_TOKEN: missing in one or both services');
  report.push('both .env files are mode 600');
  for (const r of report) say(`• ${r}`);
}

function syncToken() {
  // Copies the engine's token to the chat service (the engine is the authority). Never prints it.
  const e = get(read(FILES.engine), 'INTERNAL_API_TOKEN');
  if (!e) { say('engine INTERNAL_API_TOKEN is missing; nothing to sync'); process.exit(1); }
  write(FILES.chat, set(read(FILES.chat), 'INTERNAL_API_TOKEN', e));
  say('• chat INTERNAL_API_TOKEN now equals the engine token (value not shown)');
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolveValue, reject) => {
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { cleanup(); process.stderr.write('\n'); return resolveValue(value.trim()); }
        if (ch === '\u0003') { cleanup(); process.stderr.write('\n'); return reject(new Error('cancelled')); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    const cleanup = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); };
    process.stdin.on('data', onData);
  });
}

async function setVar(target, name, replace) {
  const spec = SETTABLE[name];
  // Never echo the argument: people sometimes type the secret itself instead of the variable name.
  if (!spec) {
    const looksSecret = typeof name === 'string' && (/[:=]/.test(name) || name.length > 40 || /[a-z0-9]{20,}/i.test(name) && !/^[A-Z0-9_]+$/.test(name));
    say(looksSecret
      ? 'Refusing: that argument looks like a SECRET VALUE, not a variable name. It is now in your shell history: revoke/rotate it at the provider. Usage: npm run env:set -- <chat|engine|both> <VARIABLE_NAME>, then paste the value at the hidden prompt.'
      : `Refusing: unknown variable name. Settable: ${Object.keys(SETTABLE).join(', ')}`);
    process.exit(2);
  }
  if (!['chat', 'engine', 'both'].includes(target)) { say('First argument must be chat, engine or both.'); process.exit(2); }
  const services = spec.svc[0] === 'github' ? ['github'] : target === 'both' ? spec.svc : [target];
  if (!services.every((s) => spec.svc.includes(s))) { say(`${name} belongs in: ${spec.svc.join(' and ')}`); process.exit(2); }
  for (const s of services) {
    const existing = s === 'github' ? get(read(FILES.github), name) || get(read(FILES.chat), name) : get(read(FILES[s]), name);
    if (existing && !replace) { say(`${name} is already set for ${s}; not changed. Re-run with --replace to rotate it deliberately.`); process.exit(1); }
  }
  const value = await readSecret(`${name} (${spec.hint})${spec.secret ? ', input hidden' : ''}: `);
  if (!value) { say('Empty input; nothing saved.'); process.exit(1); }
  if (!spec.ok(value)) { say(`That does not look like a valid ${name} (${spec.hint}). Nothing saved.`); process.exit(1); }
  for (const s of services) {
    if (s === 'github') {
      const active = GITHUB_GROUP.some((k) => get(read(FILES.chat), k));
      write(active ? FILES.chat : FILES.github, set(read(active ? FILES.chat : FILES.github), name, value));
      say(`• ${name} saved ${active ? 'in services/chat/.env' : 'in the GitHub App staging file'} (value not shown)`);
    } else {
      let lines = set(read(FILES[s]), name, value);
      if (name === 'AWS_BEARER_TOKEN_BEDROCK') {
        const model = s === 'chat' ? 'BEDROCK_CHAT_MODEL_ID' : 'BEDROCK_REVIEW_MODEL_ID';
        if (get(lines, 'AWS_REGION') && get(lines, model)) lines = set(lines, 'LLM_PROVIDER', 'bedrock');
      }
      write(FILES[s], lines);
      say(`• ${name} saved in services/${s}/.env (value not shown)${name === 'AWS_BEARER_TOKEN_BEDROCK' ? '; LLM_PROVIDER=bedrock enabled' : ''}`);
    }
  }
  say('Restart the affected service(s), then run: npm run audit:config');
}

function githubKey(src, replace) {
  if (!src || !existsSync(src)) { say('Give the path of the downloaded .pem, e.g. npm run env:github-key -- ~/Downloads/buyoncue.2026-11-04.private-key.pem'); process.exit(2); }
  try { if (createPrivateKey(readFileSync(src)).asymmetricKeyType !== 'rsa') throw new Error(); } catch { say('That file is not an RSA private key PEM. Nothing changed.'); process.exit(1); }
  if (resolve(src).startsWith(root + '/')) say('Note: the source file is inside the repository; it is git-ignored (*.pem), but delete it after this step.');
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  chmodSync(KEY_DIR, 0o700);
  if (existsSync(KEY_PATH) && !replace && readFileSync(KEY_PATH).compare(readFileSync(src)) !== 0) { say(`${KEY_PATH} already holds a different key; re-run with --replace to rotate deliberately.`); process.exit(1); }
  copyFileSync(src, KEY_PATH);
  chmodSync(KEY_PATH, 0o600);
  const active = GITHUB_GROUP.some((k) => get(read(FILES.chat), k));
  const file = active ? FILES.chat : FILES.github;
  write(file, remove(set(read(file), 'GITHUB_APP_PRIVATE_KEY_PATH', KEY_PATH), 'GITHUB_APP_PRIVATE_KEY'));
  say(`• private key stored at ${KEY_PATH} (mode 600); GITHUB_APP_PRIVATE_KEY_PATH ${active ? 'updated in services/chat/.env' : 'staged'}`);
  say(`• You can now delete the downloaded copy: rm "${src}"`);
}

function publicUrl(u) {
  let url;
  try { url = new URL(u); } catch { say('Give the tunnel origin, e.g. https://xyz.trycloudflare.com'); process.exit(2); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || ['localhost', '127.0.0.1'].includes(url.hostname)) { say('PUBLIC_CHAT_URL must be a public https origin without a path'); process.exit(2); }
  const origin = url.origin;
  const active = GITHUB_GROUP.some((k) => get(read(FILES.chat), k));
  const file = active ? FILES.chat : FILES.github;
  write(file, set(set(read(file), 'PUBLIC_CHAT_URL', origin), 'GITHUB_OAUTH_CALLBACK_URL', `${origin}/auth/github/callback`));
  say(`• PUBLIC_CHAT_URL=${origin} and GITHUB_OAUTH_CALLBACK_URL=${origin}/auth/github/callback ${active ? 'updated in services/chat/.env (restart chat)' : 'staged'}`);
  say(`• GitHub App settings must use: Callback ${origin}/auth/github/callback · Setup ${origin}/auth/github/install/callback · Webhook ${origin}/webhooks/github`);
}

function githubActivate() {
  const g = read(FILES.github);
  const chatLines = read(FILES.chat);
  const missing = GITHUB_GROUP.filter((k) => !get(g, k) && !get(chatLines, k));
  if (missing.length) { say(`Not activated (the chat service would refuse a partial group). Still missing: ${missing.join(', ')}`); process.exit(1); }
  const keyPath = get(g, 'GITHUB_APP_PRIVATE_KEY_PATH') || get(chatLines, 'GITHUB_APP_PRIVATE_KEY_PATH');
  try { createPrivateKey(readFileSync(keyPath)); } catch { say('GITHUB_APP_PRIVATE_KEY_PATH does not point at a readable private key; not activated.'); process.exit(1); }
  let lines = remove(chatLines, 'GITHUB_APP_PRIVATE_KEY');
  for (const k of GITHUB_GROUP) { const v = get(g, k) || get(chatLines, k); lines = set(lines, k, v); }
  write(FILES.chat, lines);
  write(FILES.github, ['# GitHub App group activated into services/chat/.env']);
  say('• GitHub App group written to services/chat/.env (values not shown). Restart chat, then run: npm run audit:config:probe');
}

function status() {
  const names = (f) => [...new Set(read(f).map(keyOf).filter(Boolean))];
  for (const [label, f] of [['chat', FILES.chat], ['engine', FILES.engine], ['github staging', FILES.github]]) {
    const n = names(f);
    const dup = read(f).map(keyOf).filter(Boolean).filter((k, i, a) => a.indexOf(k) !== i);
    say(`${label}: ${n.length ? n.join(', ') : '(nothing)'}${dup.length ? `  [DUPLICATES: ${[...new Set(dup)].join(', ')}]` : ''}`);
  }
}

const [cmd, a1, a2] = process.argv.slice(2);
const replace = process.argv.includes('--replace');
switch (cmd) {
  case 'repair': repair(); break;
  case 'sync-token': syncToken(); break;
  case 'set': await setVar(a1, a2, replace).catch((e) => { say(e.message === 'cancelled' ? 'Cancelled; nothing saved.' : 'Failed; nothing saved.'); process.exit(1); }); break;
  case 'github-key': githubKey(a1, replace); break;
  case 'public-url': publicUrl(a1); break;
  case 'github-activate': githubActivate(); break;
  case 'status': status(); break;
  default: say('usage: env-setup.mjs repair | status | sync-token | set <chat|engine|both> <VAR> [--replace] | github-key <pem> [--replace] | public-url <https-origin> | github-activate'); process.exit(2);
}
