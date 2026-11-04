// The setup helper must never echo its arguments or leave a value on disk outside the .env files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../../scripts/env-setup.mjs');
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'buyoncue-setup-'));
  mkdirSync(join(root, 'services/chat'), { recursive: true });
  mkdirSync(join(root, 'services/engine'), { recursive: true });
  return root;
}
const run = (root: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...process.env, BUYONCUE_SETUP_ROOT: root, BUYONCUE_KEY_DIR: join(root, 'keys') }, input, encoding: 'utf8' });

test('a secret typed as the variable name is refused and never echoed', () => {
  const root = sandbox();
  const fake = '1234567890:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake123';
  const r = run(root, ['set', 'chat', fake]);
  assert.equal(r.status, 2);
  assert.ok(!(r.stdout + r.stderr).includes(fake), 'the secret appeared in output');
  assert.match(r.stdout, /SECRET VALUE/);
  const r2 = run(root, ['set', 'chat', 'SOME=thing:withcolon']);
  assert.ok(!(r2.stdout + r2.stderr).includes('thing'));
});

test('a value read from stdin is validated, saved with mode 600 and never printed', () => {
  const root = sandbox();
  const token = '1234567890:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake123';
  const r = run(root, ['set', 'chat', 'TELEGRAM_BOT_TOKEN'], token);
  assert.equal(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(token));
  assert.ok(readFileSync(join(root, 'services/chat/.env'), 'utf8').includes(`TELEGRAM_BOT_TOKEN=${token}`));
  assert.equal(statSync(join(root, 'services/chat/.env')).mode & 0o777, 0o600);
  const again = run(root, ['set', 'chat', 'TELEGRAM_BOT_TOKEN'], 'something-else-entirely-1234567890:AAFAKE');
  assert.equal(again.status, 1); // already set: refuses to overwrite without --replace
  assert.match(again.stdout, /already set/);
});

test('repair keeps the last duplicate (the value dotenv uses), is idempotent and adds no secrets', () => {
  const root = sandbox();
  writeFileSync(join(root, 'services/chat/.env'), 'INTERNAL_API_TOKEN=first\nINTERNAL_API_TOKEN=second\n');
  writeFileSync(join(root, 'services/engine/.env'), 'INTERNAL_API_TOKEN=second\nREDEMPTION_ENCRYPTION_KEY=k1\nREDEMPTION_ENCRYPTION_KEY=k2\n');
  run(root, ['repair']);
  const once = readFileSync(join(root, 'services/engine/.env'), 'utf8');
  assert.equal((once.match(/REDEMPTION_ENCRYPTION_KEY=/g) ?? []).length, 1);
  assert.ok(once.includes('REDEMPTION_ENCRYPTION_KEY=k2'));
  assert.ok(once.includes('LIVE_PURCHASES_ENABLED=false'));
  run(root, ['repair']);
  assert.equal(readFileSync(join(root, 'services/engine/.env'), 'utf8'), once);
  assert.ok(readFileSync(join(root, 'services/chat/.env'), 'utf8').includes('INTERNAL_API_TOKEN=second'));
  assert.ok(!readFileSync(join(root, 'services/chat/.env'), 'utf8').includes('first'));
});

test('the GitHub App group is never activated while incomplete', () => {
  const root = sandbox();
  run(root, ['repair']);
  const r = run(root, ['github-activate']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Still missing/);
  assert.ok(!/GITHUB_APP_ID/.test(readFileSync(join(root, 'services/chat/.env'), 'utf8')));
});

// Real terminals wrap pasted text in ESC[200~ ... ESC[201~. That must never end up inside the saved value.
const hasPython = spawnSync('python3', ['--version']).status === 0;
for (const mode of ['bracketed', 'plain', 'trailing-space']) {
  test(`hidden prompt accepts a ${mode} paste through a real pseudo-terminal`, { skip: !hasPython }, () => {
    const root = sandbox();
    const fake = '1234567890:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake123';
    const r = spawnSync('python3', [resolve(import.meta.dirname, 'pty-paste.py'), root, fake, mode], { encoding: 'utf8', cwd: resolve(import.meta.dirname, '../..') });
    assert.ok(!r.stdout.includes(fake), 'token echoed');
    assert.match(r.stdout, /saved in services\/chat\/\.env/);
    assert.ok(readFileSync(join(root, 'services/chat/.env'), 'utf8').split('\n').includes(`TELEGRAM_BOT_TOKEN=${fake}`));
  });
}
