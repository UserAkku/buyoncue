# PactPilot baseline verification

Verified on **4 November 2026 (Asia/Kolkata)**. Verdict: **BASELINE AUTOMATICALLY VERIFIED** with external payment and Telegram transports replaced. **LIVE DEMO NOT VERIFIED**. No real invoice was created, no paid Bitrefill request was sent, and no GitHub PR was merged to trigger spending.

## Commit and branch evidence

- Final tested integration **code** commit: `cebc5df5fbf8763d8cc291cc3bc46cccdeb517eb`.
- Branch: `integration/baseline-verification`, started from current `origin/main` (`d059a9b0e0029f4f264cd1d3cd9a1e96fe674992`).
- Preserved engine commit `4fd54f2e3405bd9bfc490e28149dcd19b34bebc3` and chat commit `3f66352de36ebf95cb98a9e52433b083da68873e` in history; merged the branches without conflicts.
- [PR #1](https://github.com/UserAkku/buyoncue/pull/1) (`feat/chat`) and [PR #2](https://github.com/UserAkku/buyoncue/pull/2) (`feat/engine`) both existed and were open when checked. The reported missing engine PR was a retrieval issue; no duplicate PR was created.
- [Integration PR #3](https://github.com/UserAkku/buyoncue/pull/3) targets `main`. No main or feature-branch history was overwritten or force-pushed.
- This report is added in a documentation-only follow-up to the tested code commit above. The integration PR's head SHA identifies that report commit; `git rev-parse integration/baseline-verification` resolves the final branch tip. There is deliberately no self-referential commit hash embedded in its own file.

## Independently reproduced results

| Check | Result | Evidence |
| --- | --- | --- |
| Original engine unit baseline | PASS | 60 tests before integration fixes |
| Original chat unit baseline | PASS | 34 tests before integration fixes |
| Final engine unit suite | PASS | 60 tests; all purchasing engines use fakes and live flag false |
| Final chat unit suite | PASS | 36 tests, including two reproduced notification regressions |
| Real HTTP integration/E2E | PASS | 39 tests in `tests/integration/baseline.test.ts` |
| Total final tests | PASS | **135 passed, 0 failed, 0 skipped** |
| Both service typechecks + integration typecheck | PASS | Root `npm run typecheck` |
| Both TypeScript production builds | PASS | Root `npm run build` |
| PostgreSQL migration and repeat application | PASS | Real isolated PostgreSQL; unique schemas for test suites; migrations applied twice |
| Simultaneous compiled startup | PASS | Engine on localhost 31987; chat on 31988; shared-token authenticated query succeeded |
| Compiled HTTP health and mode | PASS | `/health`: engine, live disabled; `/healthz`: chat |
| Real Telegram polling startup | PASS | `telegram_polling` logged `buyoncueBot` |
| Temporary public HTTPS | PASS | Cloudflare tunnel health and HMAC-signed GitHub **ping** returned expected JSON |
| Git working tree credential scan | PASS | Local token/key values absent from staged content; `.env` ignored and mode 0600 |

Test environment: macOS arm64, Node.js 22.16.0 for local validation, PostgreSQL installed locally. Use Node 22.12+ with the current test dependencies; Node 20 runtime compatibility was not separately exercised. Lockfile installs succeeded for both services. The temporary database, compiled audit listeners and public tunnel were used only for verification; no production database was reset. Temporary services/tunnel are stopped after the audit.

## Reproduction commands

Run from the repository root unless a directory is shown. Substitute your disposable database URL, not a production database.

```sh
# Repository integration performed once for this audit:
git fetch origin
git switch -c integration/baseline-verification origin/main
git merge --no-edit origin/feat/engine
git merge --no-edit origin/feat/chat

npm --prefix services/engine ci --cache /tmp/pactpilot-npm-cache --no-audit --no-fund
npm --prefix services/chat ci --cache /tmp/pactpilot-npm-cache --no-audit --no-fund

# Audit reused an isolated cluster from the earlier engine verification:
pg_ctl -D /tmp/pactpilot-engine-pg -l /tmp/pactpilot-engine-pg.log \
  -o '-p 55439 -h 127.0.0.1 -k /tmp' start
export TEST_DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test
LIVE_PURCHASES_ENABLED=false npm test
npm run typecheck
npm run build

# Verify the documented migration CLI against that disposable database:
cd services/engine
DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm run migrate
DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test \
  PORT=31987 LIVE_PURCHASES_ENABLED=false npm start

# In another terminal:
cd services/chat
ENGINE_URL=http://127.0.0.1:31987 PORT=31988 npm start

# From repository root; reads ignored environments without displaying secrets:
LIVE_PURCHASES_ENABLED=false npm run check:live
cloudflared tunnel --url http://127.0.0.1:31988 --no-autoupdate
```

For a new machine, initialize your own local PostgreSQL cluster or provision a disposable database first; the `/tmp` cluster path above is specific to this audit. Test suites create isolated random schemas and drop only those schemas. The standalone migration smoke test used the disposable database's public schema.

The final combined validation command was `LIVE_PURCHASES_ENABLED=false TEST_DATABASE_URL=postgresql://pactpilot@127.0.0.1:55439/pactpilot_engine_test npm test && npm run typecheck && npm run build`. It passed **after the last code modification** and a fresh engine lockfile install. The local full output was retained in `/tmp/pactpilot-final-validation.log`; it contains test output, not credentials.

The public HTTPS check fetched `/healthz` and posted a raw-body HMAC-signed `X-GitHub-Event: ping` using the ignored chat secret. It did not submit a pull-request trigger. The temporary URL is intentionally not a permanent deployment URL.

## API contract audit

All required operations were exercised using the real `EngineClient` over TCP, with the real Fastify engine and PostgreSQL, rather than the chat service's bundled mock engine.

| Contract | Verified behavior |
| --- | --- |
| Product search/details | Normalized `id/name/country/currency/inStock/packages`; exact fixture package selected by bot; actual live catalogue blocked by missing key |
| Rule create/list | Exact camelCase fields, integer USD cents; new rule `draft`; explicit enable required |
| Enable/pause/resume | `draft → enabled → paused → enabled`; owner ID checked; private recipient rechecked before enable/resume |
| Repository identity | Engine canonicalizes rule and trigger names to lowercase; `USERAKKU/BUYONCUE` matches the authorized rule |
| GitHub trigger | Signed raw payload reaches actual endpoint; accepted/queued and duplicate reasons parse correctly; title/body absent from stored event |
| Approvals | Real purchase UUID carried by buttons; owner-only decision, expiry and hard caps checked |
| Purchase history/status | Canonical status strings parse; amount is invoice USD cents, distinct from INR face value; codes redacted; recent display uses newest five |
| Notifications | Owner/recipient IDs are strings; invoice/approval IDs survive HTTP; delivery details encrypted, private, and wiped on ACK |
| Notification vocabularies | `purchase_pending_approval`, outcome messages, `test_purchase_delivered`, and owner `purchase_receipt` render; all simulations visibly marked |
| Authentication/errors | Same bearer secret in both service environments; wrong token fails; structured engine errors parse; redirects are refused |
| ACK | Repeated ACK safe; after accepted Telegram send only; failed ACK retries ACK without repeating the send in the running worker |
| Bitrefill webhook | Untrusted hints only; authenticated invoice/order re-fetch; repeated hints cannot duplicate outbox delivery |

The production live configuration now requires `AUTHORIZED_RECIPIENT_CHAT_ID`, the one positive private recipient linked through Telegram. The engine enforces that recipient at create, enable and payment boundaries. The bot authenticates its owner from the actual Telegram sender/private chat and verifies the recipient via authenticated `getChat`. Direct engine callers remain trusted holders of `INTERNAL_API_TOKEN`; that token must not be exposed to end users.

## Full-path evidence and safety boundary

The positive E2E test asserts all of the following:

1. Actual engine and chat HTTP services start with live mode **false** and one shared bearer token.
2. The bot's guided controller searches the catalogue through the actual client, selects the exact Indian fixture product/package, collects recipient and four USD limits, and creates a **draft**.
3. No invoice/payment occurs until explicit owner enablement.
4. The actual GitHub HTTP endpoint verifies HMAC over the raw merged-PR body and forwards only structured trigger fields.
5. A durable event and unique purchase are recorded; repository casing, required label and recipient match.
6. The fake payment adapter receives precisely the approved product/package and returns `TEST-MOCK-invoice-…`, with INR 50 denomination and a separate actual simulated USD 1.25 charge.
7. Budget reservation occurs atomically; the fake payment is called once for that existing invoice.
8. Invoice `complete` plus the independently fetched individual order `delivered` is required.
9. Database invoice/order states and `TEST_DELIVERED` persist; no secret occurs in purchase history or plaintext outbox rows.
10. The authorized private recipient receives the synthetic marker, the distinct owner receives a redacted invoice-linked receipt, and every ACK follows the successful send for that notification.
11. ACK clears ciphertext; repeated polls send no duplicate message.

All automated purchasing adapters now have `mode: test` and every instantiated purchasing engine has live mode **false**. A historical live-payment recovery unit fixture changes an existing database row to `mode: live` only to exercise read-only recovery while live spending remains disabled; no live adapter is called. Live-configuration parser tests reject unsafe settings without starting a service. Integration `fetch` rejects any hostname other than `127.0.0.1`, and Telegram API calls in update-handler tests use a fake grammY transformer. The REST adapter unit suite replaces `fetch` entirely. No test can reach a paid external endpoint.

The development adapter now uses persisted PostgreSQL payment intent and catalogue identity, so its invoice/order quote checks follow the same policy path as live purchasing. Its only code is `TEST-NOT-REDEEMABLE`; integration fixtures use `TEST-MOCK-NOT-REDEEMABLE`. Neither represents a real gift card or invoice.

## Feature and negative/security matrix

| Feature / negative case | Result | Evidence / scope |
| --- | --- | --- |
| `/start`, `/help`, `/whoami`, `/rules`, `/status`, `/enable`, `/pause`, `/resume` | PASS | Actual grammY update handlers with fake Telegram; real HTTP engine client |
| `/newrule`, guided selection and enable confirmation | PASS | Complete controller-to-engine E2E |
| Natural-language rule proposal | PASS (stub boundary) | Same controller/HTTP operations with validated proposal stub; external LLM not configured |
| Owner-only controls/approval | PASS | Unauthorized sender and unauthorized owner ID cannot approve/purchase |
| Wrong/missing/malformed signature, including valid MAC + trailing junk | PASS | Actual webhook route rejects; no purchase |
| Unmerged/open PR, missing label, unrelated event | PASS | Ignored or ineligible; zero invoices/payments |
| Unauthorized repository and casing mismatch | PASS | Foreign repo blocked; authorized mixed case matches |
| Unknown recipient / changed configured recipient | PASS | Draft blocked; previously queued unauthorized recipient cannot purchase |
| Wrong product/package | PASS | Rejected before invoice/payment |
| Draft/paused rule | PASS | No transaction; resume explicitly restores eligibility |
| Duplicate delivery / same PR different delivery IDs / concurrent duplicates | PASS | One durable purchase, invoice and payment across concurrent workers |
| Per-purchase, daily and monthly hard caps | PASS | Integer cents; concurrent budget reservations serialized |
| Outstanding reservation from earlier UTC period | PASS | Unit regression retains reservation in current budget |
| Above automatic threshold, no approval / expired / rejected / unauthorized approval | PASS | No payment until valid owner authorization; caps still apply |
| Actual price differs from estimate/face value | PASS | Invoice charge alone governs authorization; no INR/USD comparison |
| Invoice charge changes after approval / unknown price/currency | PASS | Payment blocked |
| Missing/extra invoice orders | PASS | Exact single-order policy; empty list explicitly tested; implementation rejects any length other than one |
| Insufficient balance / payment timeout / uncertain payment | PASS (fake boundary) | Reserved, reconciled existing invoice; no second pay/create |
| Worker restart with pending/uncertain transaction | PASS | Reconstructed worker uses durable state; later delivery recovered with no new payment |
| Complete invoice, failed individual order | PASS | Never marked delivered; attempted charge stays counted |
| Duplicate Bitrefill webhook / duplicate notification polling | PASS | One encrypted delivery record; one send in running worker |
| Engine temporarily offline | PASS | Webhook returns retryable 502; safe redelivery succeeds |
| Telegram send or chat-lookup temporarily offline | PASS | Encrypted notification retained; retry succeeds; no secret in logs |
| ACK temporarily offline | PASS | Only ACK retried; no second Telegram send |
| Database server process restart | NOT TESTED | Worker/adapter restart tested instead; no production database disruption |
| At-least-once notification crash window | Known limitation | A crash after Telegram accepts but before durable ACK may repeat a private notification; it cannot repeat payment |

## Confirmed defects fixed

| Priority | Before | After / regression |
| --- | --- | --- |
| P1 | `getChat` returning null on temporary outage was treated as unauthorized; a redacted warning was ACKed and gift ciphertext erased | Unknown lookup is retryable; original encrypted outbox entry retained. Regression failed before fix and passes now |
| P0 privacy | Telegram error message logged verbatim, potentially including redemption text | Transport/bot/LLM exception details suppressed. Injected secret-bearing exception regression failed before fix and passes now |
| P0 authorization | A syntactically numeric recipient could be enabled without proving it was a private chat reachable by this bot | Authenticated private-chat check before create/enable/resume; configured recipient gate mandatory in live mode; unknown/reconfigured-recipient regressions |
| P1 | A distinct owner received processing messages but no final delivery receipt | Separate redacted receipt with invoice ID and integer-cent charge; recipient alone gets redemption |
| P0 test validity | Disabled simulation skipped pre-payment invoice/order checks, so fake E2E did not exercise the actual policy path | Persisted simulation intent; quote/order checks run in both modes; synthetic redemption follows encryption/relay/ACK path with explicit test labeling |
| P1 signature validation | Buffer hex decoding could ignore trailing non-hex junk after a correct MAC | Exact `sha256=` + 64 hex characters required; actual-route regression |
| P2 | `/status` showed oldest five purchases; connection failures claimed nothing changed | Newest five displayed; unknown transport outcomes ask owner to check state before retrying |

No hard cap was raised to make a test pass. No claim-based rewards, dashboard, WhatsApp, contributor identity mapping or unrelated integration was added. The only recipient mapping is the owner's pre-linked fixed private chat.

## Safe live checks

| Check | Automated result | Manual required? | Exact action |
| --- | --- | --- | --- |
| A: Both unit suites, builds, migrations | PASS | No | Re-run root commands above |
| A: Signed fixture GitHub → actual services → fake payment → private relay/ACK | PASS | No | `npm run test:integration` with disposable `TEST_DATABASE_URL` |
| A: Shared token/auth failure | PASS | No | Covered through real HTTP and compiled smoke query |
| A: Telegram token identity | PASS | No | `getMe` returned bot `buyoncueBot`; token never displayed |
| A: Telegram mode/polling startup | PASS | No | `getWebhookInfo`: no webhook configured, 0 pending updates; compiled `bot.start` entered polling |
| A: Public HTTPS routing/HMAC ping | PASS | No | Temporary tunnel health + signed ping; tunnel now stopped |
| B: Bitrefill authentication/catalogue/details/balance | BLOCKED | Yes, credential | Put Personal API key in ignored engine `.env`; run `LIVE_PURCHASES_ENABLED=false npm run check:live` |
| B: Persistent application database | BLOCKED | Yes, deployment configuration | Set engine `DATABASE_URL` for a dedicated app database and run migration; test DB was temporary, local `.env` database remains unset |
| B: External LLM interpretation | NOT TESTED | Optional | Configure all three LLM variables only if AI interpretation is wanted; guided creation already works |
| C: Actual owner/private-recipient identity | MANUAL | Yes | Both people start `@buyoncueBot` privately; owner sends `/whoami`; set chat owner ID and engine authorized recipient ID; restart |
| C: GitHub repository access | PASS | No | Repo and PR metadata readable; both feature PRs confirmed; integration branch pushed |
| C: Repository webhook administration/configuration | BLOCKED | Yes, repo admin | Hooks API read unavailable to current account; admin must confirm/configure HTTPS `/webhooks/github`, JSON, matching secret, pull-request events |
| C: Genuine GitHub delivery | MANUAL | Yes | After explicit spend authorization, merge exactly one prepared labeled PR; inspect Recent Deliveries. Fixture and public ping do not prove a genuine merged delivery |
| D: Real Bitrefill payment | MANUAL + BLOCKED | Explicit authorization and funded key | Complete preflight below; keep live disabled until authorized |
| D: Real invoice, individual delivery, Telegram receipt | NOT TESTED | Yes | Capture actual invoice ID and delivered order; confirm private receipt/code with recipient |
| D: Hackathon video/submission | BLOCKED | Yes | Record authorized live demo, add video and real invoice ID; keep codes/tokens blurred |

Local ignored chat environment was securely provisioned with the existing bot token, the engine's matching internal token and a random GitHub webhook secret. `TELEGRAM_OWNER_USER_ID` remains unset because no owner identity was supplied. Nothing was guessed from contributors or GitHub accounts. Engine `.env` keeps `LIVE_PURCHASES_ENABLED=false`; absent Bitrefill key and persistent database are not disguised as completed checks.

## Real-payment preflight (explicit owner authorization required)

**Do not execute these spending steps as part of an automated test.**

1. Provision a dedicated persistent PostgreSQL database, set `DATABASE_URL`, preserve the generated internal/encryption keys, migrate and start both services with live **false**. Keep one Telegram notification worker active.
2. Owner and recipient each open `https://t.me/buyoncueBot`, tap **Start**, and message privately. Owner sends `/whoami`; set `TELEGRAM_OWNER_USER_ID` in chat `.env`. Set engine `AUTHORIZED_RECIPIENT_CHAT_ID` to the one verified positive private recipient ID. Restart both services. Creating/enabling a rule performs authenticated private-chat validation.
3. Supply the funded Bitrefill Personal API key only to the ignored engine environment. Run `LIVE_PURCHASES_ENABLED=false npm run check:live`. Require authenticated ping, USD balance currency, a genuinely in-stock country `IN` product and exact fixed package from actual details. The check deliberately does not print balances; owner must privately confirm sufficient funds in their account.
4. Start a persistent public HTTPS deployment/tunnel. Set `PUBLIC_ENGINE_URL` to the engine's HTTPS origin for `/webhooks/bitrefill`; expose the chat `/webhooks/github` separately. A single reverse proxy may route these paths to their services. The temporary audit tunnel exposed chat only and is not sufficient for live engine callbacks.
5. Repo admin configures GitHub webhook → chat HTTPS `/webhooks/github`, JSON, the locally stored `GITHUB_WEBHOOK_SECRET`, pull-request events only. Confirm green ping. No repository webhook was created or changed by this audit.
6. Owner privately reviews the exact repository, `reward-ready` label, product/package, recipient, per-purchase/daily/monthly limits and automatic threshold. Keep only **one** enabled demo rule and **one** prepared qualifying PR/event. Resolve any earlier uncertain payment before proceeding; do not requeue it or create a substitute paid invoice.
7. Obtain **explicit owner authorization to spend** for the one demo under those fixed caps. Only then may the human deliberately set `LIVE_PURCHASES_ENABLED=true`, restart the engine and enable the reviewed standing rule. If an earlier test-mode rule was enabled, pause it and use a fresh reviewed production rule. Never increase caps merely because an invoice is blocked.
8. The first real merged event creates one **unpaid** invoice with balance payment, `auto_pay:false`. Engine checks `payment.currency === USD`, exact positive cent charge, single matching order, caps, recipient and approval policy before paying that invoice. A quote above the automatic threshold requires the owner's unexpired approval; hard caps still cannot be overridden. Unknown/mismatched price or currency must stop payment.
9. A human merges exactly the prepared labeled PR only after step 7. Do not merge an unrelated PR to obtain evidence. Watch the genuine signed GitHub delivery reach the engine without another buy command.
10. Record the **non-mock invoice ID**, payment state and authenticated individual order `delivered` state. Confirm recipient receives usable redemption in their private chat and owner receives the invoice-linked redacted receipt. Keep codes/PINs/keys out of logs, screenshots and the video.
11. Redeliver the **same** GitHub event to demonstrate no second purchase. Verify one stable purchase/invoice/payment in history and no unresolved uncertain outcomes. A timeout means reconcile the existing invoice; never blindly retry payment.
12. Pause the demo rule or disable new live spending after the demonstration. Add genuine invoice/video evidence to `docs/SUBMISSION.md` only after confirmation. A delivered test marker, public ping or simulated invoice never satisfies the paid hackathon requirement.

## Release verdicts

| Area | Verdict | Practical meaning |
| --- | --- | --- |
| Unit baseline | **PASS** | Independently reproduced and final 96 unit tests pass |
| Integrated baseline | **PASS — AUTOMATICALLY VERIFIED** | 39 real-interface tests; migrations, builds and services run; external money and Telegram acceptance simulated |
| Telegram live connectivity | **PASS** | Identity, mode and polling verified; actual owner/recipient interaction remains MANUAL |
| GitHub live webhook | **MANUAL** | Signed fixture and temporary public ping pass; actual repository merged-PR delivery NOT TESTED; hooks administration BLOCKED |
| Bitrefill read-only integration | **BLOCKED** | Personal API key absent; actual Indian product/package/balance unknown |
| Real-money purchase | **MANUAL / BLOCKED** | Requires funded credentials and explicit owner authorization; no money spent |
| Verified delivery | **NOT TESTED (live)** | Synthetic individual-order delivery/recipient/receipt/ACK pass; actual usable gift card unverified |
| Hackathon submission readiness | **BLOCKED** | Code baseline ready for review; real purchase, real delivery, video and invoice evidence still required |

No remaining confirmed P0/P1 defect was observed in the exercised baseline paths. This is not a claim about untested funded provider behavior, Telegram's actual delivery to the future configured recipient, or the genuine GitHub event path. Those prerequisites remain explicit above.
