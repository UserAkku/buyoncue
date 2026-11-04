import type { Product, Rule } from "../engine/types.js";
import { bold, code, esc } from "../html.js";
import { formatDenomination, formatUsd } from "../money.js";
import type { Button } from "./types.js";

export interface RuleView {
  id: string;
  name: string;
  status: string;
  repository: string;
  requiredLabel: string;
  what: string;
  recipientChatId: string;
  perPurchase?: number;
  daily?: number;
  monthly?: number;
  autoApprove?: number;
}

export function ruleView(rule: Rule, product?: Product): RuleView {
  const pkg = product?.packages.find((p) => p.packageId === rule.packageId);
  const what = product
    ? `${product.name}${pkg ? " " + formatDenomination(pkg.value, product.currency) : ""} gift card (${product.country})`
    : `product ${rule.productId ?? "?"}`;
  return {
    id: rule.id,
    name: rule.name ?? "Untitled rule",
    status: rule.status,
    repository: rule.repository ?? "?",
    requiredLabel: rule.requiredLabel ?? "?",
    what,
    recipientChatId: rule.recipientChatId ?? "?",
    perPurchase: rule.perPurchaseCapUsdCents ?? undefined,
    daily: rule.dailyCapUsdCents ?? undefined,
    monthly: rule.monthlyCapUsdCents ?? undefined,
    autoApprove: rule.autoApproveUpToUsdCents ?? undefined,
  };
}

const usd = (c?: number) => (c === undefined ? "?" : formatUsd(c));

export function renderRule(v: RuleView, ownerChatId: string): string {
  const who = v.recipientChatId === ownerChatId ? "you (this chat)" : `private chat ${code(v.recipientChatId)}`;
  return [
    `🧾 ${bold(v.name)} — ${bold(v.status.toUpperCase())}`,
    `<b>When:</b> a PR is merged in ${code(v.repository)} with label ${code(v.requiredLabel)}`,
    `<b>Then:</b> buy ${esc(v.what)}`,
    `<b>Deliver to:</b> ${who}`,
    `<b>Limits (USD):</b> ${usd(v.perPurchase)} per purchase · ${usd(v.daily)} daily · ${usd(v.monthly)} monthly`,
    v.autoApprove === 0
      ? `<b>Approval:</b> every purchase waits for your tap`
      : `<b>Approval:</b> up to ${usd(v.autoApprove)} runs automatically; above that I ask you first`,
  ].join("\n");
}

/** Which action button fits a rule status. Engine status vocabulary beyond "draft" is assumed, see FEEDBACK.md. */
export function ruleActionButtons(v: RuleView): Button[] {
  const s = v.status.toLowerCase();
  if (s === "draft") return [{ text: "✅ Enable Rule", data: `en:${v.id}` }];
  if (s === "paused") return [{ text: "▶️ Resume", data: `rs:${v.id}` }];
  if (["archived", "disabled", "deleted"].includes(s)) return [];
  return [{ text: "⏸ Pause", data: `pa:${v.id}` }];
}
