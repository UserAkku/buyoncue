# Final AI integration validation — blocked release candidate

Date: 4 November 2026 (Asia/Kolkata). Branch: `integration/final-ai-validation`.

**Overall: BLOCKED. This is a draft integration candidate, not a verified real-AI bounty release.** All preserved tests pass, but real Bedrock output was not obtained and the new GitHub App/chat bounty contract is incompatible with the engine. No real Bitrefill payment was made and live purchasing remained false.

## Source integration

Fetched every remote branch and merged, without conflicts or overwriting original branches:

- Tested integration baseline: `5d8ac5e1d4e8890c3678f14de44e435f4493c703`.
- AI bounty engine: `9f1cf98b7e961fd44f6c607e95bc87bd4c544d10`.
- GitHub App/Telegram: `589b7f726ea07e0df6a9c5e6e3ff5b9a029965d1`.

There were no Bedrock implementation commits in any fetched branch. The updated local environments did contain Bedrock credentials/model settings. Added bearer-authenticated Bedrock Converse transport adapters to both services and wired them into the existing real interpreter/reviewer interfaces, preserving the OpenAI-compatible fallback. Added input/output bounds, a durable per-policy/PR review-attempt limit and private-key-file support using `GITHUB_APP_PRIVATE_KEY_PATH`. Actual `.env` values were reloaded, not overwritten or committed.

## Results

| Subsystem/check | Verdict | Evidence and limit |
| --- | --- | --- |
| Original 135-test baseline | PASS | All original 60 engine + 36 chat + 39 integration cases remain included |
| Final engine suite | PASS | 130 tests: original engine, AI bounty, Bedrock transport and review-budget cases |
| Final chat suite | PASS | 87 tests, including GitHub App regressions |
| Final HTTP integration suite | PASS | 40 tests: original 39 plus safe rejection of the incompatible new chat request |
| Total automated tests | PASS | **257 passed, 0 failed** |
| Typechecks/builds | PASS | Both service projects and integration typecheck; both production builds |
| PostgreSQL migrations | PASS | Isolated local PostgreSQL and the database configured in the updated engine `.env`; no database was reset |
| Both compiled services start/connect | PASS | Engine and chat ran together; authenticated real EngineClient request using chat `.env` succeeded against configured database |
| Telegram transport | PASS | Compiled bot entered polling as `buyoncueBot`; owner is unset, so setup-only mode |
| Natural-language rule through real Bedrock Haiku | BLOCKED | Initial real call returned HTTP 429; after reloading updated local env, the actual application interpreter still produced no verified structured result |
| Real Bedrock Sonnet review | BLOCKED | Real calls using initial and updated local engine env returned HTTP 403; no model-generated review verified |
| Authenticated GitHub API read | PASS | Actual engine PR #5 files fetched with authenticated GitHub CLI; this is not proof of GitHub App/OAuth authorization |
| GitHub App authorization and live evidence | BLOCKED | GitHub App credentials are not configured in local chat environment |
| New GitHub App/chat → engine bounty API | FAIL | Actual EngineClient `linkGithub` request is rejected by engine with HTTP 400; schema mismatch confirmed in real HTTP regression |
| Score → approved tier | PASS with fakes | Engine deterministic mapper, exact package checks and rubric validation pass; real Bedrock-derived score mapping NOT TESTED |
| Open/updated PR cannot pay | PASS with fixtures | Engine review/final-SHA/merged gates covered; no payment without final eligibility |
| Authorized merged PR → purchasing executor | PASS with fixtures | Canonical engine HTTP path and fake external transports pass; new App/UI end-to-end path remains blocked |
| Duplicate events, caps and owner approvals | PASS | Existing and new PostgreSQL concurrency/regression coverage preserved |
| Fake Bitrefill E2E | PASS | Existing signed-webhook baseline and canonical bounty engine flow pass with fake models/payments |
| Real Bedrock → fake payment complete E2E | NOT TESTED | No verified real model output; do not substitute a mock result as evidence |
| Real-money purchase/private reward | MANUAL | Not executed; requires corrected integration, credentials and explicit owner spend authorization |
| Live purchasing safety | PASS | Environment and running engine health confirmed `livePurchasesEnabled:false`; automated tests explicitly set false |

The rejection regression is an expected safety test, not a claim that the new bounty UI works. The previously passing suites tested that UI against its own mock contract. This release review does not treat those mock results as cross-service compatibility.

## Real model configuration and attempts

These are the exact **configured IDs**, not a claim of verified model availability:

| Purpose | Region | Configured model | Real result |
| --- | --- | --- | --- |
| Chat parser | `ap-south-1` | `global.anthropic.claude-haiku-5-5` | Initial HTTP 429; updated-env application-interpreter attempt did not return a validated proposal |
| Contribution reviewer | `ap-south-1` | `global.anthropic.claude-sonnet-5-5` | HTTP 403, including after local env reload |

Each probe was bounded to 512 output tokens. Sonnet's probe used actual PR diff excerpts and explicitly prohibited invented CI/approval evidence; no successful actual code/CI/review analysis is claimed. The reusable probe now selects source-file excerpts for future authorized attempts. Bedrock requests used the configured bearer token and AWS Converse endpoint, following [AWS's API-key documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html). Tokens, database URLs, provider error bodies and private keys were not printed. Failed requests were not retried in a loop. The updated-env retry was explicitly requested by the owner.

HTTP 429/403 does not establish that billing, permissions, inference-profile access or configured IDs are correct. The owner must confirm these in AWS. No alternate model was silently substituted. Model-mocked tests prove transport/policy behavior only.

## Confirmed integration gap

The new chat client uses an assumed legacy bounty contract (`docs/BOUNTY_ENGINE_CONTRACT.md`), whereas the engine implements `services/engine/BOUNTY_API.md`:

- GitHub IDs as strings, extra `chatId`, and absent OAuth verification fields versus required numeric IDs, `verificationSource`, `verifiedAt`.
- Repository owner/name fields and query parameter names differ.
- Bounty tier bodies omit exact face value, maximum score bands and mandatory policy fields.
- Review/evidence envelopes and response states differ.
- Finalization body and enable/action routes differ.
- Collector lacks the engine's explicit same-head maintainer-authorization attestation.

The engine remains fail-closed rather than inventing missing authorization, CI completeness, private-source consent or identity proof. Contract reconciliation and new App → canonical engine E2E testing remain required. There is no claim that this draft is ready to merge or that the complete requested live workflow has been achieved.

## Exact validation commands

```sh
# Git transport workaround used because saved HTTPS rewrites forced failing SSH:
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
 git -c 'credential.helper=!gh auth git-credential' fetch \
 https://github.com/UserAkku/buyoncue.git '+refs/heads/*:refs/remotes/origin/*'
git switch -c integration/final-ai-validation origin/integration/baseline-verification
git merge --no-edit origin/feat/ai-bounty-engine
git merge --no-edit origin/feat/github-telegram-link
npm --prefix services/chat ci --cache /tmp/pactpilot-npm-cache --no-audit --no-fund

# Isolated tests, no configured external database reset:
pg_ctl -D /tmp/pactpilot-engine-pg -l /tmp/pactpilot-engine-pg.log \
 -o '-p 55439 -h 127.0.0.1 -k /tmp' start
LIVE_PURCHASES_ENABLED=false \
 TEST_DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm test
npm run typecheck
npm run build

# Apply transactional additive migrations using updated local engine env:
cd services/engine && npm run migrate
# Empty queues were verified read-only before starting workers.
PORT=31989 LIVE_PURCHASES_ENABLED=false npm start
# Other terminal, chat .env automatically loaded:
cd services/chat
PORT=31990 ENGINE_URL=http://127.0.0.1:31989 npm start

# From root, explicitly authorized real Bedrock probes:
gh api repos/UserAkku/buyoncue/pulls/5/files \
 --jq '[.[]|{filename,status,patch}]' > /tmp/buyoncue-real-pr-files.json
node --env-file=services/chat/.env scripts/check-bedrock.mjs CHAT
node --env-file=services/engine/.env scripts/check-bedrock.mjs REVIEW
```

Final automated logs: `/tmp/final-ai-tests.log`, `/tmp/final-ai-build.log`. Real probe records: `/tmp/bedrock-chat-check.json`, `/tmp/bedrock-review-check.json`, `/tmp/bedrock-chat-check-updated.json`, `/tmp/bedrock-review-check-updated.json`. These are local artifacts, not credentials. Final tests/typechecks/builds ran after the last code/test modification. Temporary service listeners and isolated PostgreSQL are stopped after verification; the configured database is retained.

## Required owner/manual actions and remaining work

1. AWS owner: confirm the configured model/inference-profile IDs exist and are accessible in the configured region; verify bearer-token validity/region, model invocation permissions and quota/billing. Resolve Haiku throttling/rejection and Sonnet access rejection before an explicitly authorized retry. Do not paste tokens into PRs or logs.
2. Reconcile the new chat adapter and evidence collector with the canonical engine contract; add a complete GitHub App → real engine test with independently verified maintainer, CI, identity, visibility and final SHA attestations. Current mock contracts must not be treated as compatibility evidence.
3. Configure actual GitHub App ID/client/secret/installation/callback/webhook settings and `GITHUB_APP_PRIVATE_KEY_PATH`; provide a valid local PEM file. Confirm genuine server-side OAuth/repository access and signed events.
4. Owner and contributor start the bot privately. Configure `TELEGRAM_OWNER_USER_ID` and the engine's pre-linked recipient gate. Owner is currently unset; no live natural-language Telegram interaction was demonstrated.
5. Once AWS access is corrected, run the actual Haiku interpreter and Sonnet reviewer on genuine current PR/CI/review evidence. Validate structured outputs and hold behavior; then run that real-AI result through fake payment and private-transport E2E before considering real money.
6. Configure funded Bitrefill credentials and exact available INR packages. Obtain explicit owner authorization, review caps/tiers/approvals, and prepare exactly one qualifying merged event before intentionally enabling any real purchase. Record real invoice, individual delivered order and private recipient confirmation. No real payment is authorized or executed by this validation.

The release remains BLOCKED until those conditions are satisfied. This report distinguishes passing local regressions from unavailable real AI and confirmed integration defects.
