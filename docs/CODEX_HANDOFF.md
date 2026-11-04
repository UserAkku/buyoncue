# Codex → Claude Code handoff

Handoff date: 4 November 2026. Development stopped at the owner's request; this is **not a release declaration**.

## Git preservation

- Current/pushed branch: `integration/final-ai-validation`.
- Latest commit before preserving working changes: `73c097c` (merge of GitHub App/Telegram branch).
- The implementation preservation commit and subsequent documentation commit are in this branch's history. Resolve the final tip with `git rev-parse integration/final-ai-validation`; a document cannot embed its own final commit SHA.
- Target for draft PR: `integration/baseline-verification`.
- PR URL: pending creation immediately after the preservation commit; this document will be updated with the actual URL.
- Integrated sources: baseline `5d8ac5e1d4e8890c3678f14de44e435f4493c703` (PR #3), AI engine `9f1cf98b7e961fd44f6c607e95bc87bd4c544d10` (PR #5), GitHub/Telegram `589b7f726ea07e0df6a9c5e6e3ff5b9a029965d1` (PR #4).
- Merges were conflict-free. Original services and feature branches remain intact. No reset, clean, rebase, force-push or main merge was performed.

## Completed

- Combined the existing integration, AI bounty and GitHub App/Telegram branches.
- Preserved the original 135-test baseline and every feature regression.
- Added bearer-authenticated Bedrock Converse adapters in both services, connected to the existing interpreter/reviewer interfaces. OpenAI-compatible fallback remains.
- Added model input/output bounds, durable per-policy/PR review-attempt limit, and tests for transport failure, secret suppression and inference limits.
- Added `GITHUB_APP_PRIVATE_KEY_PATH` support: read actual PEM contents, reject conflicting inline/path settings, retain existing inline-key compatibility.
- Verified additive PostgreSQL migrations on isolated PostgreSQL and on the database configured in the updated engine `.env`. No database was reset.
- Started both compiled services using updated local environments, verified an authenticated chat-client request against the running engine/configured database, and observed Telegram polling as `buyoncueBot`.
- Confirmed live purchases false. No real Bitrefill purchase occurred.

## Partial / blocked / unimplemented

- Real Bedrock calls were attempted, but **no successful real model output was verified**. Initial Haiku call returned HTTP 429. After owner requested updated env reload, actual application-interpreter attempt still did not yield a validated proposal. Sonnet returned HTTP 403 before and after env reload. Do not claim mock outputs prove real inference.
- Exact configured models: `global.anthropic.claude-haiku-5-5` (chat), `global.anthropic.claude-sonnet-5-5` (engine), region `ap-south-1`. These IDs are configuration, not verified availability/access.
- New GitHub App/chat bounty request/response contract **does not match** the canonical engine contract. Actual EngineClient identity-link request receives HTTP 400. A negative real-HTTP regression proves safe rejection; it is not an end-to-end success.
- No canonical chat adapter, revocation/unlink bridge, or complete new App → engine bounty E2E was implemented. Possible approaches were considered only; there are no hidden unfinished implementation files for these.
- Real App OAuth/installation evidence is unverified; local App credentials and Telegram owner ID were absent during startup.
- Full real Haiku → real Sonnet → fake Bitrefill E2E is NOT TESTED. Real-money purchase/delivery is NOT EXECUTED.

## Last test/build evidence

After the last code/test modification:

- Engine: **130 passed**.
- Chat: **87 passed**.
- Integration: **40 passed** (39 original + one expected contract-rejection regression).
- Total: **257 passed, 0 failed**.
- Root `npm run typecheck` and `npm run build`: PASS for both services and integration typecheck.
- No known TypeScript/build error remains. Known runtime failures: Bedrock 429/403/unvalidated parse and incompatible new bounty API HTTP 400.
- Earlier review-attempt-guard edit temporarily broke final-SHA handling; fixed, and both original regressions pass. Do not restore that faulty intermediate edit.

Commands:

```sh
LIVE_PURCHASES_ENABLED=false TEST_DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm test
npm run typecheck
npm run build
cd services/engine && npm run migrate
# Actual configured-database startup used alternate local ports:
PORT=31989 LIVE_PURCHASES_ENABLED=false npm start
cd services/chat
PORT=31990 ENGINE_URL=http://127.0.0.1:31989 npm start
# Real probes; do not loop retries while access/quota is unresolved:
node --env-file=services/chat/.env scripts/check-bedrock.mjs CHAT
node --env-file=services/engine/.env scripts/check-bedrock.mjs REVIEW
```

Probe requires the actual PR-files fixture: `gh api repos/UserAkku/buyoncue/pulls/5/files --jq '[.[]|{filename,status,patch}]' > /tmp/buyoncue-real-pr-files.json`.

Local evidence logs: `/tmp/final-ai-tests.log`, `/tmp/final-ai-build.log`, `/tmp/bedrock-chat-check.json`, `/tmp/bedrock-review-check.json`, `/tmp/bedrock-chat-check-updated.json`, `/tmp/bedrock-review-check-updated.json`. Logs are not committed. Temporary service listeners were stopped; the configured database and local env files are retained. Isolated PostgreSQL may still be running on port 55439.

## Files and migrations

New handoff work: `docs/FINAL_AI_INTEGRATION.md`, this document, `scripts/check-bedrock.mjs`, `services/chat/src/bedrock.ts`, `services/engine/src/bedrock.ts`, `services/engine/test/bedrock.test.ts`.

Modified handoff work: both service `.env.example` files, chat `src/config.ts`, engine `src/config.ts`, `src/server.ts`, `src/bounty/service.ts`, `test/bounty.test.ts`, and `tests/integration/baseline.test.ts`.

Merged migrations: `services/engine/migrations/001_initial.sql` and `002_ai_bounties.sql`. No new migration was added during this final validation phase.

## Environments and external prerequisites

Use the existing, updated, ignored local service `.env` files. Never copy their values into docs, commits or PRs.

- Shared: matching `INTERNAL_API_TOKEN`.
- Engine: `DATABASE_URL`, `REDEMPTION_ENCRYPTION_KEY`, `BITREFILL_API_KEY`, `BITREFILL_BASE_URL`, `PUBLIC_ENGINE_URL`, `AUTHORIZED_RECIPIENT_CHAT_ID` for live mode, `LIVE_PURCHASES_ENABLED=false`, `PORT`.
- Bedrock: `LLM_PROVIDER=bedrock`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`; chat `BEDROCK_CHAT_MODEL_ID`, engine `BEDROCK_REVIEW_MODEL_ID`; `BEDROCK_MAX_OUTPUT_TOKENS`, `BEDROCK_MAX_INPUT_CHARS`, engine `LLM_REVIEW_MAX_CALLS_PER_PR`.
- Optional existing compatible provider: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.
- Chat: Telegram token/owner, `ENGINE_URL`, GitHub App ID/client/secret/private-key path, webhook secret, callback/install/public-chat URLs. Never treat a PEM pathname as PEM contents.
- Runtime model access/billing/quota must be provisioned independently of Codex/Claude subscriptions.

## Claude's exact next tasks

1. Read `docs/FINAL_AI_INTEGRATION.md`, engine `BOUNTY_API.md` and chat `docs/BOUNTY_ENGINE_CONTRACT.md`.
2. Reconcile the chat client, collector and pipeline with the canonical engine request/response schemas. Preserve numeric identities, same-head maintainer proof, complete required CI, private-source consent and merged-final review. Do not invent missing attestations to make tests pass. Include unlink/repository revocation safety before enabling the new App path.
3. Add a complete new GitHub App/collector → actual engine HTTP → fake payment → private notification E2E. Keep the old tests and negative contract test updated to assert the corrected desired behavior when implemented.
4. AWS owner must resolve configured model/inference-profile access, token/region validity, permissions and quota. Obtain successful tiny real Haiku and Sonnet outputs, with real application schemas and actual PR/CI/review evidence. Do not substitute another model silently or claim mocks as real proof.
5. Configure genuine GitHub App/OAuth/installation and Telegram owner/contributor identities. Real App path is currently not externally verified.
6. Re-run all tests, typechecks, builds and safe E2E after changes; update release verdicts. Keep the PR draft until blockers are resolved.
7. Only after explicit owner authorization and funded Bitrefill configuration may one controlled real purchase be attempted; record the real invoice, individual delivered order and private recipient receipt. Never blindly retry uncertain payment.

**LIVE_PURCHASES_ENABLED=false. SECRETS MUST NOT BE COMMITTED. LIVE BITREFILL PAYMENT EXECUTED: NO.**
