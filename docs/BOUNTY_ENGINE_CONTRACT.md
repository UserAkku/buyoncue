# Bounty engine contract (chat ↔ engine)

**The canonical contract is [`services/engine/BOUNTY_API.md`](../services/engine/BOUNTY_API.md)** and the Zod schemas in `services/engine/src/bounty/schemas.ts`. An earlier version of this file described a *guessed* contract; it was wrong in every shape and has been replaced. The chat service now speaks the canonical API, and `tests/integration/ai-bounty-e2e.test.ts` proves it over real HTTP against the real engine and PostgreSQL.

## How the chat adapter maps onto it

| Chat action | Engine call |
|---|---|
| OAuth confirm (maintainer or contributor) | `POST /v1/github/links` `{telegramUserId, githubUserId:number, githubLogin, verificationSource:"github_oauth", verifiedAt}` |
| `/unlinkgithub`, GitHub `github_app_authorization` revoked | `POST /v1/github/links/unlink` `{telegramUserId}` (added with this release; soft revoke) |
| Repository picked (admin verified via GitHub with the installation token) | `POST /v1/repositories/connect` `{ownerTelegramUserId, repositoryId, repositoryFullName, installationId, verifiedOwnerAccess:true, repositoryPrivate}` |
| `/repositories` | `GET /v1/repositories` + `GET /v1/bounty-rules` (joined by repository ID) |
| `/setbounty` | `POST /v1/bounty-rules` (tiers carry `minScore/maxScore/faceValueINR/productId/packageId/requiresApproval`; INR/India catalogue only) |
| Enable / pause / resume | `POST /v1/rules/:id/(enable\|pause\|resume)` `{ownerChatId}` |
| PR opened/updated/labeled/reopened | `POST /v1/contributions/review` with the exact evidence document (`merged:false`) |
| PR merged | fresh `POST /v1/contributions/review` (`merged:true`), poll `GET /v1/contributions/:id` until settled, then `POST /v1/contributions/:id/finalize` `{githubDeliveryId, repositoryId, prNumber, headSha, merged:true}` |
| Reward status | `GET /v1/bounty-receipts/:purchaseId` |
| Approvals / delivery / receipts | existing `/v1/approvals/:id`, `/v1/notifications` + ack |

## Attestations the chat adapter makes (the engine trusts the bearer token for these)

* `verifiedOwnerAccess:true` only after GitHub itself reported `admin` for that numeric user ID on that repository, with the installation token, immediately before connecting.
* `maintainerAuthorization` only when the connected maintainer's numeric ID has write access per GitHub **and** either a signed `labeled` webhook from that actor bound to the current head SHA, or an `APPROVED` review by that actor on the current head with all review threads resolved.
* `ciComplete:true` only when the required checks were enumerated from rulesets, none were truncated/unreadable, and every required context reported for the exact head SHA. Otherwise `false` (the engine then holds).
* `evidenceTruncated:true` whenever anything was cut, unreadable or rate-limited.
* `authorIsBot`, `repositoryPrivate` exactly as GitHub reports them. Private source is not sent to a model unless the engine owner enabled `AI_ALLOW_PRIVATE_REPOSITORIES`.

Not forwarded to the engine: OAuth/installation tokens, the GitHub App private key, webhook secrets.
