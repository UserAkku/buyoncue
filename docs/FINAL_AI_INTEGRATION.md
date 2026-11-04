# Final AI bounty integration — status and evidence

Date: 4 November 2026. Branch: `integration/final-ai-bounty-release` (resolve the tip with `git rev-parse HEAD`; a document cannot embed its own commit SHA). Base for the PR: `integration/baseline-verification`.

**Overall: the code path is integrated and verified end to end against the real engine and PostgreSQL with fakes only at the external boundaries. Every live external check is BLOCKED or NOT TESTED because no credentials were available in this environment. No real Bitrefill invoice was created, no real money was spent, and `LIVE_PURCHASES_ENABLED` stayed `false`.**

## Source branches and what was done

| Source | Commit | State |
| --- | --- | --- |
| PR #3 baseline (`integration/baseline-verification`) | `5d8ac5e` | included |
| PR #5 AI bounty engine (`feat/ai-bounty-engine`) | `9f1cf98` | included (already merged by Codex) |
| PR #4 GitHub App / Telegram (`feat/github-telegram-link`) | `589b7f7` | included (already merged by Codex) |
| Codex handoff `integration/final-ai-validation` (PR #6, draft) | `655a15d` | branched from, history preserved, nothing force-pushed or rewritten |

Nothing was merged twice. Codex's handoff identified the blocker; this release fixes it:

1. **Chat ↔ engine contract reconciled (P0).** The chat service had been built against a guessed bounty API. It now speaks the engine's canonical API (`services/engine/BOUNTY_API.md`): numeric GitHub IDs on the wire, `verificationSource`/`verifiedAt`, `ownerTelegramUserId`, exact evidence document, tier bands with INR face values, `/v1/rules/:id/(enable|pause|resume)`, the merged re-review → settle → finalize sequence, receipts. See `docs/BOUNTY_ENGINE_CONTRACT.md` for the mapping.
2. **Evidence collector rewritten** to emit the engine's exact schema: files/patches (bounded, truncation flagged), commits, check runs **and** legacy commit statuses bound to the head SHA, required checks from rulesets (`ciComplete` only when all required contexts were enumerated and reported), reviews with `feedbackResolved` (GraphQL review threads), linked issues, bot/private flags, and a `maintainerAuthorization` bound to the exact head (signed `labeled` webhook from the connected maintainer, or the maintainer's `APPROVED` review of that commit with resolved threads), after verifying write access with GitHub.
3. **Revocation safety.** New engine endpoint `POST /v1/github/links/unlink` (soft revoke, migration `003_identity_revocation.sql`); all authorization lookups ignore revoked links; a revoked maintainer cannot finalize. Repository/installation revocation pauses the rule through the engine's owner-checked route and hard-stops processing locally; the owner is told honestly if the pause couldn't be confirmed. GitHub `github_app_authorization` revocation unlinks in the engine first.
4. **Review-attempt budget (P1).** The engine default of 3 attempts per PR could be exhausted before the mandatory merged re-review; default is now 6 (max 10), and the chat reuses identical recent reviews instead of resubmitting.
5. **Client bug:** HTTP 403 from the engine was reported as "bad token"; only 401 is now.
6. Codex's negative "contract mismatch" regression was replaced by a positive test of the canonical contract.

## Test results (this machine, disposable PostgreSQL 16 on 127.0.0.1:55439)

| Check | Verdict | Evidence |
| --- | --- | --- |
| `npm run typecheck` (engine, chat, integration) | PASS | exit 0 |
| `npm run build` (engine, chat) | PASS | exit 0 |
| Engine unit/integration (Vitest, real PostgreSQL schemas) | PASS | **135 passed** (130 inherited + 5 identity-revocation) |
| Chat (Vitest; mock GitHub + canonical-shaped fake engine) | PASS | **100 passed** (87 inherited, rewritten/extended for the canonical contract) |
| Cross-service HTTP integration (`node:test`) | PASS | **64 passed**: 40 baseline + **24 new AI-bounty E2E** |
| Total | PASS | **299 passed, 0 failed** |
| Migrations 001–003 on a fresh database | PASS | applied twice (idempotent); additive only |
| Compiled engine boot (`node dist/src/server.js`) | PASS | fresh DB; `/health` → `livePurchasesEnabled:false`; 401 without token; authenticated routes answer |
| Compiled chat service boot | NOT TESTED | needs a real Telegram bot token (long polling calls Telegram at startup) |
| Mutation checks | PASS | removing the CI-success rule fails E2E #8; removing the linked-author rule fails #9 and #22 |

### What the 24 new E2E tests drive (`tests/integration/ai-bounty-e2e.test.ts`)

Real: chat controller/feature/pipeline/OAuth routes/webhook server/notification worker → `EngineClient` → **real engine HTTP routes, policy, ledger, state machine and PostgreSQL**. Faked, only at external boundaries: GitHub (local `MockGithub` over HTTP with real Octokit and App-JWT/installation-token flows), the model (a scripted `Reviewer` that builds a *valid* score from the evidence it receives, and scores no tests/feedback when none exist), Telegram (recording sender), Bitrefill (the engine's in-process fake payments; all IDs `TEST-MOCK-…`). `fetch` is hard-blocked for any non-127.0.0.1 host during these tests.

| Requested scenario | Test | Result |
| --- | --- | --- |
| Maintainer links GitHub; contributor links; installation grants repo access | 1–4 | PASS (numeric IDs stored by the engine; repo connected only after GitHub confirmed admin via the installation) |
| Tier verification against catalogue | 4b | PASS (wrong face value rejected, nothing created) |
| PR opened → evidence → AI review → deterministic tier | 5–6 (+ scores 60/75/90 → tiers 1/2/3) | PASS (the model receives the real diff, CI and review evidence; the engine, not the model, picks the tier) |
| Synchronize invalidates old score | 7 | PASS (old review `STALE`, finalize refused) |
| Failed / missing CI blocks payment | 8, 8b | PASS |
| Unlinked contributor blocks payment | 9 | PASS (linking later doesn't buy by itself) |
| Unauthorized repository / installation blocks | 10 | PASS (engine returns 403 for unknown repo, installation mismatch and renamed repo) |
| Unmerged PR never purchases (even if webhook lies) | 11 | PASS |
| Approved merged PR → engine → invoice+payment → individual order delivered → private redemption → owner receipt | 12–17 | PASS (snapshot is exactly tier 1 package for the linked chat; code reaches only the contributor; owner sees invoice reference but never the code; ack only after send) |
| Hard caps / owner approval | 13, 13b | PASS (invoice above cap never paid; tier 3 waits for owner approval; contributor cannot approve) |
| Failed order never "delivered" | 15 | PASS |
| Non-private recipient gets nothing | 16 | PASS |
| Duplicate / replayed deliveries can't buy twice | 18 | PASS (one award, one invoice, one payment) |
| Payment uncertainty never retried | 19 | PASS (one create, one pay across worker ticks; reconciles the original invoice) |
| No live external payment | 20 | PASS (engine health false, only `TEST-MOCK-` invoices, non-local fetch forbidden) |
| Installation revocation / unlink / authorization revoked | 21, 22 | PASS |
| Model outage never invents a score | 23 | PASS |
| Prompt injection in PR text cannot authorize money | 24 | PASS |

## Live external checks (Phase D) — what was actually done

The ignored local env files `services/engine/.env` and `services/chat/.env` are **empty (0 bytes)**, and there are no AWS/Telegram/GitHub/Bitrefill credentials in the process environment. I did not borrow any other credential on this machine.

| Check | Verdict | Detail |
| --- | --- | --- |
| Telegram `getMe`/polling | BLOCKED | `TELEGRAM_BOT_TOKEN` missing (`scripts/check-live.mjs` reports it). Codex's earlier note that the bot polled as `buyoncueBot` is from its session and was not reproduced here. |
| GitHub App auth / installation / OAuth callback / live evidence | BLOCKED | no App private key or client secret. The public page `github.com/apps/buyoncue` answers 200; the unauthenticated REST lookup `/apps/buyoncue` returns 404. Neither proves anything about authentication. |
| Real Bedrock Haiku (chat parser) | BLOCKED | `scripts/check-bedrock.mjs CHAT` → "Bedrock not configured". Codex's earlier live attempt got HTTP 429 (see `docs/CODEX_HANDOFF.md`); it is not claimed as success. |
| Real Bedrock Sonnet (contribution review) | BLOCKED | same; Codex's earlier attempt got HTTP 403. |
| Bitrefill read-only auth/catalogue/balance | BLOCKED | `scripts/check-live.mjs` → Bitrefill credentials missing. |
| Live Bitrefill purchase | NOT EXECUTED | by design; needs explicit owner authorization. |
| Verified real delivery | NOT EXECUTED | depends on the line above. |

Model IDs remain *configuration, not verified availability*: `BEDROCK_REVIEW_MODEL_ID=global.anthropic.claude-sonnet-5-5`, `BEDROCK_CHAT_MODEL_ID=global.anthropic.claude-haiku-5-5`, `AWS_REGION=ap-south-1`. The Bedrock adapters (inherited from Codex) are covered only by fake-`fetch` transport tests (bounded input/output, secret redaction, safe failure). The scripted reviewer in the E2E proves the **pipeline and policy** around a model, not model quality.

## Bounty scoring and policy verification

Rubric 30/25/20/15/10 and tiers (0–49 none, 50–69 T1, 70–84 T2, 85–100 T3 needing owner approval) are enforced by the engine (`src/bounty/{schemas,policy,service}.ts`), not by the model: the score must sum exactly, cite only evidence IDs that exist, cannot award tests/feedback points without completed current-head checks/maintainer review, cannot exceed 50 for trivial diffs, and any critical/low-confidence/invalid output is a HOLD. The selected tier must map to a catalogue-verified INR package and passes the unchanged spend controls (per-purchase/daily/monthly caps, auto-approval threshold, atomic reservation, exact USD charge, balance check, uncertain-payment reconciliation, verified individual-order delivery). None of these were weakened.

## Bitrefill integration status

Unchanged from the validated baseline: two-stage invoice-then-pay with fake provider in tests; live mode gated by `LIVE_PURCHASES_ENABLED` plus a pre-linked recipient. Real read-only calls and any real purchase are **unverified**.

## Remaining real-world setup (manual)

1. AWS: confirm Bedrock model/inference-profile access, region, token and quota; then run `node --env-file=services/chat/.env scripts/check-bedrock.mjs CHAT` and `... services/engine/.env scripts/check-bedrock.mjs REVIEW` (tiny, bounded calls) and review the output.
2. GitHub App: set `GITHUB_APP_*`, `GITHUB_APP_PRIVATE_KEY_PATH` (a PEM *file*), webhook secret and the HTTPS callback/setup URLs (`docs/GITHUB_APP_SETUP.md`). On the demo repo add a **ruleset requiring a status check**, otherwise CI can't be proven complete and rewards are (correctly) held.
3. Telegram: bot token, `TELEGRAM_OWNER_USER_ID`; owner and contributor each `/start` the bot privately. Set the engine's `AUTHORIZED_RECIPIENT_CHAT_ID` to the contributor's private chat ID (the live-MVP recipient gate).
4. Bitrefill: funded Personal API credentials, then `npm run check:live` (read-only).
5. Only with explicit owner authorization: `LIVE_PURCHASES_ENABLED=true`, one qualifying merged PR, small caps. Record the real invoice and the individual delivered order. Never retry an uncertain payment by hand.

## Manual demonstration (no spending)

```sh
# 1. disposable database + engine in TEST mode
createdb buyoncue_demo
cd services/engine && npm ci && DATABASE_URL=postgresql:///buyoncue_demo npm run migrate
LIVE_PURCHASES_ENABLED=false npm start        # prints: mode=test (no real purchases)
# 2. chat service (tunnel for the HTTPS callbacks), then follow docs/BOUNTY_DEMO.md
cd ../chat && npm ci && npm start
```

Without a configured reviewer the engine holds every review as `MODEL_UNAVAILABLE` — that is the correct fail-closed behaviour, not a bug. To demo scoring you need real Bedrock access or the E2E suite:

```sh
LIVE_PURCHASES_ENABLED=false TEST_DATABASE_URL=postgresql://localhost/pactpilot_engine_test npm test
```

## Known limitations and failure modes

* **Nothing live was exercised**: real GitHub OAuth/App behaviour (including ruleset permission for required checks and GraphQL review threads), Telegram, Bedrock output quality/quotas and Bitrefill are unverified. `MockGithub` encodes my reading of GitHub's API.
* A **label applies to one commit**: after every push the maintainer must re-apply it (or approve the new commit). Intentional (a stale label must not authorize new code) but it is UX friction.
* A repo without a **ruleset requiring a status check** can never satisfy `requireSuccessfulCI` (no Administration permission requested).
* Bounty policies are **immutable v1** per repository (engine design); changing one needs a new version/migration.
* A **revoked GitHub identity can only be re-linked by the same Telegram user** (otherwise 409).
* Local chat state (`.data/chat-state.json`) is a single-instance JSON file; delivery de-duplication across restarts depends on it, and the engine's per-PR award identity is the backstop against double payment.
* Forwarded `/linkgithub` links remain a social-engineering risk (FEEDBACK F-18).
* Review attempts per PR are capped by the engine (default 6) to bound model cost; a flood of pushes can exhaust it.
* The compiled chat service was not started here (needs a Telegram token).
