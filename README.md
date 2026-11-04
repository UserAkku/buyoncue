# PactPilot

**A Telegram-native autonomous commerce agent.** Describe a purchasing rule once, in plain language. When an authorized GitHub event happens later (a PR is merged), PactPilot buys a real [Bitrefill](https://www.bitrefill.com) gift card for you, inside spending limits you set, and sends approvals, payment updates and a verified delivery receipt straight to Telegram. Nobody has to start checkout.

> Built for the Free Society Hackathon, *Agentic Commerce with Bitrefill*.

**Lanes:** 🛡 *Rails and Guardrails* · 💬 *No Prompt Required*

- **Rails and Guardrails:** hard per-purchase / daily / monthly caps in exact integer USD cents, an auto-approval threshold with Approve/Reject buttons above it, owner-only control, and a rule that is a *draft* until the owner explicitly enables it. The engine is the only component that can authorize spending.
- **No Prompt Required:** after a one-time setup there is no prompt and no manual checkout. A signed GitHub webhook triggers the purchase, and the agent reports back on its own.

---

## What we built vs. what we reused from Bitrefill

| | |
|---|---|
| **Built by us (this repo, `services/chat`)** | Telegram bot (grammY), LLM rule interpreter with Zod validation + guided fallback, signed GitHub webhook receiver, notification relay with privacy checks, typed engine client, mock engine, tests. |
| **Built by us (`services/engine`)** | Policy and budget enforcement, rule/purchase state, approvals, idempotent trigger handling, and the integration with Bitrefill. |
| **Bitrefill technology reused** | Catalog (product + denomination search, stock), invoice creation and payment, and gift-card delivery/redemption data, all consumed **through the engine**. The chat service never calls Bitrefill and never holds Bitrefill or wallet credentials. |

> Exact Bitrefill endpoints used by the engine: *see `services/engine/README.md` (owned by the engine developer).*

## Architecture

```
 You ──Telegram──▶  ┌──────────────────────────────┐
                    │  services/chat   (Node/TS)    │
 GitHub ─webhook──▶ │  • grammY bot (long polling)  │   Bearer INTERNAL_API_TOKEN
 (HMAC-signed)      │  • LLM rule interpreter       │ ──────────────────────────────▶ ┌────────────────────┐
                    │  • POST /webhooks/github      │      frozen HTTP contract       │ services/engine     │
 Telegram ◀──msgs── │  • notification worker (poll) │ ◀────────────────────────────── │ policy · budgets ·  │──▶ Bitrefill
 (approve buttons,  └──────────────────────────────┘      /v1/notifications           │ approvals · state   │    (catalog, invoice,
  receipts)                                                                            └────────────────────┘     delivery)
```

Trust boundaries, in short:

- The **LLM** only turns the owner's own message into a *proposal* of text fields. It never sees GitHub content, never produces product IDs, limits or approvals, and never executes anything. Every limit is typed or tapped by the owner; every product comes from the live catalog.
- **GitHub payloads are untrusted data.** Only a fixed set of structured fields is forwarded to the engine (repo, PR number, labels, author login, timestamps). Titles and bodies are dropped.
- **Redemption codes** are only ever sent to a *private* chat that is the owner's own chat or a rule recipient the owner configured, and never written to logs.

## Quick start (about 15 minutes)

Requirements: Node.js 20+, a Telegram account, and a public HTTPS URL for the GitHub webhook (a tunnel such as `cloudflared` or `ngrok` is fine).

### 1. Install

```bash
cd services/chat
npm install
cp .env.example .env
```

### 2. Create the Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → name it *PactPilot* → copy the token into `TELEGRAM_BOT_TOKEN`.
2. (Optional) `/setdescription` and `/setuserpic` for polish. Commands are registered automatically at startup.
3. Leave `TELEGRAM_OWNER_USER_ID` empty for now, start the service (step 5), and send `/whoami` to your bot. Put the user ID it prints into `.env` and restart. Until then the bot only answers `/start`, `/help` and `/whoami`.

### 3. Shared secrets

Generate two random values (do **not** reuse real passwords) and put them in `.env`:

```bash
openssl rand -hex 32   # INTERNAL_API_TOKEN  (must match the engine's value)
openssl rand -hex 32   # GITHUB_WEBHOOK_SECRET
```

### 4. Start the engine

- **Real engine:** follow `services/engine/README.md`, using the same `INTERNAL_API_TOKEN`; it should listen on `ENGINE_URL` (default `http://localhost:3001`).
- **No engine yet?** Use the bundled contract mock. It never touches Bitrefill and all its invoice IDs/codes are fake (`MOCK-…`):
  ```bash
  cd services/chat && npm run mock-engine
  ```

### 5. Start the chat service

```bash
cd services/chat
npm run dev          # or: npm run build && npm start
```

The service logs whether it is in `ai` or `guided` mode. With no LLM credentials, `/newrule` is a step-by-step guided flow and the bot says so; it is never presented as AI.

### 6. Connect GitHub

1. Expose the chat service: `cloudflared tunnel --url http://localhost:3002` (or `ngrok http 3002`).
2. In the GitHub repo: **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<your-tunnel>/webhooks/github`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: **Let me select individual events → Pull requests** only.
3. GitHub sends a `ping`; the *Recent Deliveries* tab should show `200`.

### 7. Create and enable a rule

Message your bot, e.g.:

> Whenever a PR with reward-ready label is merged in my repo, send a ₹50 Flipkart gift card, subject to my spending limits.

The bot proposes what it understood, searches the real catalog, asks you to pick the exact product/package and to set each limit, creates a **draft**, and shows an **Enable Rule** button. Nothing can be bought before you tap it. Then merge a PR carrying the label.

## AI bounties with a GitHub App (Telegram ↔ GitHub)

On top of the single-rule flow, the chat service can connect a repository through a **read-only GitHub App** and review real pull requests:

1. **Maintainer** (`TELEGRAM_OWNER_USER_ID`): `/connectgithub` → sign in with GitHub, install the app on one repository, confirm the account link, pick the repository (the bot checks with GitHub that you're an admin) → `/setbounty` (label, tiers, typed USD limits) → **Enable bounty**.
2. **Contributor** (anyone, private chat): `/linkgithub` → GitHub sign-in → their immutable numeric GitHub ID is bound to their Telegram user through the engine.
3. **PR opened/updated:** the bot collects evidence from GitHub (files and patches, commits, reviews, check runs, linked issues; limits and gaps reported honestly), sends it to the engine for an AI review and shows the **provisional** score. A new commit supersedes the old review. Nothing is paid.
4. **PR merged:** the bot re-reads the PR from GitHub, re-collects evidence for the final commit and asks the engine to finalize. The engine alone enforces limits and buys; the gift card is delivered to the contributor's private chat, and "delivered" is only announced after the engine confirms it with an invoice.

Commands: `/connectgithub` `/repositories` `/setbounty` `/review` `/bounties` (maintainer) · `/linkgithub` `/unlinkgithub` `/myrewards` (contributors). Setup: [GitHub App](docs/GITHUB_APP_SETUP.md) · [Telegram + tunnel](docs/TELEGRAM_SETUP.md) · [demo](docs/BOUNTY_DEMO.md) · [engine contract](docs/BOUNTY_ENGINE_CONTRACT.md). The feature is off unless all `GITHUB_APP_*` variables are set; the original Telegram rule flow keeps working either way.

## Environment variables

All live in `services/chat/.env` (see [`.env.example`](services/chat/.env.example)). No secrets belong in the repo.

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from @BotFather |
| `TELEGRAM_OWNER_USER_ID` | for use | Numeric Telegram user ID of the one person allowed to manage rules and approve spending |
| `ENGINE_URL` | no (`http://localhost:3001`) | Base URL of the engine |
| `INTERNAL_API_TOKEN` | yes | Bearer token for all engine `/v1/*` calls |
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC secret for `X-Hub-Signature-256` |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | no | Any OpenAI-compatible chat-completions API. All three must be set, otherwise guided mode is used |
| `PORT` | no (`3002`) | HTTP port for the webhook, GitHub OAuth routes and `/healthz` |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_OAUTH_CALLBACK_URL`, `GITHUB_APP_INSTALL_URL`, `PUBLIC_CHAT_URL` | all or none | GitHub App for AI bounties; see [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) |
| `CHAT_STATE_FILE` | no | Secret-free local state (review index, webhook dedupe, identity link cache). Default `.data/chat-state.json` |

## Bot commands

`/start` · `/help` · `/whoami` · `/newrule` · `/rules` · `/enable` · `/pause` · `/resume` · `/status` · `/cancel`

Inline buttons: Enable Rule, Edit/restart, Approve, Reject, Pause, Resume.

## Testing

```bash
cd services/chat
npm test             # all tests run against local mocks of the engine and of GitHub
npm run typecheck
```

Tests cover: a full rule conversation, missing-field clarification, invented product IDs being impossible to submit, drafts not being enabled early, unauthorized users, webhook signature rejection, merged-PR normalization, unmerged PRs ignored, Bearer auth on engine calls, approval buttons, private-only delivery of redemption data, acknowledge-after-send, and engine-offline behaviour. **No test makes a real Bitrefill purchase**, and none touches the real Telegram or GitHub APIs.

## Known limitations

- Single owner, single worker instance; Telegram long polling. Not horizontally scalable.
- Conversation state and "sent but not yet acknowledged" notification IDs live in memory. A restart mid-setup loses the draft conversation, and a crash between a successful Telegram send and the acknowledgement can repeat that one message.
- Limits are enforced in USD (payment currency). The bot never converts INR to USD; you confirm every USD cap yourself.
- "Edit / restart" creates a new draft; the contract has no endpoint to delete the old one.
- The engine's rule-status and notification-type vocabularies are only partly specified; the bot falls back to the engine's own text. See [FEEDBACK.md](FEEDBACK.md).
- Only GitHub `pull_request` (closed + merged) events are supported.
- Recipients other than the owner must have started the bot once, or Telegram refuses delivery.
- The integrated baseline is tested through both real HTTP services with fake payment and Telegram boundaries. A funded Bitrefill purchase and genuine GitHub-triggered live delivery remain unverified. See [the verification report](docs/BASELINE_VERIFICATION.md).

## Repository layout

```
services/chat/      Telegram + webhook + notifications (this service)
services/engine/    Commerce engine and PostgreSQL worker
docs/DEMO.md        2–3 minute live demo script
docs/SUBMISSION.md  Hackathon submission text
FEEDBACK.md         Honest log of problems, workarounds and suggestions
```

## Integrated baseline verification

Use Node.js 22.12+ for the current test toolchain and a disposable PostgreSQL database.

```sh
npm --prefix services/engine ci
npm --prefix services/chat ci
export TEST_DATABASE_URL=postgresql://localhost/pactpilot_engine_test
LIVE_PURCHASES_ENABLED=false npm test
npm run typecheck
npm run build
# With ignored local .env files configured, read-only external checks:
LIVE_PURCHASES_ENABLED=false npm run check:live
```

The root suite connects the real chat client, GitHub HTTP endpoint and engine HTTP server to an isolated migrated PostgreSQL schema. It forbids external fetches and uses marked fake invoice IDs and synthetic non-redeemable data. The production live flag is never enabled by the tests. Optional LLM interpretation is tested with a proposal stub; actual LLM credentials are not required for guided setup.

The live MVP accepts one pre-linked recipient: set `AUTHORIZED_RECIPIENT_CHAT_ID` in the engine after that person starts the bot privately. The chat service checks the recipient with Telegram before draft creation and before enable/resume. Use the same internal API token in both service environments. The existing local environments were preserved/provisioned without committing credentials.
