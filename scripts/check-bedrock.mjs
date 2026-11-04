// One bounded, METERED Bedrock inference through the real application code path. Never runs without --confirm-metered.
//
//   node --env-file=services/chat/.env   scripts/check-bedrock.mjs CHAT   --confirm-metered
//   node --env-file=services/engine/.env scripts/check-bedrock.mjs REVIEW --confirm-metered [--evidence path/to/evidence.json]
//
// CHAT   → the chat service's LlmRuleInterpreter (real prompt + Zod proposal schema).
// REVIEW → the engine's CompatibleReviewer + validateScore (real prompt + rubric/evidence-reference validation).
//          Default evidence: scripts/fixtures/bedrock-review-evidence.json, a SYNTHETIC but schema-valid PR (it is not a
//          real repository; a PASS proves model access and output-schema compatibility, not review quality on real code).
//          Pass --evidence with a document collected from a real PR to test that.
// Output: one JSON line. Never prints the token or provider error bodies; only the HTTP status and AWS error type name.
// Requires a build: npm run build.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const kind = args[0];
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const out = (o) => { console.log(JSON.stringify(o)); };

if (kind !== 'CHAT' && kind !== 'REVIEW') { out({ status: 'USAGE', message: 'node scripts/check-bedrock.mjs CHAT|REVIEW --confirm-metered [--evidence file]' }); process.exit(2); }
for (const f of ['services/engine/dist/src/bedrock.js', 'services/chat/dist/rules/interpreter.js']) {
  if (!existsSync(resolve(root, f))) { out({ kind, status: 'NOT_RUN', reason: 'build missing: run npm run build' }); process.exit(2); }
}
const { bedrockConfig } = await import(resolve(root, 'services/engine/dist/src/bedrock.js'));

let config;
try { config = bedrockConfig({ ...process.env, BEDROCK_MAX_OUTPUT_TOKENS: kind === 'CHAT' ? '512' : '1500' }, kind); }
catch { out({ kind, status: 'NOT_CONFIGURED', reason: `LLM_PROVIDER=bedrock requires AWS_REGION, AWS_BEARER_TOKEN_BEDROCK and BEDROCK_${kind}_MODEL_ID` }); process.exit(1); }
if (!config) { out({ kind, status: 'NOT_CONFIGURED', reason: 'LLM_PROVIDER is not "bedrock" in this environment' }); process.exit(1); }
const region = process.env.AWS_REGION;

let evidence = null;
if (kind === 'REVIEW') {
  const file = opt('--evidence') ?? resolve(root, 'scripts/fixtures/bedrock-review-evidence.json');
  if (!existsSync(file)) { out({ kind, status: 'NOT_RUN', reason: 'evidence fixture not found (this is not a model outage)' }); process.exit(2); }
  const { evidenceSchema } = await import(resolve(root, 'services/engine/dist/src/bounty/schemas.js'));
  const parsed = evidenceSchema.safeParse({ ...JSON.parse(readFileSync(file, 'utf8')), collectedAt: new Date().toISOString() });
  if (!parsed.success) { out({ kind, status: 'NOT_RUN', reason: 'evidence file does not match the engine evidence schema (this is not a model outage)' }); process.exit(2); }
  evidence = parsed.data;
}

if (!args.includes('--confirm-metered')) {
  out({ kind, model: config.model, region, status: 'NOT_RUN', reason: 'this makes one metered Bedrock call; re-run with --confirm-metered after approving the cost' });
  process.exit(0);
}

// Record the Bedrock HTTP status and AWS error *type* (never the body) as the adapter discards both.
const seen = { status: null, errorType: null, network: null };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  try {
    const res = await nativeFetch(input, init);
    if (u.includes('bedrock-runtime.')) { seen.status = res.status; seen.errorType = (res.headers.get('x-amzn-errortype') ?? '').split(':')[0] || null; }
    return res;
  } catch (err) {
    if (u.includes('bedrock-runtime.')) seen.network = err?.cause?.code ?? err?.code ?? 'NETWORK_ERROR';
    throw err;
  }
};
function classify() {
  if (seen.network) return /ENOTFOUND|EAI_AGAIN/.test(seen.network) ? 'INCORRECT_REGION_OR_DNS' : 'NETWORK';
  const t = seen.errorType ?? '';
  if (seen.status === 401 || t === 'UnrecognizedClientException') return 'AUTHENTICATION (key invalid or expired)';
  if (seen.status === 403 || t === 'AccessDeniedException') return 'ACCESS_DENIED (Bedrock returns 403 for an invalid or expired API key as well as for missing bedrock:InvokeModel permission or model access; check the key first)';
  if (seen.status === 404 || t === 'ResourceNotFoundException') return 'MODEL_NOT_FOUND (wrong model/inference-profile ID, or not offered in this region)';
  if (seen.status === 400 || t === 'ValidationException') return 'VALIDATION (often an invalid model ID, or a model that needs an inference profile ID)';
  if (seen.status === 429 || /Throttling|ServiceQuota/.test(t)) return 'THROTTLING_OR_QUOTA';
  if (seen.status && seen.status >= 500) return 'PROVIDER_ERROR';
  return 'UNKNOWN';
}
const base = { kind, model: config.model, region };
try {
  if (kind === 'CHAT') {
    const { LlmRuleInterpreter } = await import(resolve(root, 'services/chat/dist/rules/interpreter.js'));
    const proposal = await new LlmRuleInterpreter({ ...config, timeoutMs: 60000 }).interpret('When a reward-ready PR is merged in UserAkku/buyoncue, send a 50 INR Flipkart gift card within the spending limits I confirm.');
    if (seen.status !== 200) { out({ ...base, status: 'BLOCKED', httpStatus: seen.status, awsErrorType: seen.errorType, class: classify() }); process.exit(1); }
    const ok = proposal.intent === 'create_rule' && proposal.repository?.toLowerCase() === 'userakku/buyoncue' && proposal.requiredLabel === 'reward-ready';
    out({ ...base, status: ok ? 'PASS' : 'FAIL', class: ok ? 'OK' : 'APPLICATION_PARSE (model answered; proposal did not match the expected rule)', output: proposal, path: 'LlmRuleInterpreter' });
    process.exitCode = ok ? 0 : 1;
  } else {
    const { CompatibleReviewer } = await import(resolve(root, 'services/engine/dist/src/bounty/reviewer.js'));
    const { validateScore } = await import(resolve(root, 'services/engine/dist/src/bounty/policy.js'));
    const tiers = [{ minScore: 50, maxScore: 69, faceValueINR: 50, productId: 'fixture', packageId: 'fixture-50', requiresApproval: false, enabled: true }, { minScore: 70, maxScore: 84, faceValueINR: 100, productId: 'fixture', packageId: 'fixture-100', requiresApproval: false, enabled: true }, { minScore: 85, maxScore: 100, faceValueINR: 200, productId: 'fixture', packageId: 'fixture-200', requiresApproval: true, enabled: true }];
    const reviewer = new CompatibleReviewer(config.model, config.apiKey, config.baseUrl, config.fetchImpl);
    let raw;
    try { raw = await reviewer.review(evidence, tiers, { maintainerGithubUserId: evidence.maintainerAuthorization?.actorGithubUserId ?? 101 }); }
    catch { out({ ...base, status: 'BLOCKED', httpStatus: seen.status, awsErrorType: seen.errorType, class: seen.status === 200 ? 'APPLICATION_PARSE (model answered but not with JSON)' : classify() }); process.exit(1); }
    try {
      const score = validateScore(raw, evidence, evidence.maintainerAuthorization?.actorGithubUserId);
      out({ ...base, status: 'PASS', class: 'OK', path: 'CompatibleReviewer + validateScore', totalScore: score.totalScore, subscores: score.subscores, confidence: score.confidence, riskFlags: score.riskFlags, findings: score.findings.length });
    } catch (err) {
      out({ ...base, status: 'FAIL', class: 'APPLICATION_PARSE (model answered; output failed the engine rubric/evidence validation)', reason: String(err?.code ?? err?.message ?? 'invalid').slice(0, 80) });
      process.exitCode = 1;
    }
  }
} catch {
  out({ ...base, status: 'BLOCKED', httpStatus: seen.status, awsErrorType: seen.errorType, class: classify() });
  process.exitCode = 1;
}
