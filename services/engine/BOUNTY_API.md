# AI contribution bounty engine — adapter contract

This extension reuses the fixed-reward engine, PostgreSQL ledger, two-stage Bitrefill payment, owner approvals, reconciliation and encrypted notification outbox. Fixed-rule request/response bodies remain compatible. All changes are under `services/engine`.

All endpoints below require `Authorization: Bearer INTERNAL_API_TOKEN` and return the existing `{ "error": { "code", "message" } }` error format. They are **internal service APIs**, not browser/Telegram-user APIs. The shared bearer token authorizes the trusted integration adapter to attest GitHub identities and evidence. Possession of that token is a powerful trust boundary.

## Trust and service ownership

The engine does not implement OAuth, GitHub App signing, public GitHub webhooks, PR fetching or Telegram commands. The chat/GitHub adapter must:

1. Bind GitHub OAuth state to the actual authenticated Telegram user/private chat, validate CSRF/state, exchange the code server-side, and obtain numeric ID/login from GitHub's authenticated `/user`. Never accept `githubUserId`, `telegramUserId` or `verificationSource` from arbitrary user text as proof.
2. Verify the installation through GitHub App APIs, enumerate its authorized repositories, verify the current user's maintainer/write access through GitHub APIs, then call repository connect. **`verifiedOwnerAccess: true` is an attestation from that server-side adapter, not independent proof.** The engine checks OAuth-linked owner identity and prevents ownership/installation replacement; it cannot reconstruct GitHub permissions from a boolean.
3. Collect actual PR metadata, complete files/patches, commits, required checks, reviews and linked issue evidence under that installation. Supply exact numeric repository/author IDs. Never infer CI success from missing results or assume an arbitrary label is maintainer-controlled.
4. Bind maintainer authorization to the **exact current PR head SHA**. For label authorization, retain the verified label event's actor, permissions, timestamp and PR head from the signed event, or obtain an equivalent verified event record. Do not copy the current SHA onto an older label that an author can apply. Only the connected policy owner's numeric GitHub identity is an authorized maintainer in this MVP. For review authorization, include the actual current `APPROVED` maintainer review and resolved feedback.
5. Re-fetch the merged PR before finalization. Use `pull_request.head.sha`, **not** a different merge-commit SHA. Required checks must apply to that exact reviewed head.
6. Verify the linked recipient's private Telegram chat and ability to receive this bot's messages. Keep the engine's `AUTHORIZED_RECIPIENT_CHAT_ID` set to the one pre-linked contributor for the live MVP. Contributors must start the bot privately first.

No PR-provided text, model output, author-applied label or username is sufficient to authorize a reward. A numeric identity link, authorized installation, same-head maintainer signal, final merged review, CI, confidence and deterministic policy must all agree.

## Identity and repositories

`POST /v1/github/links` → HTTP 201 `{ "link": { "telegramUserId", "githubUserId", "githubLogin", "verificationSource", "verifiedAt", "createdAt" } }`.

```json
{"telegramUserId":"456","githubUserId":202,"githubLogin":"contributor","verificationSource":"github_oauth","verifiedAt":"2026-11-04T12:00:00Z"}
```

One positive private Telegram ID maps to one numeric GitHub ID, and vice versa. Same identity may refresh its verified login/time; username changes do not change payout identity. Conflicting ownership returns 409. Future verification timestamps are rejected. Link the maintainer through the same endpoint before connecting their repository.

`POST /v1/repositories/connect` → HTTP 201 `{ "repository": ... }`.

```json
{"ownerTelegramUserId":"123","repositoryId":303,"repositoryFullName":"owner/repo","installationId":404,"verifiedOwnerAccess":true,"repositoryPrivate":false}
```

The maintainer must already have a verified GitHub identity. Repository names are canonicalized to lowercase; numeric repository and installation IDs are authoritative. The same verified owner/installation may refresh a renamed repository. Ownership, installation or visibility cannot be silently changed. `repositoryPrivate` defaults to **true** if omitted; the adapter should always supply actual GitHub visibility.

`GET /v1/repositories?ownerTelegramUserId=123` → `{ "repositories": [...] }`.

## Draft bounty policy

`POST /v1/bounty-rules` → HTTP 201 `{ "rule": { "id", "status":"draft", "kind":"bounty", "mode":"ai_contribution_bounty", "policyVersion":1, "tiers":[...], ... } }`.

```json
{
  "ownerTelegramUserId":"123", "repositoryId":303, "requiredLabel":"reward-ready",
  "mode":"ai_contribution_bounty", "requireMerged":true, "requireSuccessfulCI":true,
  "scoreThreshold":50,
  "tiers":[
    {"minScore":50,"maxScore":69,"faceValueINR":50,"productId":"COPY_REAL_IN_PRODUCT_ID","packageId":"COPY_EXACT_50_PACKAGE"},
    {"minScore":70,"maxScore":84,"faceValueINR":100,"productId":"COPY_REAL_IN_PRODUCT_ID","packageId":"COPY_EXACT_100_PACKAGE"},
    {"minScore":85,"maxScore":100,"faceValueINR":200,"productId":"COPY_REAL_IN_PRODUCT_ID","packageId":"COPY_EXACT_200_PACKAGE","requiresApproval":true}
  ],
  "autoApproveUpToUsdCents":150,"perPurchaseCapUsdCents":300,"dailyCapUsdCents":500,"monthlyCapUsdCents":1000,
  "allowSelfReward":false
}
```

The IDs/denominations above are explanatory placeholders, not catalogue entries. Every tier is independently verified against an exact real catalogue product with `country=IN`, `currency=INR`, matching package ID and face value. Unknown/mismatched packages are rejected. Out-of-stock known tiers are stored with `enabled:false` and a reason. No alternative reward is fabricated. Tiers are sorted by score; inclusive bands must not overlap. Gaps cause HOLD. Threshold cannot be below 50. Hard limits satisfy `automatic <= per-purchase <= daily <= monthly`.

One immutable version-1 bounty policy per repository is supported in this MVP. There is no in-place policy-edit, disabled-tier rehabilitation, or ownership-transfer endpoint. A policy change needs a separately reviewed version/migration, rather than an implicit overwrite of standing authority. `allowSelfReward` defaults false and must be explicitly enabled by the owner at policy creation if desired; the recipient still must be pre-linked. Scores of **85 or above always require owner approval**, even if the submitted tier omits `requiresApproval` or the USD charge is below the automatic threshold.

`GET /v1/bounty-rules?ownerTelegramUserId=123` → `{ "rules": [...] }`, including cached tier verification/disabled states.

Use existing owner-checked routes to enable/pause/resume:

- `POST /v1/rules/:ruleId/enable` with `{ "ownerChatId":"123" }`
- `POST /v1/rules/:ruleId/pause` with the same body
- `POST /v1/rules/:ruleId/resume` with the same body

At least one still-available approved tier is required for enable/resume. Draft/paused policies cannot finalize a purchase. The legacy `/v1/triggers/github` endpoint intentionally handles **fixed rules only**; it cannot bypass AI review for a bounty policy. Route bounty events through review/finalize, and pause any legacy fixed rule for the same demo trigger unless the owner explicitly wants both independent rewards. Uniqueness is per rule, not across separately authorized policies.

## Exact PR evidence schema

The authoritative Zod schemas and limits are in `src/bounty/schemas.ts`. Unknown fields are rejected. IDs are positive safe integers; SHAs are 40 or 64 hex characters. Content is data, never executable instructions. All nested arrays must be supplied, including empty arrays when no evidence exists.

`POST /v1/contributions/review` accepts:

```json
{
  "installationId":404,"repositoryId":303,"repositoryFullName":"owner/repo","repositoryPrivate":false,
  "prNumber":42,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "authorGithubUserId":202,"authorLogin":"contributor","authorIsBot":false,
  "merged":false,"collectedAt":"2026-11-04T12:00:00Z",
  "title":"Fix authorization","description":"Fixes the linked issue and adds regression coverage.",
  "labels":["reward-ready"],
  "files":[{"path":"src/reward.ts","status":"modified","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\n-return true;\n+return authorized;","patchTruncated":false}],
  "commits":[{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","message":"Fix authorization"}],
  "checks":[{"id":1,"name":"tests","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"completed","conclusion":"success","required":true}],
  "reviews":[{"id":1,"reviewerGithubUserId":101,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"APPROVED","body":"Reviewed the fix.","feedbackResolved":true}],
  "linkedIssues":[{"number":7,"title":"Authorization bug","body":"Unapproved rewards must be blocked.","state":"closed"}],
  "evidenceTruncated":false,"ciComplete":true,
  "maintainerAuthorization":{"actorGithubUserId":101,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","label":"reward-ready","verifiedWriteAccess":true,"source":"github_api_label_event","authorizedAt":"2026-11-04T11:59:00Z"}
}
```

Supply current timestamps and real SHAs/IDs; this fixture is illustrative and expires.

| Nested field | Exact accepted shape / rules |
| --- | --- |
| `files` | Up to 100 unique `path`s (300 chars), `status`: `added/modified/removed/renamed`, integer nonnegative `additions/deletions`, `patch`: string up to 50,000 chars or null, `patchTruncated`: boolean default false |
| `commits` | Up to 100 unique `sha`s; `message` up to 5,000 chars |
| `checks` | Up to 100 unique numeric `id`s; `name`, exact `headSha`, `status`: `queued/in_progress/completed`, nullable `conclusion`: `success/failure/cancelled/timed_out/neutral/skipped/action_required/stale`, `required`: boolean |
| `reviews` | Up to 100 unique numeric `id`s, numeric reviewer ID, exact `headSha`, `state`: `APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED/PENDING`, `body` up to 10,000 chars, boolean `feedbackResolved` |
| `linkedIssues` | Up to 20 unique issue numbers in the connected repository, `title` up to 500 chars, `body` up to 15,000 chars, `state`: `open/closed` |
| `maintainerAuthorization` | null or the exact typed object above; `source`: `github_api_label_event` or `github_api_review`; the latter also requires the corresponding actual current approved/resolved owner review |

`authorIsBot` defaults **true**, `repositoryPrivate` defaults **true**, `ciComplete` defaults **false**, and missing maintainer authorization defaults null. Omitting these attestations therefore cannot accidentally pass policy. `ciComplete=true` is valid only after the adapter has enumerated all required checks/statuses and verified branch requirements. A required check that is absent, queued, pending, failed, skipped, neutral, inconclusive or from another SHA is not success. A policy with `requireSuccessfulCI:false` explicitly waives the requirement to have at least one check; any check still marked required must succeed.

The route accepts at most 1 MiB. More than 50 files, over 120,000 serialized evidence characters, missing patch context, truncation or future evidence produce a review HOLD without calling the model. Known private source is not sent to an external inference service unless `AI_ALLOW_PRIVATE_REPOSITORIES=true` was deliberately configured.

Response: HTTP 202 `{ "reviewId":"uuid", "state":"QUEUED", "eligibilityState":"HOLD" }`. Poll `GET /v1/contributions/:reviewId`. Reviews are durable jobs; identical normalized/redacted evidence is idempotent. Fresh evidence (including updated `collectedAt`) supersedes older reviews, even at the same SHA. Old results cannot be revived by a slow in-flight model response. A process interruption during model work becomes `NEEDS_REVIEW` after its lease expires; refetch and resubmit fresh evidence to re-analyze.

The GET response is a flat object:

```json
{
  "reviewId":"uuid","ruleId":"uuid","policyVersion":1,"repositoryId":303,"prNumber":42,
  "headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","authorGithubUserId":202,
  "state":"REVIEWED","eligibilityState":"ELIGIBLE","reasons":[],
  "score":75,"subscores":{"correctness":25,"tests":20,"feedback":15,"maintainability":10,"security":5},
  "confidence":0.95,"findings":[{"severity":"info","message":"Evidence supports the fix.","evidenceRefs":["file:src/reward.ts","check:1","review:1"]}],
  "reasoningSummary":"Evidence-linked explanation","riskFlags":[],
  "candidateTier":{"tier":2,"minScore":70,"maxScore":84,"faceValueINR":100,"productId":"verified-id","packageId":"verified-package","requiresApproval":false,"enabled":true},
  "model":"configured-model","validUntil":"2026-11-04T13:00:00Z"
}
```

Before completion, score/subscores/confidence/summary are null and findings/risk flags empty. `state` is `QUEUED`, `REVIEWING`, `REVIEWED`, `NEEDS_REVIEW`, `LOW_CONFIDENCE` or `STALE`. `eligibilityState` is `HOLD` or `ELIGIBLE`; it does not itself create or pay an invoice. Confidence, CI, identity, label/maintainer, bot/self-reward, freshness and tier issues appear in `reasons`. Low confidence and critical/manual model holds do not expose an actionable candidate tier. Expired reviews report HOLD.

Model scores use the specified 30/25/20/15/10 rubric. Integer component bounds and the exact sum are validated. Findings can reference only `goal`, `file:<path>`, `commit:<sha>`, `check:<id>`, `review:<id>`, or `issue:<number>` that actually exist. Positive test/review scores require current check/maintainer evidence and citations. Trivial/whitespace-only changes cannot support a score at or above 50. Critical findings, invalid output, missing evidence or model failure cannot trigger a reward. `recommendedTier` is advisory: deterministic backend bands alone select the approved product/package; unknown advisory tiers or extra amount/product fields invalidate the output.

## Final merged review and finalization

Opened/updated PRs may be reviewed but cannot be paid. **On merge, collect fresh final evidence and submit a new review with `merged:true`**, even if the head SHA is unchanged. Wait for review completion. This verifies final code, checks and maintainer evidence instead of treating an earlier open-PR analysis as final.

After re-fetching the genuinely merged PR, call:

```text
POST /v1/contributions/:reviewId/finalize
```

```json
{"githubDeliveryId":"ACTUAL-GITHUB-DELIVERY-ID","repositoryId":303,"prNumber":42,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merged":true}
```

- Different final SHA → HTTP 200, `accepted:false`, `state:STALE`, `eligibilityState:HOLD`, reason `FINAL_SHA_MISMATCH`. Re-analysis is required. Repository/PR mismatch is HTTP 409.
- Missing eligibility or draft/paused policy → HTTP 200, `accepted:false`, HOLD reasons. Verified merged HOLD events are persisted for audit/restart recovery. Resolving a hold requires a fresh trusted finalize call; it is not an implicit instruction to purchase later.
- Eligible → HTTP 202 `{ "accepted":true,"reviewId":"uuid","reason":"queued","awardId":"uuid","purchaseId":"uuid" }`.
- Repeated/same-PR finalization → HTTP 202 with `reason:"duplicate_pr"` and original award/purchase IDs. The unique identity is `(rule_id, repository_id, pr_number)`, not a delivery ID or repository name. A reused delivery ID for another PR/SHA returns 409. Held same-PR/SHA events may bind to a superseding final review before an award exists.

One immutable purchase snapshot stores the selected tier product, package, face value, linked author's Telegram recipient and forced-approval flag. All tiers share the **same rule ledger**, so concurrent tier choices cannot multiply daily/monthly budgets. Before invoice creation, approval and payment intent, the executor checks that the review is still eligible/current/unexpired and the linked numeric author still maps to that recipient. Stock and denomination are rechecked; unavailable tiers are disabled without substitution.

The executor creates one unpaid balance invoice, obtains exact USD charge, atomically reserves funds, enforces caps and approval, checks authenticated sufficient USD account balance, then pays that original invoice. Face value is never compared with USD spending limits. Required owner approvals use the existing `/v1/approvals/:purchaseId` endpoint and expiration. Neither approval nor the model can override hard caps, stale reviews or quality/identity holds.

After payment intent is committed, exceptions remain `PAYMENT_UNCERTAIN` and reconcile the original invoice. No duplicate invoice/payment is attempted. A failed/uncertain award also cannot be recreated by another webhook: one reward attempt remains attached to its stable identity for audit/operator review. Later review invalidation cannot undo a submitted payment; reconciliation continues to protect delivery of already paid goods.

## Receipt and notifications

`GET /v1/bounty-receipts/:purchaseId` → `{ "receipt": ... }`, containing repository ID/name, PR number, reviewed SHA, author GitHub ID, AI review ID, score, deterministic tier and INR face value, rule ID/policy version, selected package, recipient chat ID, purchase ID/mode/status, **real invoice ID when available**, actual USD cents, invoice status and individual order IDs/statuses. No redemption code, PIN, link or provider body is included.

Only authenticated invoice and individual-order delivery, including the expected bounty denomination, allow private redemption to enter the existing encrypted outbox. The owner receives a separate redacted receipt when different from the recipient. Review outcome and bounty-queued notifications contain only IDs, scores and controlled reason strings. New types `contribution_reviewed` and `bounty_queued` work with the existing chat relay's text rendering.

All new endpoints are private internal APIs. The adapter must treat model findings as untrusted plain text, escape UI/Telegram markup, and expose only an authorized, redacted subset to any public UI. Do not publish raw model findings or private source excerpts merely because the receipt itself has no codes.

## Separate environments and Claude handoff

Keep `services/chat/.env` separate from `services/engine/.env`; only the random `INTERNAL_API_TOKEN` is intentionally shared. Engine-local variables:

```makefile
DATABASE_URL=
INTERNAL_API_TOKEN=
BITREFILL_API_KEY=
BITREFILL_BASE_URL=https://api.bitrefill.com/v2
PUBLIC_ENGINE_URL=
LIVE_PURCHASES_ENABLED=false
PORT=3001
# Preserve baseline encryption and pre-linked-recipient gates:
REDEMPTION_ENCRYPTION_KEY=
# AUTHORIZED_RECIPIENT_CHAT_ID=VERIFIED_PRIVATE_CONTRIBUTOR_ID
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
AI_REVIEW_MIN_CONFIDENCE=0.8
AI_REVIEW_MAX_AGE_SECONDS=3600
AI_ALLOW_PRIVATE_REPOSITORIES=false
```

The chat environment owns Telegram and GitHub App/OAuth credentials (`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, callback/install/public-chat URLs). **Claude's adapter should standardize on `GITHUB_APP_PRIVATE_KEY_PATH` for a local `.pem` file**, read the file to obtain PEM contents, and pass the contents—not the pathname string—to its signing library. Do not send that path, PEM, OAuth tokens or installation tokens to this engine or the reviewer. No chat files were changed by this implementation, and no direct external Claude session was available to message; this file is the concrete integration handoff.

Engine scoring uses its own optional `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` values. `LLM_BASE_URL` is the OpenAI-compatible API base (typically ending `/v1`); the engine appends `/chat/completions`, requests JSON output, uses no tools and refuses redirects. HTTPS is required except local development origins. Missing/incomplete settings produce `MODEL_UNAVAILABLE`/`NEEDS_REVIEW`, never a fabricated score. Slow model work runs independently of payment reconciliation.

Codex/Claude subscriptions do **not** provide BuyOnCue runtime API credits. Before the live demo, the owner must provision a separately billed supported inference endpoint, confirm model availability, billing and quota with that provider, and authorize a non-financial review smoke test. These were not verified without runtime credentials.

Redaction covers obvious bearer/GitHub/OpenAI/AWS/bot token patterns, secret assignments and PEM private-key blocks **before storage and inference**, and model results are redacted too. This is best effort, not a complete secret scanner: split, encoded or unusual secrets can evade detection. The trusted adapter must omit repository secrets/configuration and redact sensitive content upstream. Private-source inference is disabled by default; enabling it requires explicit repository-owner consent to that inference provider's data handling. The engine never checks out PRs, installs their dependencies, executes their code or runs AI-proposed commands.

## Verification and remaining live prerequisites

```sh
cd services/engine
npm ci
npm run migrate
LIVE_PURCHASES_ENABLED=false TEST_DATABASE_URL=postgresql://localhost/pactpilot_engine_test npm test
npm run typecheck
npm run build
npm start
```

Tests use real migrated isolated PostgreSQL schemas and real HTTP requests to these routes, with fake GitHub evidence, model responses and Bitrefill payments. All fake invoices have `TEST-MOCK-` or `test:` IDs. Fixed-value regression tests and the unchanged integrated baseline are also rerun. Simulated delivery is never evidence of a paid bounty.

Still required for a live bounty: Claude's actual OAuth/App/evidence/UI integration; verified owner and contributor private chats; real installation/repository access; a genuine maintainer-authorized merged event and complete successful CI; actual available INR packages; funded Bitrefill Personal API credentials; configured provider model/billing/quota; persistent application database and HTTPS callbacks; and explicit owner authorization to enable live spending under the reviewed rule. No live purchase or merge is performed by this change.
