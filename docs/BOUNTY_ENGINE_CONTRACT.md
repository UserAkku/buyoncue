# Bounty engine contract (chat → engine)

The endpoint **paths** are fixed by the product spec. The product spec's request/response schemas were not in the repository when the chat side was built, so the **field shapes below are the chat service's working assumption** (typed in `services/chat/src/engine/bounty-types.ts`, implemented by `services/chat/mock-engine/engine.ts`). The engine owner should either adopt them or tell us the differences; responses are parsed leniently (extra fields are fine). Auth and errors are as for the rest of the engine API: `Authorization: Bearer INTERNAL_API_TOKEN`, errors as `{"error":{"code","message"}}`.

| Endpoint | Request → response |
|---|---|
| `POST /v1/github/links` | `{githubUserId, githubLogin, telegramUserId, chatId}` → 201 `{link:{githubUserId, githubLogin, telegramUserId, linkedAt}}`. **409** if that GitHub ID is linked to a *different* Telegram user. Idempotent for the same pair. Both IDs are strings; `githubUserId` is the numeric GitHub ID. |
| `POST /v1/github/links/unlink` ⚠ extension | `{telegramUserId}` → `{ok:true}` (needed by `/unlinkgithub` and authorization revocation) |
| `POST /v1/repositories/connect` | `{ownerChatId, authorizedByGithubUserId, installationId, repositoryId, fullName}` → 201 `{repository:{repositoryId, installationId, fullName, status}}` |
| `GET /v1/repositories?ownerChatId=` | → `{repositories:[{repositoryId, installationId, fullName, status, bountyRule?:{id,status,name}}]}` |
| `POST /v1/repositories/:id/disconnect` ⚠ extension | `{reason}` → `{ok:true}` (sent when GitHub access is removed; 404/405 tolerated) |
| `POST /v1/bounty-rules` | `{ownerChatId, repositoryId, name, requiredLabel\|null, tiers:[{name, minScore, productId, packageId}], perPurchaseCapUsdCents, dailyCapUsdCents, monthlyCapUsdCents, autoApproveUpToUsdCents}` → 201 `{bountyRule:{id, status:"draft", …}}` |
| `POST /v1/bounty-rules/:id/enable\|pause\|resume` ⚠ assumption | `{ownerChatId}` → `{bountyRule}` (mirrors `/v1/rules/:id/*`; the spec lists no enable endpoint) |
| `POST /v1/contributions/review` | `{idempotencyKey, purpose:"provisional"\|"final", repositoryId, prNumber, headSha, supersedesReviewId\|null, evidence}` → 202 `{review}` (never pays) |
| `GET /v1/contributions/:reviewId` | → `{review:{reviewId, status, repositoryId, prNumber, headSha, provisional, score:{total, max, breakdown:[{category, score, max}]}\|null, candidateTier\|null, summary, finalization:{status, tier, purchaseId, invoiceId, reason}\|null}}` |
| `POST /v1/contributions/:reviewId/finalize` | `{idempotencyKey, expectedHeadSha, mergedAt, evidence}` → `{review}` (engine must 409 if `expectedHeadSha` ≠ the reviewed commit) |

Notes for the engine:

- `evidence` is the object built in `services/chat/src/github/evidence.ts` (`PrEvidence`, `schemaVersion: 1`). It lists `untrustedFields` (PR title, commit first lines, linked-issue titles, patches, filenames): attacker-controlled text that must be treated as data in any LLM prompt. `completeness.issues[]` states honestly what is missing or truncated.
- `review.status` terminal values the chat treats as done: `completed`, `failed`, `error`, `superseded`, `rejected`. A review submitted with `supersedesReviewId` should become `superseded`.
- `finalization.status` strings the chat renders specially: `delivered` (only with an `invoiceId`), `pending_approval`, `purchasing`, `blocked`, `not_eligible`, `author_not_linked`, `failed`. Anything else is shown verbatim. The chat claims delivery **only** for `delivered` + `invoiceId`.
- Approval requests and gift-card delivery keep using the existing `/v1/notifications` outbox (`approvalPurchaseId`, `redemption`) and `POST /v1/approvals/:purchaseId`. A contributor's notification must use their linked **private** chat ID as `chatId`.
- Idempotency: the chat sends `idempotencyKey = "<X-GitHub-Delivery>:review"` and `"…:finalize"`; GitHub redeliveries reuse them.
