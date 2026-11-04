# AI bounty demo (3–4 minutes)

**Story:** *"I connect my repo once. A contributor opens a PR, the bot reviews the real diff and CI, I merge, and a real gift card reaches the contributor privately."*

## Preflight (off camera)

- [ ] Engine running with the bounty endpoints ([BOUNTY_ENGINE_CONTRACT.md](BOUNTY_ENGINE_CONTRACT.md)); decide **mock vs real** (below).
- [ ] Chat service running with GitHub App variables; `GET /healthz` ok; tunnel URLs match the app settings.
- [ ] Two Telegram accounts started with the bot: the owner (maintainer) and a contributor. A second GitHub account for the contributor, a test repository with the app **not yet installed**, and a CI workflow that runs on PRs.
- [ ] Small limits you're happy to really spend; blur redemption codes on any recording.

## Script

| Time | Do | Say |
|---|---|---|
| 0:00 | Owner: *"Connect my GitHub repository and reward good contributions automatically."* | "Natural language, no commands to remember." |
| 0:15 | Tap **Connect GitHub**, sign in, install the app on **one** repo, **Confirm** the account-link page, pick the repo. | "Read-only GitHub App. The bot verified I'm an admin of that repo with GitHub itself, not because I typed a name." |
| 0:50 | `/setbounty`: label, Flipkart, 2 tiers (60 / 80), type the four USD limits. Show **DRAFT**, tap **Enable bounty**. | "Every limit is typed by me; the AI sets none." |
| 1:30 | Contributor: `/linkgithub` → GitHub → Confirm. | "Their immutable GitHub ID is bound to their Telegram account. Nobody types a username." |
| 1:50 | Contributor opens a PR with the label. Owner's bot shows the provisional review: per-category scores, total, candidate tier. | "Scores come straight from the engine. It says *provisional*; nothing is paid on an open PR." |
| 2:20 | Push another commit. | "A new commit supersedes the old review." |
| 2:35 | Approve and **merge** the PR. | "Merge is the only trigger. The bot re-reads the PR from GitHub, re-collects evidence on the final commit, and asks the engine to finalize." |
| 2:55 | If above the auto-approve limit, tap **Approve**. Then the contributor's chat receives the gift card; owner sees *Bounty delivered … invoice ID*. | "Delivery is only announced after the engine confirms the order. Redemption goes to the contributor's private chat only." |
| 3:20 | **Redeliver** the merge webhook in GitHub; `/bounties`. | "Idempotent: no second payment. Everything is auditable." |

## Mock vs real

| | Mock (`npm run mock-engine` + test suite) | Real |
|---|---|---|
| Engine | Fake scores, instant "AI", fake `MOCK-…` invoices and codes | Engine's AI scoring and Bitrefill purchase |
| GitHub | Local fake server in tests only | Real app, real webhooks |
| Spending | None | Real money if `LIVE_PURCHASES_ENABLED=true` on the engine |

Never show a `MOCK-…` ID as a "real invoice" in the submission. As of this writing the whole flow has been exercised only against mocks.

## Manual test procedure (no spending)

1. Keep the engine in test mode (`LIVE_PURCHASES_ENABLED=false`).
2. Walk the script above. Expect `test_purchase_delivered` messages labelled *TEST MODE*.
3. Check: `/bounties` shows the score; Recent Deliveries are 202; a Redeliver shows `duplicate`; removing the repo from the installation makes the bot report revoked access.
