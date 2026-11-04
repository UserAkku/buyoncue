# PactPilot commerce engine

Node.js 20+, TypeScript, Fastify and PostgreSQL. All service files, dependencies and migrations live in this directory. The separately owned Telegram/GitHub adapter talks to the internal HTTP API.

## Install and run

```sh
cd services/engine
npm ci
# Preserve an existing .env: it may already contain locally provisioned secrets.
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` and supply a PostgreSQL `DATABASE_URL` (Neon URLs with `sslmode=require` are supported). For local PostgreSQL, create a database using your existing local role:

```sh
createdb pactpilot_engine
# Example DATABASE_URL: postgresql://localhost/pactpilot_engine
```

Set a random `INTERNAL_API_TOKEN` of at least 32 characters and a 32-byte hex `REDEMPTION_ENCRYPTION_KEY`. Generate each independently with `openssl rand -hex 32`. Keep the encryption key stable across restarts and store it separately from database backups. `.env` is ignored by Git. A supplied Telegram token is stored there as `TELEGRAM_BOT_TOKEN` for the separate chat service; the engine never reads or uses it.

Keep `LIVE_PURCHASES_ENABLED=false`. Set `BITREFILL_API_KEY` for authenticated **read-only** catalogue access, even in development. There is no fabricated catalogue fallback. With no key, catalogue routes return a configuration error and rules cannot be created. Set `PUBLIC_ENGINE_URL` and `PORT` (default 3001).

```sh
npm run migrate
npm run build
npm start
# Or: npm run dev
curl http://localhost:3001/health
```

`npm run migrate` applies versioned, checksummed SQL inside a transaction with a database migration lock. Re-running it is safe. Apply migrations before starting each deployment. Workers run in the HTTP service; more than one instance may share the same database.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; required |
| `INTERNAL_API_TOKEN` | Shared secret for the trusted adapter; at least 32 characters |
| `AUTHORIZED_RECIPIENT_CHAT_ID` | Required in live mode: the one positive private chat ID pre-linked through Telegram |
| `BITREFILL_API_KEY` | Personal API bearer token; required for real catalogue and live operations |
| `BITREFILL_BASE_URL` | `https://api.bitrefill.com/v2`; other origins are rejected |
| `PUBLIC_ENGINE_URL` | Externally reachable service URL; HTTPS required in live mode |
| `LIVE_PURCHASES_ENABLED` | Exact `true` or `false`; defaults to `false` |
| `PORT` | HTTP port; default 3001 |
| `REDEMPTION_ENCRYPTION_KEY` | 64 hex characters; required |
| `APPROVAL_TTL_SECONDS` | Approval lifetime, 30–86400 seconds; default 900 |
| `WORKER_INTERVAL_MS` | Poll interval, 250–60000 ms; default 2000 |

Environment parsing errors report field names without printing their values. HTTP request logging is disabled. Provider response bodies and exception messages are never logged. Run behind HTTPS and keep `/v1/*` reachable only by the trusted adapter. Anyone possessing the internal bearer token can act as that adapter, including reading its notification outbox.

## HTTP contract

All `/v1/*` routes require `Authorization: Bearer INTERNAL_API_TOKEN`. Errors use `{"error":{"code":"CODE","message":"Explanation"}}`. Owner IDs and recipient IDs are strings. Limits and invoice charges are integer USD cents. Unknown request fields are rejected on rule, trigger and approval bodies.

| Method | Route | Input / result |
| --- | --- | --- |
| GET | `/health` | `{ok:true,service:"engine",livePurchasesEnabled:boolean}` |
| GET | `/v1/products/search?query=flipkart&country=IN` | `{products:[{id,name,country,currency,inStock,packages:[{packageId,value}]}]}` |
| GET | `/v1/products/:id` | `{product:...}` |
| POST | `/v1/rules` | Rule fields below; HTTP 201 `{rule:...}` with `status:"draft"` |
| GET | `/v1/rules?ownerChatId=123` | `{rules:[...]}` |
| POST | `/v1/rules/:id/enable` | `{ownerChatId:"123"}` → `{rule:...}` |
| POST | `/v1/rules/:id/pause` | Same body/result |
| POST | `/v1/rules/:id/resume` | Same body/result |
| POST | `/v1/triggers/github` | Trigger below; HTTP 202 `{accepted:true,eventId,reason}` |
| POST | `/v1/approvals/:purchaseId` | `{ownerChatId:"123",decision:"approve"\|"reject"}` → `{ok:true}` |
| GET | `/v1/purchases?ownerChatId=123` | `{purchases:[{id,ruleId,status,invoiceId,amountUsdCents,createdAt,mode,errorCode}]}`; no redemption |
| GET | `/v1/notifications?limit=20` | `{items:[{id,chatId,type,text,purchaseId,invoiceId,approvalPurchaseId,redemption}]}`; max 100 |
| POST | `/v1/notifications/:id/ack` | `{ok:true}`; idempotent, erases encrypted redemption |
| POST | `/webhooks/bitrefill` | Full invoice payload with `id`; `{ok:true}`; only schedules authenticated reconciliation |

Rule body:

```json
{
  "ownerChatId": "123",
  "recipientChatId": "123",
  "name": "PR reward",
  "repository": "owner/repo",
  "requiredLabel": "reward-ready",
  "productId": "COPY_FROM_AUTHENTICATED_CATALOGUE",
  "packageId": "COPY_EXACT_PACKAGE_ID",
  "perPurchaseCapUsdCents": 200,
  "dailyCapUsdCents": 500,
  "monthlyCapUsdCents": 2000,
  "autoApproveUpToUsdCents": 150
}
```

Trigger body:

```json
{
  "deliveryId": "github-delivery-id",
  "repository": "owner/repo",
  "prNumber": 42,
  "merged": true,
  "labels": ["reward-ready"],
  "authorLogin": "contributor",
  "mergedAt": "2026-11-04T12:00:00Z"
}
```

Trigger reasons: `queued`, `not_merged`, `no_eligible_rule`, `duplicate_delivery`, `duplicate_pr`. Ignored events are durably recorded. A rule must already be enabled when the event arrives. Repository names are normalized to lowercase; labels match exactly. The adapter must verify GitHub webhook signatures and derive `ownerChatId` from the authenticated Telegram sender, rather than user-provided text. Only pre-authorized `recipientChatId` receives redemption. There is no rule-update route: create and explicitly enable a revised rule to change identity, product, label or recipient. PostgreSQL also prevents identity changes after first enablement.

Notification types include `rule_enabled`, `rule_paused`, `purchase_pending_approval`, `budget_exceeded`, `duplicate_event_skipped`, `invoice_created`, `payment_processing`, `purchase_delivered`, `purchase_failed`, `payment_uncertain` and `test_purchase_delivered` and `purchase_receipt`. A resume produces `rule_enabled`. Send each item to its exact `chatId` and acknowledge only after successful delivery. Delivery is at least once; a poller crashing after sending and before acknowledging may send the same message again. Use one active Telegram poller or coordinate pollers externally.

## Purchase and spending behavior

Each `(rule_id, repository, pr_number)` has one durable purchase, across delivery IDs and service restarts. Worker session locks prevent concurrent execution of a purchase; rule row locks serialize budget checks. Side-effect intent is committed before contacting Bitrefill.

The live flow validates the exact in-stock package, creates **one unpaid invoice** with `payment_method:"balance"` and `auto_pay:false`, and persists its actual ID. Only the documented `payment.price` and `payment.currency` authorize the charge. The engine accepts an exact positive USD balance charge with at most two decimals; it never converts a card's INR face value into an assumed USD price. It rejects unknown charge/currency, multiple orders, changed prices and mismatched product/order details before payment. Flexible ranges and products requiring additional recipient fields are outside this fixed-package contract.

Caps satisfy `automatic <= per-purchase <= daily <= monthly`. Per-rule UTC daily and monthly budgets include committed spending and **all unresolved reservations**, even reservations from an earlier period. Test and live budgets are separate. Above the automatic threshold, funds remain reserved while owner approval is pending. Approval cannot override caps; the worker rechecks caps, expiry, rule status, stock and exact charge immediately before payment.

Only `READY_TO_PAY` may submit the documented `/invoices/:id/pay` call. Committed `PAYMENT_PROCESSING` or `PAYMENT_UNCERTAIN` state can only reconcile the existing invoice, never pay again. Timeouts, network errors and ambiguous provider rejections retain reservations. Even an unpaid result after restart is treated as uncertain: a previous payment call could still be in flight. Inspect the account manually before any operational intervention.

A lost invoice-creation response becomes `INVOICE_UNCERTAIN`: no replacement invoice is created and no payment is made. An unpaid invoice may remain in the provider account when a hard cap rejects it. This is intentional; invoice creation itself does not spend funds.

Authenticated invoice **and order** lookups must confirm actual delivery; `complete` alone is insufficient. Failed/refunded orders never produce redemption notifications. Charges for attempted payments remain conservatively counted until an operator verifies a refund; automated refund credits and manual retry endpoints are intentionally absent. Redemption is encrypted with AES-256-GCM, bound to its notification, purchase and recipient. Only a delivered live purchase may expose it through the internal outbox; acknowledgement deletes its ciphertext. No raw invoice, order or webhook payload containing redemption is retained. The configured recipient is rechecked before enabling and payment. A different owner receives a redacted invoice-linked receipt.

Webhooks are untrusted hints, so forged or repeated payloads cannot establish delivery or initiate payment. The database worker polls independently every 30 seconds for unresolved invoices. Disabling new live spending still permits authenticated, read-only reconciliation of previously submitted live payments. Mode-mismatched unpaid jobs remain deferred. Pausing a rule stops purchases before the durable payment intent; it cannot cancel a payment already submitted.

## Development and production demo

With live purchasing disabled, catalogue data remains real, but the purchase adapter is a restart-safe simulation charging a clearly labeled **fictional USD 1.00** against a separate test budget. It creates `test:` invoice IDs, uses `TEST_DELIVERED`, and emits only an explicitly non-redeemable test marker. These IDs are never evidence of a real purchase. No automated test contacts Bitrefill or spends credits.

For a real demo, a human must explicitly provision/fund a USD account, provide its Personal API key, choose a real fixed package, verify the recipient privately through the bot and set `AUTHORIZED_RECIPIENT_CHAT_ID`, set affordable hard caps and intentionally configure `LIVE_PURCHASES_ENABLED=true`. Verify authentication without spending:

```sh
npm run check:bitrefill
```

That command calls only `/ping` and `/accounts/balance` and prints the account currency, not its balance. Then use the internal API to create a draft rule, review its exact recipient/package/caps, and explicitly enable it. A genuine delivered purchase will expose the actual Bitrefill invoice ID in `/v1/purchases`. This implementation has not been exercised against a funded live account; an authenticated catalogue/quote check and explicitly authorized paid demo remain necessary.

Implementation references: [Quickstart](https://docs.bitrefill.com/docs/quickstart-2), [integration flow](https://docs.bitrefill.com/docs/integration-flow), [invoice response](https://docs.bitrefill.com/reference/get_invoices-id), [product response](https://docs.bitrefill.com/reference/get_products-id), [order response](https://docs.bitrefill.com/reference/get_orders-id), [webhooks](https://docs.bitrefill.com/docs/webhooks). The references contain both guide and schema variants for package IDs and redemption; the adapter supports the documented variants and fails closed on unsafe invoice data.

## Verification

Tests require a disposable PostgreSQL database. They create a unique schema, migrate it, test real transactions/constraints/worker concurrency, and drop only that schema afterward. They never use `DATABASE_URL` for test writes and never use live credentials for purchasing.

```sh
createdb pactpilot_engine_test
export TEST_DATABASE_URL=postgresql://localhost/pactpilot_engine_test
npm test
npm run typecheck
npm run build
```

The suite covers the 14 requested safety cases, all routes, ownership, immutable identity, UTC budgets, reservation carryover, approval expiry/rejection, changed quotes, restart recovery, encrypted redemption and clearing on acknowledgement. REST adapter tests replace `fetch` and assert exact documented paths and bodies.
