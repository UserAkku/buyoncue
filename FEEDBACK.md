# FEEDBACK

A running log of real problems, ambiguities and suggestions found while building the **chat service**. Entries are only things actually encountered. Nothing here claims an end-to-end test that was not run.

**Verification status (2026-11-04):** the chat service was built and tested against a local mock of the frozen engine contract (`services/chat/mock-engine`). The real engine, a live Telegram bot, a live GitHub webhook and Bitrefill have **not** been exercised from this service yet. So there are no observations about the Bitrefill API itself in this file; the chat service never calls it. The engine developer should append Bitrefill-specific findings.

| ID | Area | Type | What happened | Workaround in chat service | Suggestion |
|---|---|---|---|---|---|
| F-01 | Engine contract: rules | Ambiguity | Only `draft` is named as a rule status. The values after enable/pause/resume are not specified. | Treat `draft` → show *Enable*, `paused` → *Resume*, `archived`/`disabled`/`deleted` → no button, anything else → *Pause*. | Document the status enum. |
| F-02 | Engine contract: notifications/triggers | Ambiguity | Only `purchase_delivered` is named as a notification `type`; trigger `reason` only shows `queued` as an example. | Delivered receipts use our template (and only for that exact type); every other type renders the engine's `text`, HTML-escaped, with an icon guessed from the type name. A trigger `reason` containing "duplicate" shows the duplicate message; unknown reasons stay silent. | Publish the enums for `type` and `reason`. |
| F-03 | Engine contract: rules | Missing capability | No endpoint to edit or delete a draft rule. The bot's *Edit / restart* creates a new draft and leaves the old draft behind. | The old draft is simply never enabled; `/rules` still lists it. | Add `DELETE /v1/rules/:id` for drafts (or `PATCH`). |
| F-04 | Engine contract: triggers | Ambiguity | Repository matching case-sensitivity is unspecified. GitHub's `repository.full_name` preserves case, and users may type `Acme/App`. | The webhook forwards GitHub's value unchanged; the rule stores the repo as the owner typed it. | Engine should compare repositories case-insensitively. Needs confirmation before the live demo. |
| F-05 | Engine contract: rules | Ambiguity | Is `autoApproveUpToUsdCents: 0` valid? The bot lets the owner enter 0 to mean "always ask me". | Sent as-is. Only the mock accepts it so far. | Confirm the accepted range. |
| F-06 | Engine contract: notifications | Ambiguity | Delivery semantics are not stated (at-least-once? are un-acked items returned again? ordering?). | Assumed un-acked items are returned on every poll. The worker keeps an in-memory set of IDs already sent to Telegram so a failed ack never re-sends the message. A restart in that window can repeat one message. | State the semantics; consider an idempotency key. |
| F-07 | Engine contract: errors | Ambiguity | The error body format for non-2xx responses is not specified. | The client looks for a string in `error`, `message` or `reason` (or `error.message`) and shows a truncated, escaped version. | Specify `{ "error": { "code", "message" } }`. |
| F-08 | Engine contract: notifications | Design gap | A notification addressed to a chat the owner never authorized (group, unknown, non-private) cannot be reported as "undeliverable". | The chat service withholds redemption data, tells the owner a notification was withheld, then acks so the queue doesn't clog. | Add a `nack`/failed state so the engine can surface this. |
| F-09 | Product design | Gap | There is no way to learn the USD price of a package before a purchase. Gift-card denominations are in the product currency (e.g. ₹50), but all limits are in USD. | The bot explains this, never converts silently, and asks the owner to pick a USD cap. | Expose an estimated USD price per package in `GET /v1/products/:id`, so the bot can show "≈ $0.60" and sanity-check the cap. |
| F-10 | Product design | Possible duplication | Both the engine (via notifications) and the webhook handler (`"PR merged. Checking your spending policy."`) may tell the owner that a trigger arrived. | The webhook sends its message only for reason `queued` and for duplicates. | Decide which side owns the "trigger received" message once the real engine is wired up. |
| F-11 | Tooling | Minor | `npm install` (npm 11) printed an `install-scripts` warning for esbuild's postinstall. | None needed: `tsx` and `vitest` ran fine afterwards. | n/a |

## Still to verify against real services

- [ ] Real engine: field names/shapes for rules, purchases and notifications match the contract exactly.
- [ ] Real Telegram: inline-button flow, `getChat` returning `private` for the recipient, message formatting.
- [ ] Real GitHub: signed delivery and *Redeliver* produce the duplicate path.
- [ ] End-to-end with a real Bitrefill invoice (engine owner).
