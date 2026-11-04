# BuyOnCue — hackathon submission

**Readiness:** automated integrated baseline verified; live purchase, delivery and video evidence still required. Do not present test invoice IDs as real.

**Name:** BuyOnCue
**One-liner:** A Telegram agent that, after one-time setup, autonomously buys Bitrefill gift cards when an authorized GitHub PR is merged, inside hard spending limits you set, and reports every step back in chat.

| | |
|---|---|
| Event | Free Society Hackathon — Agentic Commerce with Bitrefill |
| Repository | [UserAkku/buyoncue](https://github.com/UserAkku/buyoncue) |
| Demo video | Not recorded — live demonstration remains manual |
| Real Bitrefill invoice ID | NOT TESTED — no authorized live purchase yet |
| Lanes | Rails and Guardrails · No Prompt Required |

## Bitrefill technology touchpoint

BuyOnCue uses Bitrefill as its commerce rail. Through the engine service, it searches Bitrefill's catalog for in-stock products and exact denominations (the bot only ever offers options the catalog returned), creates and pays a Bitrefill invoice when a rule fires, and reads back the delivery result and redemption details, which it relays to the user's private Telegram chat together with the real invoice ID. No purchase is reported as successful until Bitrefill's delivery is confirmed by the engine. The Telegram chat service never calls Bitrefill directly and never holds payment credentials; this keeps the agent's conversational surface separate from the component that can move money.

API v2: `GET /products/search`, `GET /products/:id`, `POST /invoices` with `payment_method: "balance", auto_pay: false`, `GET /invoices/:id` using `payment.price` and `payment.currency`, `POST /invoices/:id/pay`, then `GET /orders/:id` and `redemption_info`. See [verification evidence](BASELINE_VERIFICATION.md); actual authenticated Bitrefill reads and payment remain blocked/unverified.

## Maximum spending authority and approval design

The owner grants authority once, per rule, by enabling it. The authority is bounded by four integer-cent limits that the owner types or taps explicitly (the AI never sets them):

1. **Per-purchase hard cap**: a single purchase above this is blocked.
2. **Daily cap** and 3. **Monthly cap**: cumulative limits enforced by the engine.
4. **Auto-approval threshold**: purchases up to this run unattended; anything above, up to the hard cap, waits for the owner's **Approve** tap in Telegram (a threshold of $0 means every purchase is manually approved).

So the maximum the agent can ever spend is the configured per-rule UTC monthly cap, subject also to each UTC daily cap, never more than the per-purchase cap per transaction, and only for the one product/denomination, repository and label the owner approved. Additional guardrails:

- Rules are created as **drafts** and spend nothing until explicitly enabled; they can be paused/resumed at any time.
- **Owner-only:** only the configured Telegram user, in their private chat, can edit rules or approve spending.
- The engine is the sole authority for budget checks, approvals and purchase state; the chat service cannot approve its own requests.
- GitHub webhooks are HMAC-verified; the engine de-duplicates delivery IDs and the stable `(rule, repository, PR number)` identity, so redelivery cannot cause a second purchase.
- LLM boundary: parsing only. It cannot choose products, set limits, approve, or execute, and it never reads GitHub content.
- INR denominations are never silently converted into USD limits.
- Redemption codes go only to a verified private recipient chat and are never logged.

## How to run

See the [README](../README.md#quick-start-about-15-minutes). In short:

```bash
cd services/chat && npm install && cp -n .env.example .env   # fill in the values
npm run dev                                               # engine must be running at ENGINE_URL
```

Then add a GitHub webhook (`pull_request` events, secret = `GITHUB_WEBHOOK_SECRET`) pointing at `/webhooks/github`, message the bot, enable the rule, and merge a labelled PR. A 2–3 minute walkthrough is in [DEMO.md](DEMO.md).
