# Local setup — what's done and what's left

Updated 4 Nov 2026. `.env` files stay on this machine only, are never committed, and no value is printed by any script here.

## Done automatically (verified)
- `.env` duplicates removed. The value already in use (dotenv keeps the last one) was kept; nothing was regenerated, and the shared token still matches. Non-secret defaults were added. Both files are mode 600.
- GitHub App values staged in `services/chat/.env.github-app.pending`: ID, client ID, install URL, public URL, callback. Two items are missing: client secret and private key.
- PostgreSQL 16 on 127.0.0.1:5432, database `buyoncue_dev`, migrations 001–003: **PASS**.
- Engine running from your real `.env`, TEST mode, `/health` → `livePurchasesEnabled:false`: **PASS**.
- Demo repo **https://github.com/UserAkku/buyoncue-demo** (public): real tests, CI job `test` passing, label `reward-ready`, ruleset `require-ci` (requires `test` from GitHub Actions, plus a PR before merge), issue #1, contributor branch `contributor/fix-discount-bounds`. Audit probes: all **PASS**.
- HTTPS tunnel `https://norman-actors-walk-filed.trycloudflare.com` → local port 3002, verified with HTTP 200. The URL changes if the tunnel restarts; then run `npm run env:public-url -- <new url>`.

## Your steps, in order (each command prompts for the value hidden; nothing goes to history)
1. **Telegram:** in @BotFather open `/mybots` → buyoncueBot → API Token, then `npm run env:set -- chat TELEGRAM_BOT_TOKEN`. Start chat: `cd services/chat && npm start`. Send `/start` and `/whoami` to the bot, then `npm run env:set -- chat TELEGRAM_OWNER_USER_ID` and restart chat.
2. **Bitrefill:** create a key at https://www.bitrefill.com/account/developers, then `npm run env:set -- engine BITREFILL_API_KEY`. Restart the engine, then `npm run check:live`. PASS = `currency: USD`.
3. **GitHub App:** github.com → Settings → Developer settings → GitHub Apps → BuyOnCue → Edit.
   - Callback `https://norman-actors-walk-filed.trycloudflare.com/auth/github/callback`
   - Setup URL `…/auth/github/install/callback`, with Redirect on update ON
   - Request OAuth during installation OFF
   - Webhook Active, URL `…/webhooks/github`, SSL verification ON
   - Webhook secret = the value of `GITHUB_WEBHOOK_SECRET` in `services/chat/.env`
   - Permissions read-only: Pull requests, Checks, Commit statuses, Issues, Metadata; event: Pull request
   - **Generate a new client secret**, delete the old one, then `npm run env:set -- chat GITHUB_APP_CLIENT_SECRET`
   - **Generate a private key**, then `npm run env:github-key -- ~/Downloads/<file>.pem`
   - Then `npm run env:github-activate`, restart chat, and run `node scripts/audit-config.mjs --probe --repo UserAkku/buyoncue-demo`
4. **Contributor:** a second Telegram account sends `/start` and `/whoami` → `npm run env:set -- engine AUTHORIZED_RECIPIENT_CHAT_ID`. A second GitHub account forks buyoncue-demo and opens a PR from `contributor/fix-discount-bounds`.
5. **Bedrock:** AWS console → ap-south-1 → Bedrock → copy the inference-profile IDs and create an API key → `npm run env:set -- both AWS_BEARER_TOKEN_BEDROCK` (this turns Bedrock on). Then tell me "approve metered test", and I'll run `npm run check:bedrock:chat -- --confirm-metered` and `npm run check:bedrock:review -- --confirm-metered`.
6. **Real purchase:** only after you say so explicitly in chat.

## Still blocked
Telegram token, Bitrefill key, GitHub App secret and key, recipient ID, Bedrock key. Nothing was spent; live mode is off.
