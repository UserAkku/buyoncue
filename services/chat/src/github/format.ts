import type { BountyReceipt, FinalizeResult, ReviewView } from "../engine/bounty-types.js";
import { bold, code, esc } from "../html.js";
import type { ReviewRecord } from "../state.js";

const RUBRIC: [key: string, label: string, max: number][] = [
  ["correctness", "Correctness / issue alignment", 30],
  ["tests", "Tests / CI", 25],
  ["feedback", "Review evidence", 20],
  ["maintainability", "Maintainability", 15],
  ["security", "Security / risk", 10],
];

const REASON_TEXT: Record<string, string> = {
  FINAL_MERGED_REVIEW_REQUIRED: "the merged pull request hasn't been reviewed yet",
  GITHUB_AUTHOR_NOT_LINKED: "the author hasn't linked a GitHub account (/linkgithub)",
  REQUIRED_LABEL_MISSING: "the required label is missing",
  MAINTAINER_AUTHORIZATION_MISSING: "no maintainer authorization for this exact commit (re-apply the label or approve the current commit)",
  MAINTAINER_APPROVAL_NOT_EVIDENCED: "the maintainer approval isn't evidenced",
  REQUIRED_CI_MISSING: "required CI results are missing or incomplete",
  REQUIRED_CI_NOT_SUCCESSFUL: "required CI did not succeed",
  UNRESOLVED_CHANGES_REQUESTED: "a reviewer's change request is unresolved",
  LOW_CONFIDENCE: "the AI reviewer's confidence was too low",
  MANUAL_REVIEW_REQUIRED: "the review needs a human look",
  BELOW_THRESHOLD_OR_NO_TIER: "the score is below the lowest reward tier",
  TIER_DISABLED: "the matching reward tier is unavailable",
  TIER_UNAVAILABLE: "the matching gift card is out of stock",
  BOT_AUTHOR: "bot authors are not rewarded",
  SELF_REWARD_NOT_ALLOWED: "self-rewards are not allowed by this policy",
  RULE_NOT_ENABLED: "the bounty policy isn't enabled",
  OWNER_IDENTITY_REVOKED: "the maintainer's GitHub link was removed",
  EVIDENCE_EXPIRED: "the review expired; it will be redone on the next update",
  EVIDENCE_TRUNCATED: "the evidence was truncated",
  INSUFFICIENT_DIFF_CONTEXT: "the diff was incomplete",
  CHANGE_TOO_LARGE: "the change is too large for automatic review",
  PRIVATE_REPOSITORY_CONSENT_REQUIRED: "this private repository isn't approved for AI review",
  MODEL_UNAVAILABLE: "the AI model was unavailable",
  INVALID_MODEL_OUTPUT: "the AI model returned an unusable answer",
  RECIPIENT_NOT_PRELINKED: "the recipient isn't an authorized private chat",
  FINAL_SHA_MISMATCH: "the merged commit differs from the reviewed commit; it must be reviewed again",
  REVIEW_NOT_READY: "the AI review wasn't finished",
  INSTALLATION_CHANGED: "the app installation changed",
  CATALOGUE_UNAVAILABLE: "the gift-card catalogue was unreachable",
  SUPERSEDED_EVIDENCE: "a newer commit replaced this review",
  REVIEW_INTERRUPTED: "the review was interrupted",
};

/** Reasons come from the engine as controlled codes; unknown codes are still escaped and shown. */
export function describeReasons(reasons: string[]): string {
  return reasons.map((r) => esc(REASON_TEXT[r] ?? r)).join("; ");
}

const inr = (n: number) => `₹${n}`;

/** Telegram text for an engine review. Every number and label comes from the engine response. */
export function renderReview(view: ReviewView, rec: Pick<ReviewRecord, "prNumber" | "repositoryFullName" | "incompleteReasons" | "merged">): string {
  const head = `🔎 ${bold(`PR #${rec.prNumber}`)} in ${code(rec.repositoryFullName)}`;
  const lines: string[] = [];

  if (view.state === "QUEUED" || view.state === "REVIEWING") {
    lines.push(`${head}\n⏳ AI review in progress. I'll message you when the score is ready.`);
  } else if (view.state === "STALE") {
    lines.push(`${head}\n♻️ This review was replaced by newer evidence or a newer commit. No reward will be based on it.`);
  } else if (view.score === null || view.score === undefined) {
    lines.push(`${head}\n⏸ No score: ${view.reasons.length ? describeReasons(view.reasons) : esc(view.state)}. No reward will be considered until this is resolved.`);
  } else {
    lines.push(`${head} reviewed.`, "");
    for (const [key, label, max] of RUBRIC) {
      const v = view.subscores?.[key];
      if (v !== undefined) lines.push(`${esc(label)}: ${v}/${max}`);
    }
    lines.push("", bold(`Total: ${view.score}/100`));
    const c = view.candidateTier;
    lines.push(`Reward tier: ${c ? bold(`Tier ${c.tier} · ${inr(c.faceValueINR)}`) + (c.requiresApproval || view.score >= 85 ? " (needs your approval)" : "") : "none (below the lowest tier, or held)"}`);
    lines.push(`Status: ${view.eligibilityState === "ELIGIBLE" ? bold("eligible once the merged commit is verified") : `${bold("HOLD")} — ${describeReasons(view.reasons)}`}`);
    if (view.confidence !== null && view.confidence !== undefined) lines.push(`Confidence: ${Math.round(view.confidence * 100)}%`);
    for (const f of view.findings.slice(0, 3)) lines.push(`• [${esc(f.severity)}] ${esc(f.message.slice(0, 220))}`);
    if (view.reasoningSummary) lines.push("", `<i>${esc(view.reasoningSummary.slice(0, 400))}</i>`);
    if (!rec.merged) lines.push("", "This is provisional: nothing is paid until the merged commit is re-verified.");
  }
  if (rec.incompleteReasons.length) lines.push("", `⚠️ Evidence was incomplete: ${rec.incompleteReasons.map(esc).join("; ")}`);
  return lines.join("\n");
}

/**
 * "Delivered" is claimed only from a receipt that shows a delivered purchase, a real invoice ID and
 * every individual order delivered. In test mode the wording says so.
 */
export function describeReceipt(r: BountyReceipt): string {
  const orders = r.orders.length > 0 && r.orders.every((o) => (o.status ?? "").toLowerCase() === "delivered");
  if (r.status === "DELIVERED" && r.invoiceId && orders) return `🎁 ${bold("Bounty delivered.")} Invoice ${code(r.invoiceId)}.`;
  if (r.status === "TEST_DELIVERED") return `🧪 TEST MODE: simulated delivery, no real purchase.${r.invoiceId ? ` Reference ${code(r.invoiceId)}.` : ""}`;
  const text: Record<string, string> = {
    QUEUED: "🛒 Queued. The engine is checking limits and will notify you.",
    PENDING_APPROVAL: "⏸ Waiting for your approval. Use the Approve / Reject message.",
    PAYMENT_UNCERTAIN: "⚠️ Payment status is uncertain. The engine will reconcile the original invoice and won't pay again.",
    FAILED: "⚠️ The purchase failed. Nothing was delivered.",
  };
  return text[r.status] ?? `Status: ${esc(r.status)}`;
}

/** Outcome message after a merged PR was finalized. */
export function renderFinalization(result: FinalizeResult, receipt: BountyReceipt | null, view: ReviewView, rec: Pick<ReviewRecord, "prNumber" | "repositoryFullName">): string {
  const head = `🏁 ${bold(`PR #${rec.prNumber} merged`)} in ${code(rec.repositoryFullName)}.`;
  if (result.accepted) {
    const tier = view.candidateTier;
    return [
      head,
      `Score ${view.score ?? "—"}/100${tier ? ` → ${bold(`Tier ${tier.tier} · ${inr(tier.faceValueINR)}`)}` : ""}.`,
      result.reason === "duplicate_pr" ? "♻️ This pull request already has a reward; nothing new was created." : "Reward authorized on the final merged commit.",
      receipt ? describeReceipt(receipt) : "🛒 Queued. The engine is checking limits and will notify you.",
    ].join("\n");
  }
  const reasons = [...new Set([...result.reasons.filter((r) => r !== "REVIEW_NOT_READY" || view.reasons.length === 0), ...view.reasons])];
  return [head, `Final verification: ${bold("no reward")}.`, `Reason: ${reasons.length ? describeReasons(reasons) : esc(result.state ?? "held")}`].join("\n");
}
