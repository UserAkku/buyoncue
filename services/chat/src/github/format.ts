import type { ContributionReview } from "../engine/bounty-types.js";
import { bold, code, esc } from "../html.js";
import type { ReviewRecord } from "../state.js";

/** Telegram text for an engine review. Every number and label comes from the engine response. */
export function renderReview(review: ContributionReview, rec: Pick<ReviewRecord, "prNumber" | "repositoryFullName" | "incompleteReasons">): string {
  const head = `🔎 ${bold(`PR #${rec.prNumber}`)} in ${code(rec.repositoryFullName)}`;
  const status = review.status.toLowerCase();
  const lines: string[] = [];

  if (status === "failed" || status === "error") {
    lines.push(`${head}\n❌ The review failed${review.summary ? `: ${esc(review.summary.slice(0, 300))}` : "."} No reward will be considered from this run.`);
  } else if (status === "superseded") {
    lines.push(`${head}\n♻️ This review was superseded by a newer commit.`);
  } else if (!review.score) {
    lines.push(`${head}\n⏳ Review status: ${bold(review.status)}. I'll message you when the score is ready.`);
  } else {
    lines.push(`${head} reviewed.`, "");
    for (const c of review.score.breakdown) lines.push(`${esc(c.category)}: ${c.score}/${c.max}`);
    lines.push("", bold(`Total: ${review.score.total}/${review.score.max}`));
    lines.push(`Candidate bounty: ${review.candidateTier ? bold(review.candidateTier) : "none (below the lowest tier)"}`);
    if (review.summary) lines.push("", `<i>${esc(review.summary.slice(0, 400))}</i>`);
  }

  if (rec.incompleteReasons.length) {
    lines.push("", `⚠️ Evidence was incomplete: ${rec.incompleteReasons.map(esc).join("; ")}`);
  }
  if (review.score && review.provisional !== false && !review.finalization) {
    lines.push("", "This is provisional until the final merged commit is verified.");
  }
  return lines.join("\n");
}

const FINAL_TEXT: Record<string, string> = {
  pending_approval: "⏸ Waiting for your approval. Use the Approve / Reject message.",
  purchasing: "🛒 Purchasing. I'll confirm only once the order is delivered.",
  blocked: "🚫 Blocked by a spending guardrail.",
  not_eligible: "ℹ️ Not eligible for a reward.",
  author_not_linked: "🔗 The author hasn't linked a GitHub account (/linkgithub), so no reward was sent.",
  failed: "⚠️ The purchase failed. Nothing was delivered.",
};

/** Outcome message after a merged PR was finalized. "Delivered" is claimed only for a confirmed order. */
export function renderFinalization(review: ContributionReview, rec: Pick<ReviewRecord, "prNumber" | "repositoryFullName">): string {
  const f = review.finalization;
  const tier = f?.tier ?? review.candidateTier ?? "—";
  if (f && f.status.toLowerCase() === "delivered" && f.invoiceId) {
    return [`🎁 ${bold("Bounty delivered.")}`, "", `PR: #${rec.prNumber}`, `Bounty tier: ${esc(tier)}`, `Bitrefill invoice: ${code(f.invoiceId)}`, `Status: Delivered`].join("\n");
  }
  const status = f?.status ?? review.status;
  const text = FINAL_TEXT[status.toLowerCase()] ?? `Status: ${esc(status)}`;
  return [
    `🏁 ${bold(`PR #${rec.prNumber} merged`)} in ${code(rec.repositoryFullName)}. Final verification done.`,
    `Bounty tier: ${esc(tier)}`,
    text,
    f?.reason ? `Reason: ${esc(f.reason.slice(0, 300))}` : "",
  ].filter(Boolean).join("\n");
}
