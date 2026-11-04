# GitHub App setup

PactPilot reads pull requests through a **GitHub App**, not a personal access token. The app is read-only: it can't push code, edit PRs or merge anything. This page was written against GitHub's current docs ([creating](https://docs.github.com/en/apps/creating-github-apps), [authenticating](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app), [installing your own app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)). GitHub's UI changes; if a label differs slightly, follow the docs.

## 0. You need a public HTTPS URL first

GitHub calls your webhook and redirects browsers to your callback, so `localhost` won't work. Start a tunnel and note its URL (call it `https://CHAT_HOST`). See [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md#local-https-tunnel).

## 1. Create the app

GitHub → your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.

| Field | Value |
|---|---|
| GitHub App name | Anything unique, e.g. `buyoncue-yourname` (note the slug in the URL) |
| Homepage URL | Your repo URL |
| **Callback URL** | `https://CHAT_HOST/auth/github/callback` |
| Expire user authorization tokens | **Keep checked** (our tokens are also revoked right after use) |
| Request user authorization (OAuth) during installation | **Leave unchecked.** We send you through OAuth ourselves after install. (GitHub also forbids a Setup URL when this is checked.) |
| Enable Device Flow | Unchecked |
| **Setup URL** | `https://CHAT_HOST/auth/github/install/callback` |
| Redirect on update | Checked |
| Webhook → Active | **Checked** |
| **Webhook URL** | `https://CHAT_HOST/webhooks/github` |
| **Webhook secret** | A random string: `openssl rand -hex 32`. Put the same value in `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enabled |
| Where can this app be installed? | **Only on this account** for the hackathon |

### Permissions (all read-only)

*Repository permissions*

| Permission | Access | Why |
|---|---|---|
| Metadata | Read-only | Mandatory for every app; repository identity, collaborator role checks |
| Contents | Read-only | Context files referenced by a diff |
| Pull requests | Read-only | PR state, files and patches, commits, reviews |
| Checks | Read-only | Check-run results for the head commit |
| Commit statuses | Read-only | Legacy CI statuses for the head commit |
| Issues | Read-only | Titles/labels of issues a PR says it closes |

Everything else stays **No access**. Do **not** grant Contents or Pull requests *write*, and don't grant Administration. (Because we have no Administration permission we can't read classic branch-protection settings; see "Required checks" below.)

### Subscribe to events

Tick **Pull request** only (this also delivers `labeled`/`unlabeled`, which is how a maintainer's label is bound to the exact head commit). Installation, repository-removal and authorization-revoked events are delivered to every GitHub App automatically. Check-run events are not needed: the final evidence is re-collected from GitHub when a PR merges, and `/review` re-collects on demand.

`installation`, `installation_repositories` and `github_app_authorization` are sent to every GitHub App automatically (GitHub's webhook docs: they can't be subscribed to or unsubscribed from). PactPilot uses them to stop work when access is removed.

Click **Create GitHub App**.

## 2. Collect the credentials

On the app's settings page:

1. **App ID** → `GITHUB_APP_ID`.
2. **Client ID** (starts `Iv1.` or `Iv23`) → `GITHUB_APP_CLIENT_ID`.
3. **Generate a new client secret** → copy it **now** → `GITHUB_APP_CLIENT_SECRET`.
4. **Generate a private key** → a `.pem` downloads. Put it in `.env` as a single line with `\n` escapes (or base64):
   ```bash
   awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.private-key.pem   # paste the output as GITHUB_APP_PRIVATE_KEY
   ```
   Keep the `.pem` out of the repo (`*.pem` is git-ignored). Treat it like a password: anyone holding it can act as the app on every installation.
5. Remaining settings in `services/chat/.env`:
   ```
   GITHUB_OAUTH_CALLBACK_URL=https://CHAT_HOST/auth/github/callback
   GITHUB_APP_INSTALL_URL=https://github.com/apps/<your-app-slug>/installations/new
   PUBLIC_CHAT_URL=https://CHAT_HOST
   ```
   The service refuses to start with a partial configuration and names every missing variable (without printing values). `GITHUB_OAUTH_CALLBACK_URL` must equal `PUBLIC_CHAT_URL` + `/auth/github/callback`.

## 3. Connect a repository (from Telegram)

1. In the bot (as the owner), send `/connectgithub` and tap **Connect GitHub**.
2. Sign in on GitHub. If the app isn't installed yet, the page offers **Install the GitHub App**: choose **Only select repositories** and pick **one** repository, then **Install**. GitHub sends you back (Setup URL) and then through authorization again.
3. A page shows *which GitHub account will be linked to which Telegram account*. Check it and press **Confirm**.
4. In Telegram, pick the repository. The bot re-verifies with GitHub that: the installation exists and isn't suspended, the repository is in it, and **you are an admin** of it. Only then is it saved through the engine.

Security properties of this flow (all covered by tests): single-use random session, `state` single-use and expiring, an HttpOnly cookie binds the callback to the browser that started it, the OAuth code is exchanged server-side, identity is the numeric GitHub user ID from `GET /user`, the `installation_id` in query strings is never trusted, and the user token is revoked right after use and never stored.

## Required checks

"Required CI status" comes from repository **rulesets** via `GET /repos/{owner}/{repo}/rules/branches/{branch}`. GitHub's reference page for that endpoint doesn't list a fine-grained permission for it, and we have not verified it against a real installation, so treat it as best effort: when it can't be read, evidence says `requiredChecks: null` and flags `required_checks_unknown` instead of guessing. Classic branch protection isn't readable without Administration access, which we deliberately don't request. Check runs and commit statuses for the head commit are always collected.

## Revoking access safely

- **Stop everything for a repo:** GitHub → Settings → Applications → Installed GitHub Apps → *your app* → Configure → remove the repository (or **Uninstall**). The `installation_repositories` / `installation` webhook makes PactPilot mark the repo revoked locally (hard stop), pause its bounty rule through the engine's owner-checked pause route, ignore further PR events for it, and message the owner. If the engine could not confirm the pause, the message says so, and the engine still refuses to finalize anything whose installation or rule state no longer matches.
- **A contributor unlinks:** `/unlinkgithub` in Telegram, or revoke the app under GitHub → Settings → Applications → Authorized GitHub Apps (`github_app_authorization` webhook unlinks them).
- **Rotate secrets:** generate a new client secret / private key in the app settings, update `.env`, restart, then delete the old ones.
- **Emergency:** *Pause rewards* in the bot, or suspend the app on GitHub.

## What makes a PR payable (and what the demo repository needs)

A merged PR is rewarded only if the engine agrees on **all** of: the author linked their numeric GitHub ID (`/linkgithub`); the connected maintainer authorized the exact final head commit (they applied the policy label themselves, or approved that commit with all review threads resolved); every *required* check reported success for that commit; the merged-PR AI review is confident and above the lowest tier; the policy is enabled; and spending limits hold.

Because the app has no Administration permission, "required checks" are read from **repository rulesets**. Create a ruleset on the default branch with *Require status checks to pass* (for example your `ci` workflow). Without one, the bot cannot prove CI is complete and the engine holds the reward (`REQUIRED_CI_MISSING`). This has not yet been verified against a real installation.
