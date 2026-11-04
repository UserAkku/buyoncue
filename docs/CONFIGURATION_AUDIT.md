# BuyOnCue configuration audit and launch readiness

Audited: 4 November 2026 (IST), on this machine, checkout `/Users/Akhilesh/ak-projects/buyoncue/buyoncue`, branch `audit/config-readiness` (from `integration/final-ai-bounty-release` @ `3682b00`, PR #7). Deadline: **5 November 2026 00:00 IST**.

Re-run the audit at any time. It never prints values:

```bash
npm run audit:config          # offline: every variable, both services' real validators
npm run audit:config:probe    # + read-only network checks (DB, services, Telegram, GitHub App, demo repo, Bitrefill)
```

## Verdict

**Configuration readiness: 2 / 35 required items complete.** Nothing external is configured on this machine yet:

* `services/chat/.env` and `services/engine/.env` both exist, are **0 bytes** (unchanged since 13:44 / 16:31 IST today) and are mode `644`. No BuyOnCue variable is set in the shell. This is the only checkout on the machine; no other `.env` or `.pem` file for the project was found.
* No AWS CLI, no `cloudflared`, no `ngrok` installed. `gh` is logged in as `UserAkku` (scopes `repo, read:org, gist`), which allows read-only repo checks but **not** GitHub App checks.
* Done automatically: a durable local PostgreSQL database with migrations (item 1), and the full build and test baseline (item 2).

Nothing was spent, no `.env` was written, no external setting was changed. `LIVE_PURCHASES_ENABLED` is unset (= `false`).

## A. Completed automatically (verified on this machine)

| # | Check | Result |
|---|---|---|
| A1 | Git state | branch `integration/final-ai-bounty-release` @ `3682b00`, clean; this audit on `audit/config-readiness` |
| A2 | `.env` files | present, empty, `644`, git-ignored (`.env`, `.env.*`, `*.pem` in `.gitignore`); none tracked |
| A3 | Durable dev database | Homebrew PostgreSQL **16.15** cluster `/opt/homebrew/var/postgresql@16` started on `127.0.0.1:5432` (with `pg_ctl`, not as a login service). Created role **`buyoncue_app`** (LOGIN, no superuser/createdb/createrole) and database **`buyoncue_dev`** owned by it. Migrations `001_initial`, `002_ai_bounties`, `003_identity_revocation` applied; re-run is a no-op. Nothing existing was dropped. |
| A4 | Disposable test cluster | still running on `127.0.0.1:55439` (session scratch dir, **not durable**; tests only) |
| A5 | Engine boot on `buyoncue_dev` | `node dist/src/server.js` with throwaway in-memory secrets → `Engine listening … mode=test (no real purchases)`; `/health` `{ok:true, livePurchasesEnabled:false}` |
| A6 | Chat → engine bearer auth | compiled `EngineClient`: authenticated call OK; wrong token → `unauthorized 401` |
| A7 | GitHub webhook HMAC (local signed fixture) | compiled chat webhook: valid signature 200, bad signature 401, missing signature 401; `/healthz` 200 |
| A8 | Typecheck, build, tests | see "Test baseline" below (299 preserved + 5 new) |
| A9 | GitHub App identity (public) | `https://github.com/apps/buyoncue` → "About BuyOnCue · GitHub", so slug = **`buyoncue`**. Install URL = `https://github.com/apps/buyoncue/installations/new`. (`GET api.github.com/apps/buyoncue` → 404 unauthenticated; installation, permissions and webhook can only be read with the App's private key.) |
| A10 | Demo repository `UserAkku/buyoncue` (public, read-only via `gh`) | default branch `main`; **0 Actions workflows; no rulesets; no branch protection; no `reward-ready` label**; you are `admin`. No other repo looks like a dedicated demo repo. |
| A11 | Bedrock endpoint behaviour (no credential used) | With a deliberately invalid key, `bedrock-runtime.ap-south-1` Converse returns **HTTP 403 `AccessDeniedException`**, not 401. A bogus region fails DNS. So the earlier "Sonnet 403" can mean an invalid/expired/wrong-region key as well as missing model access. The probe now says so. |
| A12 | Bitrefill test-mode behaviour (code) | Test mode (`TestPurchasing`) never creates or pays real invoices, **but the catalogue is always the real Bitrefill API**. Without `BITREFILL_API_KEY`, `/newrule` and `/setbounty` can't search products, even for a no-spend rehearsal. |

### Fixed while auditing

* `scripts/check-bedrock.mjs` depended on a hard-coded `/tmp/buyoncue-real-pr-files.json` and its REVIEW mode did not use the application reviewer. Now:
  * it requires `--confirm-metered`;
  * REVIEW runs the engine's real `CompatibleReviewer` + `validateScore` against the portable, schema-valid fixture `scripts/fixtures/bedrock-review-evidence.json`, or `--evidence <file>`;
  * a missing or invalid fixture is reported as `NOT_RUN`, never as a model outage;
  * failures are classified from the HTTP status and AWS error *type* only (authentication / access-denied / model-not-found / validation / throttling / region-DNS / application-parse).
* `scripts/check-live.mjs` also verifies that `AUTHORIZED_RECIPIENT_CHAT_ID` is a reachable private chat.
* New `scripts/audit-config.mjs` plus 5 regression tests (`tests/integration/audit-config.test.ts`). They include proof that **no secret value appears in its output**.

## B. Missing environment variables (every one is currently MISSING)

Status of each from `npm run audit:config`. "Secret" = never paste into chat, a PR or a screenshot.

### Chat service (`services/chat/.env`, read from `services/chat` by `npm start`)

| Pri | Variable | Required when | Secret | Format / source |
|---|---|---|---|---|
| P0 | `TELEGRAM_BOT_TOKEN` | always (service won't start) | yes | `<digits>:<35 chars>` from @BotFather |
| P0 | `TELEGRAM_OWNER_USER_ID` | to leave setup mode | no | your numeric ID, from `/whoami` in the bot |
| P0 | `INTERNAL_API_TOKEN` | always | yes | ≥32 random chars; **identical** in engine `.env` |
| P0 | `GITHUB_WEBHOOK_SECRET` | always (even without the App) | yes | random, e.g. `openssl rand -hex 32`; same value in GitHub App → Webhook secret |
| P0 | `GITHUB_APP_ID` | AI bounties | no | `5609798` |
| P0 | `GITHUB_APP_CLIENT_ID` | AI bounties | no | `Iv23ligq8KkwCysuqvO9` |
| P0 | `GITHUB_APP_CLIENT_SECRET` | AI bounties | yes | 40 hex chars; **generate a new one** (the old one was exposed) |
| P0 | `GITHUB_APP_PRIVATE_KEY_PATH` | AI bounties | path not secret, file is | absolute path to the downloaded `.pem`, **outside the repo**, `chmod 600`. Code accepts this path **or** inline `GITHUB_APP_PRIVATE_KEY` (raw/`\n`-escaped/base64), **never both** |
| P0 | `PUBLIC_CHAT_URL` | AI bounties | no | `https://<tunnel-host>` (bare origin, https, not localhost) |
| P0 | `GITHUB_OAUTH_CALLBACK_URL` | AI bounties | no | exactly `PUBLIC_CHAT_URL` + `/auth/github/callback` |
| P0 | `GITHUB_APP_INSTALL_URL` | AI bounties | no | `https://github.com/apps/buyoncue/installations/new` |
| P1 | `LLM_PROVIDER` | AI parsing | no | `bedrock` (empty = guided mode, still works) |
| P1 | `AWS_REGION` | if bedrock | no | `ap-south-1` |
| P1 | `AWS_BEARER_TOKEN_BEDROCK` | if bedrock | yes | Bedrock API key |
| P1 | `BEDROCK_CHAT_MODEL_ID` | if bedrock | no | inference-profile ID from the Bedrock console (see D3) |
| — | `ENGINE_URL` `PORT` `CHAT_STATE_FILE` `BEDROCK_MAX_OUTPUT_TOKENS` `BEDROCK_MAX_INPUT_CHARS` | optional | no | defaults `http://localhost:3001`, `3002`, `.data/chat-state.json`, `2048`, `120000` are correct |
| — | `LLM_API_KEY` `LLM_BASE_URL` `LLM_MODEL` | alternative to Bedrock | — | leave empty; if `LLM_PROVIDER=bedrock` they are ignored |

Group rule: if **any** `GITHUB_APP_*`/`PUBLIC_CHAT_URL`/callback variable is set, **all** must be, or the chat service refuses to start. If `LLM_PROVIDER=bedrock` is set without region, key and model ID, the service refuses to start.

### Engine service (`services/engine/.env`, read from `services/engine`)

| Pri | Variable | Secret | Value / format |
|---|---|---|---|
| P0 | `DATABASE_URL` | no (trust auth, local) | `postgresql://buyoncue_app@127.0.0.1:5432/buyoncue_dev` (provisioned in A3) |
| P0 | `INTERNAL_API_TOKEN` | yes | same value as chat |
| P0 | `REDEMPTION_ENCRYPTION_KEY` | yes | 64 hex (`openssl rand -hex 32`). **Keep it stable**: changing it makes queued encrypted deliveries unreadable |
| P0 | `BITREFILL_API_KEY` | yes | Bitrefill Personal API key (needed even in test mode, for the catalogue) |
| P0 | `PUBLIC_ENGINE_URL` | no | test: `http://localhost:3001`; **live: `https://<engine-tunnel-host>`** (Bitrefill webhook callback `…/webhooks/bitrefill`; live mode refuses non-https) |
| P0 | `AUTHORIZED_RECIPIENT_CHAT_ID` | no | the **contributor's** numeric private chat ID (live mode refuses to start without it; it's the only chat the engine will pay to) |
| P0 | `LLM_PROVIDER`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_REVIEW_MODEL_ID` | key is secret | `bedrock`, `ap-south-1`, key, inference-profile ID. Without a reviewer **every bounty is held** (`MODEL_UNAVAILABLE`) |
| — | `LIVE_PURCHASES_ENABLED` | no | leave `false` until G |
| — | `BITREFILL_BASE_URL` `PORT` `APPROVAL_TTL_SECONDS` `WORKER_INTERVAL_MS` `LLM_REVIEW_MAX_CALLS_PER_PR` `AI_REVIEW_MIN_CONFIDENCE` `AI_REVIEW_MAX_AGE_SECONDS` `AI_ALLOW_PRIVATE_REPOSITORIES` `BEDROCK_MAX_*` | no | defaults `https://api.bitrefill.com/v2`, `3001`, `900`, `2000`, `6`, `0.8`, `3600`, `false`, `2048`/`120000` are correct. The base URL must stay exactly that |

Other variables found in code are test-only: `TEST_DATABASE_URL`, `MOCK_COST_CENTS`, and `GITHUB_API_URL`/`GITHUB_WEB_URL` (mock/GHES hooks). Leave them unset.

## C. Invalid or expired credentials

None can be judged: no credential is configured. Known risks to check when you add them:

* The **GitHub client secret** was exposed earlier. Generate a new one and delete the old one (M5 step 9). Unverifiable from here.
* **Bedrock**: Codex's attempts got 429 (Haiku) and 403 (Sonnet) with a key that is not on this machine any more. A 403 is ambiguous (A11).

## D. External provider configuration

| Pri | Component | Task | Status | Who | Verification | Blocks |
|---|---|---|---|---|---|---|
| P0 | GitHub App | Callback/Setup/Webhook URLs, permissions, events, webhook secret, private key, new client secret (M5) | not done; webhook URL is believed to still be the placeholder `https://example.com/buyoncue-webhook-disabled`, which is **not working** | you | `npm run audit:config:probe` → `github-app` rows PASS, incl. "webhook URL" | OAuth, all PR events |
| P0 | GitHub App | Install on the demo repo (M6) | unverified (needs key) | you | probe row "installation on demo repo" PASS | evidence collection |
| P0 | Demo repo | CI workflow on `pull_request` + ruleset requiring it + label (M7) | **missing** (A10) | you | probe rows `demo-repo` PASS | every bounty is held `REQUIRED_CI_MISSING` |
| P0 | AWS Bedrock | API key, model access, exact inference-profile IDs (M8) | not configured | you | `npm run check:bedrock:review -- --confirm-metered` → `"status":"PASS"` | AI review |
| P0 | Bitrefill | Personal API key, USD balance (M9) | not configured | you | `npm run check:live` → `"bitrefill":{"status":"PASS","currency":"USD",…}` | catalogue and purchase |

## E. Human Telegram / GitHub account actions

| Pri | Task | Exact action | PASS looks like |
|---|---|---|---|
| P0 | Owner ID | open @buyoncueBot → `/start` → `/whoami` | bot replies with your user ID = chat ID; put it in `TELEGRAM_OWNER_USER_ID`, restart chat |
| P0 | Contributor reachable | contributor (a **second** Telegram account) opens @buyoncueBot → `/start` → `/whoami` | their ID → engine `AUTHORIZED_RECIPIENT_CHAT_ID`; `npm run check:live` shows `recipientPrivateChatVerified: true` |
| P0 | Second GitHub account | the contributor needs their own GitHub account (self-rewards are blocked by policy) | can open a PR on the demo repo |
| P0 | Maintainer link | owner: `/connectgithub` → Connect GitHub → sign in → install/confirm → pick repo | "Connected: `UserAkku/<repo>`" |
| P0 | Contributor link | contributor: `/linkgithub` → sign in → Confirm | "✅ Linked GitHub `<login>` (ID …)" |

## F. Deployment / tunnel tasks

| Pri | Task | Action | Verify |
|---|---|---|---|
| P0 | HTTPS for chat (port 3002) | `brew install cloudflared` then `cloudflared tunnel --url http://localhost:3002` (keep running) | `curl -s https://<host>/healthz` → `{"ok":true…}`; probe row "PUBLIC_CHAT_URL/healthz" PASS |
| P0 (live only) | HTTPS for engine (port 3001) | second terminal: `cloudflared tunnel --url http://localhost:3001` → `PUBLIC_ENGINE_URL` | `curl -s https://<host2>/health` |
| P1 | Quick-tunnel URLs change on every restart | if a tunnel restarts, update `PUBLIC_CHAT_URL`, `GITHUB_OAUTH_CALLBACK_URL` and the 3 GitHub App URLs, then restart chat | probe "webhook URL" PASS |
| P2 | `.env` permissions | `chmod 600 services/chat/.env services/engine/.env` | audit "(.env permissions)" rows disappear |
| P2 | Postgres after reboot | `LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D /opt/homebrew/var/postgresql@16 -o "-p 5432 -c listen_addresses=127.0.0.1" start` | probe "connect with engine DATABASE_URL" PASS |

## G. Live verification that needs your explicit spending authorization

Not done and **must not be done without you saying so in chat**:

1. Set `LIVE_PURCHASES_ENABLED=true`, an https `PUBLIC_ENGINE_URL` and `AUTHORIZED_RECIPIENT_CHAT_ID`, then restart the engine (it prints `mode=live`).
2. One rule with the smallest INR package and caps you accept (e.g. per-purchase $2, daily $3, monthly $5, auto-approve $0 so you tap **Approve**).
3. One qualifying merged PR, one invoice, one payment.
4. Record the real invoice ID, the individual order `delivered`, and the contributor's private message (blur the code).
5. If anything shows `PAYMENT_UNCERTAIN`, **do not retry**: the engine reconciles the original invoice.

## H. Hackathon submission (from `docs/SUBMISSION.md`)

| Pri | Item | Status |
|---|---|---|
| P0 | Real Bitrefill invoice ID in the submission | NOT TESTED; requires G |
| P0 | Demo video (2–4 min, codes blurred, no `.env` on screen) | not recorded |
| P0 | Submission text updated with real evidence only (`docs/SUBMISSION.md` still says "PactPilot" and "NOT TESTED") | pending; update after G |
| P1 | PR #7 (and this PR) merged into the branch you submit, or submit the release branch URL | open |
| P1 | Lanes: Rails and Guardrails · No Prompt Required (already listed) | ready |

---

## Manual action cards (in the order you should do them)

Each card: where · navigation · what to click · variable · value source · secret? · format · restart? · verify command · PASS · common failure.

### M1 — Telegram bot token
* **Where:** Telegram app → chat with **@BotFather**.
* **Navigation:** `/mybots` → **buyoncueBot** → **API Token**. Use **Revoke current token** if it was ever pasted anywhere.
* **Variable:** `TELEGRAM_BOT_TOKEN` in `services/chat/.env`. **Secret.** Format `123456789:AA…`.
* **Restart:** chat service.
* **Verify:** `npm run check:live` → `"telegram":{"status":"PASS","username":"buyoncueBot","webhookConfigured":false,…}`.
* **Common failure:** `webhookConfigured: true` means long polling won't receive messages. Open `https://api.telegram.org/bot<TOKEN>/deleteWebhook` once, in your own browser only.

### M2 — Shared secrets (generate locally; nothing is printed)
* **Where:** your terminal, at the repo root. **Secret.** No restart needed (nothing is running yet).

```bash
T=$(openssl rand -hex 32); printf 'INTERNAL_API_TOKEN=%s\n' "$T" >> services/chat/.env; printf 'INTERNAL_API_TOKEN=%s\n' "$T" >> services/engine/.env; unset T
```

```bash
printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> services/chat/.env
```

```bash
printf 'REDEMPTION_ENCRYPTION_KEY=%s\nDATABASE_URL=postgresql://buyoncue_app@127.0.0.1:5432/buyoncue_dev\nPUBLIC_ENGINE_URL=http://localhost:3001\nLIVE_PURCHASES_ENABLED=false\n' "$(openssl rand -hex 32)" >> services/engine/.env
```

```bash
chmod 600 services/chat/.env services/engine/.env
```

* **Verify:** `npm run audit:config`. PASS = "INTERNAL_API_TOKEN identical in both services PASS"; `REDEMPTION_ENCRYPTION_KEY` and `DATABASE_URL` show `PRESENT_AND_VALID`.
* **Common failure:** running the token line twice appends two different tokens (the last one wins in each file, so they may still match). Re-run the audit, and if in doubt delete the duplicate lines in your editor.

### M3 — Start both services and get your owner ID
```bash
cd services/engine && npm start
```
```bash
cd services/chat && npm start
```
* Telegram: open **@buyoncueBot** → `/start` → `/whoami` → copy the number into `TELEGRAM_OWNER_USER_ID` → restart chat.
* **Verify:** `npm run audit:config:probe` → `engine GET /health PASS`, `chat GET /healthz (local) PASS`, `owner private chat reachable PASS`.
* **Common failure:** chat exits with `Invalid configuration: … GITHUB_WEBHOOK_SECRET` → M2 not done in the chat file.

### M4 — HTTPS tunnel for the chat service
* `brew install cloudflared`, then `cloudflared tunnel --url http://localhost:3002`. Copy `https://<random>.trycloudflare.com`.
* **Variables (not secret):** `PUBLIC_CHAT_URL=https://<host>`, `GITHUB_OAUTH_CALLBACK_URL=https://<host>/auth/github/callback`, `GITHUB_APP_INSTALL_URL=https://github.com/apps/buyoncue/installations/new`.
* **Restart:** chat (after M5 is done, because the GitHub variables are all-or-none).
* **Verify:** `curl -s https://<host>/healthz` → `{"ok":true,...}`.

### M5 — GitHub App settings (BuyOnCue, ID 5609798)
* **Where:** github.com → your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **BuyOnCue** → **Edit**.
* **General tab:**
  1. **Callback URL:** `https://<host>/auth/github/callback`. It must match `GITHUB_OAUTH_CALLBACK_URL` exactly.
  2. **Request user authorization (OAuth) during installation:** **unchecked** (GitHub forbids a Setup URL otherwise).
  3. **Setup URL:** `https://<host>/auth/github/install/callback`, and tick **Redirect on update**.
  4. **Webhook → Active:** checked. **Webhook URL:** `https://<host>/webhooks/github`. This replaces `https://example.com/buyoncue-webhook-disabled`.
  5. **Webhook secret:** paste the same value as `GITHUB_WEBHOOK_SECRET`. Read it in your own terminal with `grep ^GITHUB_WEBHOOK_SECRET services/chat/.env`, and don't screenshot it.
  6. **SSL verification:** Enable.
* **Permissions & events tab:**
  7. Repository permissions **Read-only**: Pull requests, Checks, Commit statuses, Issues, Metadata (mandatory). Everything else **No access**, with no write permissions.
  8. Subscribe to events: **Pull request**. Save; accept the permission change on the installation if GitHub asks.
* **Back on General:**
  9. **Client secrets → Generate a new client secret** → copy to `GITHUB_APP_CLIENT_SECRET` (**secret**) → **Delete** the old secret.
  10. **Private keys → Generate a private key** → a `.pem` downloads. Move it out of Downloads to a stable place outside the repo: `mkdir -p ~/.buyoncue && mv ~/Downloads/buyoncue.*.private-key.pem ~/.buyoncue/github-app.pem && chmod 600 ~/.buyoncue/github-app.pem`. Then set `GITHUB_APP_PRIVATE_KEY_PATH=/Users/Akhilesh/.buyoncue/github-app.pem`.
* **Also set:** `GITHUB_APP_ID=5609798`, `GITHUB_APP_CLIENT_ID=Iv23ligq8KkwCysuqvO9`. **Restart chat.**
* **Verify:** `npm run audit:config:probe`. PASS = `App JWT authentication PASS (app "buyoncue")`, `read permissions granted PASS`, `pull_request events subscribed PASS`, `webhook URL PASS`, `webhook SSL verification PASS`. Then on the App's **Advanced** tab → **Recent Deliveries** → **Redeliver** the latest ping: the response must be **200/202, not 401**. A 401 means the webhook secret differs from `GITHUB_WEBHOOK_SECRET`.
* **Common failure:** `GET /app → HTTP 401` means the key belongs to another app, was deleted, or your system clock is wrong.

### M6 — Install the App on the demo repository
* **Where:** `https://github.com/apps/buyoncue/installations/new` → your account → **Only select repositories** → pick the demo repo → **Install**. Easiest is to let `/connectgithub` lead you there (M10).
* **Verify:** probe rows `installation on demo repo PASS`, `can read branch rules (required checks) PASS`, `GraphQL review threads readable PASS`.

### M7 — Demo repository CI, required check and label (currently missing)
Use a **small, separate demo repo**, recommended over `UserAkku/buyoncue` itself. Pass it to the audit with `--repo`.
1. Add `.github/workflows/ci.yml`:
   ```yaml
   name: ci
   on: [pull_request]
   jobs:
     test:
       name: test
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - run: echo "replace with your real test command"
   ```
   Merge it to `main` and open any PR, so the check `test` runs once.
2. Repo → **Settings → Rules → Rulesets → New ruleset → New branch ruleset**: name `require-ci`; Enforcement **Active**; Target branches **Include default branch**. Tick **Require status checks to pass** → **Add checks** → `test`. Optionally tick **Require a pull request before merging**. **Create**.
3. Repo → **Issues → Labels → New label** → `reward-ready`.
* **Verify:** `node scripts/audit-config.mjs --probe --repo <owner>/<demo-repo>`. PASS = `CI workflow exists`, `ruleset requires a status check`, `required check names match real check runs`, `label "reward-ready" exists`.
* **Common failure:** the ruleset names `ci` while the job reports `test`. The required name must equal the **check-run name** shown on the PR.

### M8 — AWS Bedrock (ap-south-1)
* **Where:** AWS console, region **Asia Pacific (Mumbai) ap-south-1** → **Amazon Bedrock**.
  1. **Model access** (left nav, if shown in your console): request/enable **Anthropic Claude Haiku 5.5** and **Claude Sonnet 5.5**, then wait for "Access granted".
  2. **Inference → Cross-region inference** (inference profiles): copy the exact **Inference profile ID** for each model (a `global.` or `apac.` ID). `global.anthropic.claude-sonnet-5-5` / `global.anthropic.claude-haiku-5-5` are **unverified guesses**; use the IDs the console shows.
  3. **API keys** → **Generate long-term API key** (short expiry, e.g. 1–7 days). Copy it once into **both** `.env` files as `AWS_BEARER_TOKEN_BEDROCK` (**secret**). Note the IAM policy it gets: it needs `bedrock:InvokeModel` (Converse) on those profiles. Don't widen it to `*`.
  4. **Service Quotas → Amazon Bedrock**: check on-demand requests/tokens per minute for those profiles in ap-south-1. The earlier 429 suggests a near-zero quota; request an increase if it shows 0.
* **Variables:** chat `LLM_PROVIDER=bedrock`, `AWS_REGION=ap-south-1`, `BEDROCK_CHAT_MODEL_ID=<haiku profile ID>`. Engine: same plus `BEDROCK_REVIEW_MODEL_ID=<sonnet profile ID>`. Restart both.
* **Verify (each makes ONE small metered call; run only if you accept the cost):** `npm run check:bedrock:chat -- --confirm-metered` and `npm run check:bedrock:review -- --confirm-metered`. PASS = `"status":"PASS"`. The review prints a `totalScore` validated by the engine's rubric.
* **Reading failures:** `ACCESS_DENIED` → check the key first (invalid keys also give 403), then model access and IAM. `MODEL_NOT_FOUND`/`VALIDATION` → wrong profile ID for this region. `THROTTLING_OR_QUOTA` → quota. `INCORRECT_REGION_OR_DNS` → region. `APPLICATION_PARSE` → the model answered but its output failed our schema (report it; that's our side).

### M9 — Bitrefill
* **Where:** bitrefill.com → sign in → your account's developer/API settings (Personal API; exact menu labels may differ, and Bitrefill's API docs link to it) → create a key. Confirm your mentor credits show as **account balance in USD**: the engine pays only with `payment_method: balance` and compares USD.
* **Variable:** `BITREFILL_API_KEY` in `services/engine/.env` (**secret**). Restart the engine.
* **Verify:** `npm run check:live` (read-only: ping, balance currency, India catalogue search). PASS = `"bitrefill":{"status":"PASS","currency":"USD","inStockIndianFixedPackageFound":true,…}`. Also `npm run audit:config:probe` → `balance currency is USD`.
* **Common failure:** HTTP 401 means an Affiliate/other key type rather than a Personal API key. A non-USD balance blocks payment.

### M10 — Link accounts and configure one bounty (no spending)
* Owner in Telegram: `/connectgithub` → **Connect GitHub** → sign in as `UserAkku` → install on the demo repo if asked → **Confirm** → tap the repository. Expect "Connected: `UserAkku/<repo>`".
* Contributor (second Telegram + second GitHub account): `/start`, then `/linkgithub` → sign in → **Confirm**. Expect "✅ Linked GitHub …".
* Owner: `/setbounty`. Steps:
  1. Label `reward-ready`.
  2. Search `flipkart` (or `amazon`) and pick the product.
  3. **1** tier, score **50**, the **smallest** package.
  4. Caps: per-purchase `2`, daily `3`, monthly `5`, auto-approve `0`.
  5. Tap **✅ Enable bounty**.
* Contributor opens a PR (real code change + test). The owner applies `reward-ready`, or approves the PR. CI must be green.
* `/review <PR#>` should show the score, rubric lines and "provisional". Merge only in G.

---

## Critical-path plan (dependency order, shortest safe route)

**Recommendation given ~6 hours to the deadline:** run two lanes. **Lane 1** is the validated fixed-reward flow: Telegram rule → plain repo webhook on a labelled merge → purchase. It needs only Telegram + PostgreSQL + Bitrefill + one tunnel, and is the fastest route to the **real invoice ID** the submission needs. **Lane 2** (AI bounty) adds the GitHub App, Bedrock and CI ruleset. Never enable both a fixed rule and a bounty policy for the same repo and label, or one merge pays twice: pause the fixed rule before testing Lane 2 on that repo.

| # | Step | Depends on | Who | Est. |
|---|---|---|---|---|
| 1 | M2 shared secrets + engine DB line | — | you | 5 min |
| 2 | M1 bot token → M3 start engine and chat, `/whoami` → owner ID | 1 | you | 10 min |
| 3 | M9 Bitrefill key → `npm run check:live` (catalogue + USD balance) | 1 | you | 10 min |
| 4 | Contributor `/start` → `AUTHORIZED_RECIPIENT_CHAT_ID` | 2 | you + contributor | 5 min |
| 5 | M4 tunnel for chat (and engine for live) | 2 | you | 10 min |
| 6 | **Lane 1:** repo webhook (repo → Settings → Webhooks → `https://<host>/webhooks/github`, JSON, `GITHUB_WEBHOOK_SECRET`, *Pull requests*), `/newrule` in test mode, merge a labelled PR → `TEST MODE` delivery | 3, 4, 5 | you | 15 min |
| 7 | M5 + M6 GitHub App, M7 demo repo CI/ruleset/label | 5 | you | 30 min |
| 8 | M8 Bedrock → both `check:bedrock:* -- --confirm-metered` PASS | 1 | you (approve cost) | 20–60 min |
| 9 | M10 link both accounts, `/setbounty`, PR, `/review` (test mode) | 7, 8 | you + contributor | 20 min |
| 10 | **Explicit authorization in chat**, then G: live mode, one purchase (Lane 1, or Lane 2 if 9 passed), Approve | 6 (or 9) | you | 15 min |
| 11 | Verify delivered order + recipient message, copy invoice ID, `npm run audit:config:probe` → "no unresolved uncertain payments" | 10 | you | 5 min |
| 12 | Record video, update `docs/SUBMISSION.md` with real evidence only, submit | 11 | you | 45 min |

If step 8 is still blocked by AWS at ~21:00 IST, submit with Lane 1's real purchase. Present the AI bounty as **integrated and E2E-tested with a scripted reviewer**, with Bedrock access pending. Don't claim real AI scoring.

## Test baseline (this branch)

| Suite | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| Engine (Vitest, real PostgreSQL) | 135 passed |
| Chat (Vitest) | 100 passed |
| Integration (`node:test`) | 69 passed = 40 baseline + 24 AI-bounty E2E + 5 audit-config |
| **Total** | **304 passed, 0 failed** (the 299 release baseline preserved, plus 5 new) |

## Known limitations of this audit

* The GitHub App's real permissions, installation, webhook URL/secret and SSL setting can only be read with its private key (not present). The `example.com` placeholder is reported as *believed current*, not verified.
* Bedrock model-ID validity, quotas and access could not be checked without credentials, and model invocations are metered and need your approval.
* The durable database uses Homebrew's default **trust** authentication on `127.0.0.1`: fine for a local demo, not for a shared or hosted machine.
