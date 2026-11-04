import type { GithubTrigger, TriggerResult } from "./engine/types.js";
import { code } from "./html.js";

/**
 * Owner-facing message for what the engine decided about a trigger, or null to stay quiet.
 * Only structured fields (repo, PR number) are used, never PR titles or bodies.
 * The engine's `reason` strings are not fully specified, so unknown reasons stay silent.
 */
export function triggerNotice(t: GithubTrigger, r: TriggerResult): string | null {
  const reason = (r.reason ?? "").toLowerCase();
  if (reason.includes("duplicate")) return `♻️ Duplicate trigger detected for PR #${t.prNumber}. No second purchase made.`;
  if (r.accepted && reason === "queued") {
    return `🔔 GitHub PR #${t.prNumber} has been merged in ${code(t.repository)}. Checking your spending policy.`;
  }
  return null;
}
