# Telegram setup and local HTTPS tunnel

## 1. Create the bot

1. In Telegram open **@BotFather** → `/newbot` → choose a name and a username ending in `bot` (the demo bot is `@buyoncueBot`).
2. Copy the token into `services/chat/.env` as `TELEGRAM_BOT_TOKEN`. Never paste it in chat, commits or recordings.
3. Optional polish: `/setdescription`, `/setuserpic`. Commands (`/connectgithub`, `/linkgithub`, …) are registered at startup via `setMyCommands`; the list is in `src/bot/bot.ts`.
4. **Polling or webhook, not both.** This service uses **long polling** for Telegram. Do not call `setWebhook` for this bot. If you ever did, run `https://api.telegram.org/bot<TOKEN>/deleteWebhook` once.

## 2. Find your owner ID

Start the service with `TELEGRAM_OWNER_USER_ID` empty, message the bot `/whoami`, put the printed user ID into `.env`, restart. The owner is the only maintainer: only they can connect repositories, set bounty policies, enable/pause rewards or approve purchases, and only in their own private chat.

Contributors (anyone) can use `/linkgithub`, `/unlinkgithub`, `/myrewards` in a private chat. They cannot see or change policies.

Telegram refuses to message users who never started the bot, so every contributor must send the bot `/start` once.

## Local HTTPS tunnel

Telegram "URL" buttons and GitHub redirects need a public HTTPS URL pointing at port 3002.

```bash
# Option A: Cloudflare quick tunnel (no account)
cloudflared tunnel --url http://localhost:3002
# Option B: ngrok
ngrok http 3002
```

Copy the `https://…` URL and use it as `PUBLIC_CHAT_URL` and in the GitHub App's Callback URL, Setup URL and Webhook URL ([GITHUB_APP_SETUP.md](GITHUB_APP_SETUP.md)). Quick-tunnel URLs change on every restart, so update `.env` **and** the three GitHub App URLs each time (or use a named tunnel / ngrok reserved domain).

## 3. Run

```bash
cd services/chat
npm install
cp .env.example .env     # fill it in
npm run dev              # or: npm run build && npm start
```

Startup logs say whether the GitHub App is enabled and whether `/newrule` is in `ai` or `guided` mode. Check `curl http://localhost:3002/healthz`.

## 4. Verify the webhook is live

GitHub → your app → **Advanced** → **Recent Deliveries**. After installing, open or push to a PR in the connected repository. A delivery with HTTP **202** means it was verified and accepted; **401** means the webhook secret doesn't match `GITHUB_WEBHOOK_SECRET`. Use **Redeliver** to test duplicate handling (the second one reports `duplicate`).
