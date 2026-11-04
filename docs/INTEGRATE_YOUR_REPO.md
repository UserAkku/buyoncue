# Use BuyOnCue on your own repository

BuyOnCue connects to **any** GitHub repository you can install its GitHub App on. This is the exact path, tested on `UserAkku/buyoncue-demo`.

## What your repository needs (once)

1. **CI that runs on pull requests.** Example: [`.github/workflows/ci.yml`](https://github.com/UserAkku/buyoncue-demo/blob/main/.github/workflows/ci.yml), a job named `test` that really runs your tests.
2. **A ruleset requiring that check.** Repo → *Settings → Rules → Rulesets → New branch ruleset*: enforcement **Active**, target the default branch, tick **Require status checks to pass**, add your check name (it must equal the check-run name shown on a PR, for example `test`). Without a required check, BuyOnCue cannot prove CI is complete and holds every reward.
3. **A label** (for example `reward-ready`). You, the maintainer, apply it to a PR you authorize, or you approve the exact commit.

## Connect it (about 3 minutes)

1. In Telegram, open the bot and send `/connectgithub`. Tap **Connect GitHub**, sign in, install the GitHub App on **one** repository (*Only select repositories*), tap **Confirm**, then tap the repository in Telegram. BuyOnCue checks with GitHub that you are an admin of it.
2. Send `/setbounty`: the label, a gift card from the live Indian catalogue, score tiers (rewards start at 50; 85+ always asks you), and four USD limits you type yourself. It creates a **draft**; tap **Enable bounty** when you are ready. Nothing is bought before that.
3. Contributors send `/linkgithub` to the bot once (sign in with GitHub, tap **Confirm**), so their reward reaches their own private chat.

## What happens on a pull request

| Event | What BuyOnCue does |
|---|---|
| PR opened / updated / labeled | Reads the real diff, commits, reviews and CI for the exact head commit and asks the engine for an AI review. **Nothing is paid.** |
| You apply the label (or approve the exact commit) | That commit becomes authorized. A new push clears it, so you re-authorize the new code. |
| PR merged | Re-reads the merged PR, reviews the final commit, and the engine decides: identity linked, required CI green, authorized by you, confidence, tier, and your limits. |
| Duplicate webhook / redelivery | Cannot pay twice. |

## Check your setup

```bash
node scripts/audit-config.mjs --probe --repo <owner>/<repo>
```

PASS rows to look for: `installation on demo repo`, `CI workflow exists`, `ruleset requires a status check`, `required check names match real check runs`, `label "reward-ready" exists`.

## Honest limits of this version

* **One maintainer per deployment.** The Telegram owner is set in `TELEGRAM_OWNER_USER_ID`; only they configure rules or approve spending. Anyone can link as a contributor. Multi-maintainer tenancy is not built.
* **One reward recipient gate.** The engine pays only to the chat in `AUTHORIZED_RECIPIENT_CHAT_ID`.
* **You host it.** The services run where you run them (local PostgreSQL, a public HTTPS URL for GitHub webhooks).
* **AI scoring needs a reviewer** (Amazon Bedrock key). Without one every review is held as `MODEL_UNAVAILABLE` and nothing is paid.
* **Real purchases** need `LIVE_PURCHASES_ENABLED=true`, a funded Bitrefill balance in USD and your explicit decision. Test mode never spends.
