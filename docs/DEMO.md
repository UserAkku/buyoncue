# BuyOnCue — live demo script (2–3 minutes)

**Story:** *"I set a rule once. After that, merging a PR is the only thing I do. Watch the agent buy and deliver a real gift card."*

This is a prospective script, not evidence that a live purchase has occurred. Complete [the payment preflight](BASELINE_VERIFICATION.md#real-payment-preflight-explicit-owner-authorization-required) first. Product and denomination examples below must be replaced with actual available catalogue selections.

## Before you go live (not on camera)

- [ ] Real engine running with live purchasing configured per the engine README, and a funded account. Check `/status` in the bot shows the mode you expect.
- [ ] Chat service running; `curl localhost:3002/healthz` returns ok.
- [ ] GitHub webhook shows a green `ping` delivery.
- [ ] Test repo has an **open PR** carrying the label (e.g. `reward-ready`), ready to merge.
- [ ] Spending limits to type on camera: per-purchase **$2**, daily **$5**, monthly **$20**, auto-approve **$1.50**. Agree limits before the demo; if the actual quote exceeds them, stop rather than raise caps merely to complete the demonstration.
- [ ] Hide `.env`, tokens and anything private; do not show redemption codes on a public recording (blur the code, show only the invoice ID).

## Script

| Time | You do | You say |
|---|---|---|
| 0:00 | Open Telegram, bot chat. | "BuyOnCue is a Telegram agent that buys gift cards on its own, but only inside limits I set." |
| 0:10 | Send: *Whenever a PR with the reward-ready label is merged in acme/app, send a ₹50 Flipkart gift card, subject to my spending limits.* | "One sentence. No forms." |
| 0:25 | Tap the real **Flipkart** result from the catalog list. | "The product comes from Bitrefill's live catalog, never from the model. It can't invent IDs." |
| 0:35 | Tap **Me (this chat)**, then enter `2`, `5`, `20`, `1.50` for the four limits. | "Every limit is typed by me. The AI never sets money." |
| 0:55 | Point at the summary: **DRAFT**, tap **✅ Enable Rule**. | "It's a draft until I enable it. This is my one authorization." |
| 1:05 | Switch to GitHub; **merge the PR**. | "Now I do nothing in Telegram." |
| 1:15 | Bot: *"GitHub PR #… has been merged. Checking your spending policy."* | "Signed webhook received. The engine decides, not the chat bot." |
| 1:25 | Bot: approval request **or** auto-processing. If it asks, tap **Approve**. | "Above my $1.50 threshold it asks me. Below, it runs by itself. Hard cap is $2." |
| 1:45 | Bot: *"🎁 Purchase delivered. Invoice: …"* | "Only now, after the engine confirms real delivery, does it say delivered. Here's the real Bitrefill invoice ID." (Show invoice; blur the code.) |
| 2:05 | GitHub → webhook → **Recent Deliveries → Redeliver** the same delivery. | "Same event again…" |
| 2:15 | Bot: *"♻️ Duplicate trigger detected… No second purchase made."* | "Idempotent. No double spend." |
| 2:30 | `/status` | "Everything is auditable: purchases, invoice IDs, engine mode. Rails and Guardrails, and no prompt required." |

## If something goes wrong

- **No bot reply after merge:** check the webhook delivery in GitHub (red = signature/URL problem) and the chat logs for `trigger_forwarded`.
- **Duplicate message not shown:** the bot shows it when the engine's trigger `reason` contains "duplicate"; otherwise rely on the engine's own notification.
- **Rehearsal without spending:** run against the mock (`npm run mock-engine`). Its invoice IDs are prefixed `MOCK-`; never use them in the recording or submission.
