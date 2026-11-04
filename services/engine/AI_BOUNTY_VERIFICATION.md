# AI bounty engine verification

Implemented on `feat/ai-bounty-engine` from the tested `integration/baseline-verification` commit `5d8ac5e1d4e8890c3678f14de44e435f4493c703`. Only `services/engine/**` is changed. The original engine/chat implementations and fixed-reward workflow are preserved.

## Final verification

| Check | Result |
| --- | --- |
| Engine suite | **126 passed**: all 60 prior tests plus 66 new AI/bounty/HTTP/PostgreSQL tests |
| Existing full baseline integration | **39 passed**, unchanged real chat HTTP client / engine / PostgreSQL suite |
| Existing chat unit suite | **36 passed**, no chat source edits |
| Total regression coverage run | **201 passed, 0 failed** |
| Typecheck | PASS for engine, chat and existing integration test project |
| Build | PASS for both existing production services |
| Compatible migration | PASS: additive `002_ai_bounties.sql`; old migration checksum preserved; repeated migration application tested in isolated schemas |
| Compiled engine startup and HTTP smoke | PASS: live flag false; new repository/rule routes, review-not-found, bearer rejection and validation |
| New real HTTP bounty path | PASS with fake GitHub evidence, fake LLM and fake Bitrefill: link → connect → draft policy → enable → review → final merged SHA → tier selection → existing ledger/invoice/payment/order checks → encrypted private outbox → receipt/ACK |
| Secrets/scope | Local `.env` stays ignored, owner-readable only; chat environment not edited; source diff restricted to engine |
| Live inference/provider billing/quota | **BLOCKED**: no runtime model credentials configured |
| Live Bitrefill purchase | **NOT EXECUTED**: no API key/funded purchase authorization; live flag remains false |
| Genuine OAuth/App/Telegram bounty workflow | **NOT VERIFIED** here: adapter/UI is independently owned by Claude |

Final combined commands (repository root), after the last code change:

```sh
LIVE_PURCHASES_ENABLED=false \
TEST_DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm test
npm run typecheck
npm run build
```

Full local output: `/tmp/buyoncue-bounty-final-validation.log`. These commands execute trusted service tests; no contributed PR code or AI-proposed command is executed.

The standalone migration and startup smoke used only the disposable local database:

```sh
cd services/engine
DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm run migrate
DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test \
  PORT=31989 LIVE_PURCHASES_ENABLED=false npm start
```

No source fixtures or tests call a paid Bitrefill endpoint or a real inference provider. Purchasing engines remain in test mode; fake invoice IDs visibly start with `TEST-MOCK-` or `test:`. The model transport test replaces `fetch` and verifies the untrusted-data boundary, redaction and absence of product/amount authority in the prompt. The inherited historical live-payment fixture is read-only reconciliation with live spending disabled.

## New API surface

- `POST /v1/github/links`
- `POST /v1/repositories/connect`
- `GET /v1/repositories?ownerTelegramUserId=...`
- `POST /v1/bounty-rules`
- `GET /v1/bounty-rules?ownerTelegramUserId=...`
- `POST /v1/contributions/review`
- `GET /v1/contributions/:reviewId`
- `POST /v1/contributions/:reviewId/finalize`
- `GET /v1/bounty-receipts/:purchaseId`

Enable/pause/resume, owner approvals, purchases and notifications reuse the existing routes. Exact bodies, nested typed schemas, response shapes, state/reason vocabulary and trust boundary are in [BOUNTY_API.md](BOUNTY_API.md) and `src/bounty/schemas.ts`.

## Required safety cases exercised

| Area | Regression evidence |
| --- | --- |
| Deterministic tiers | Boundary scores 0, 49, 50, 69, 70, 84, 85, 100; floor 50; overlaps/caps rejected; advisory tier cannot choose product/amount |
| Unsupported/trivial high scores | Whitespace-only and model-declared non-substantial changes cannot support reward scores; invalid sum/citations/extra financial fields hold |
| Low confidence / invalid / unavailable model | LOW_CONFIDENCE or NEEDS_REVIEW, no purchase; critical/manual-review risks hold |
| CI | Absent, pending, failed and wrong-SHA required checks never count as success |
| Final merge | Open PR review allowed; fresh merged review and final re-fetch required; changed head makes STALE; old or in-flight superseded review cannot revive |
| Durable jobs/events | Queued reviews, held merge events and pending/uncertain purchases survive service reconstruction; held event can be explicitly retried after verified identity linking |
| Identity/installation | Unknown/unapproved numeric identity/repository/installation holds/rejects; conflicting ownership and concurrent takeover attempts reject; login changes preserve numeric ownership |
| Maintainer signal | Missing signal, author-applied label, wrong-SHA authorization, absent required label or unsupported review attestation cannot buy |
| Self / bot | Self reward denied by default; explicit permission works only with owner pre-linked; bot authors blocked |
| Duplicate / concurrent rewards | Repeated delivery, different delivery IDs and concurrent finalizations create one award/purchase; all tier selections share the same locked budget ledger |
| Tier verification | Unknown/mismatched packages rejected; out-of-stock selected tier disabled before or after queueing, never substituted |
| Financial policy | Actual USD charge governs caps; forced high-tier owner approval; sufficient authenticated USD balance required; unknown balance currency rejected |
| Uncertain payment | Same original invoice reconciled after restart; no repeated pay or invoice creation; failed paid delivery cannot be recreated by another event |
| Delivery and receipt | Individual-order and exact denomination checks; wrong denomination fails; private contributor receives redemption, owner gets redacted receipt; audit links SHA/author/review/score/tier/version/invoice/order state; ACK erases ciphertext |
| Privacy | Redaction before storage/inference; private-source inference disabled without explicit consent; no raw source or provider exception in notification logs |
| Existing fixed rules | All 60 previous engine tests and all 75 baseline/chat tests pass; fixed trigger cannot execute a bounty template |

## Remaining real-environment prerequisites

1. Claude's trusted OAuth/App adapter must implement the precise handoff. A client-provided `verifiedOwnerAccess` boolean is not GitHub proof. Use server-side authenticated GitHub calls and state-bound Telegram identity. Use `GITHUB_APP_PRIVATE_KEY_PATH` for a PEM **pathname**, read file contents for signing, and keep all GitHub/Telegram credentials in chat `.env`.
2. Supply a persistent engine `DATABASE_URL`, apply migrations, retain the baseline encryption/internal token, and verify the one contributor's private Telegram chat. Configure `AUTHORIZED_RECIPIENT_CHAT_ID` before any live spending.
3. Configure the engine's separate `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`. Confirm supported JSON Chat Completions behavior, provider billing, model access and quota. Codex/Claude subscription payments do not grant runtime BuyOnCue inference credits. No live model quality or cost is claimed by mocked tests.
4. Supply funded Bitrefill Personal API credentials, obtain actual country-IN/INR fixed packages, and confirm USD account currency/balance. Test fixture denominations/IDs are not catalogue evidence.
5. Keep one reviewed policy and one prepared contribution for the demo; pause any overlapping legacy fixed policy unless both rewards are explicitly intended. Collect genuine current CI and maintainer authorization, re-review the final merged head, and verify both HTTPS callback routes.
6. Obtain explicit owner authorization before deliberately enabling live purchases. Observe the one real invoice, actual charge, individual order delivery and private recipient receipt. Never retry an uncertain paid request or present a simulated bounty as real.

Current scope is one immutable version-1 bounty policy per connected repository and one pre-linked live recipient. There is no automatic transfer/edit/rehabilitation of policies/disabled tiers, no automatic recreation of failed awards, and no new financial override endpoint. Quality/identity holds require corrected fresh evidence, not an approval that bypasses policy. Redaction is best effort; private-source use requires owner consent and upstream secret exclusion.
