import type { CreateRuleBody } from "../engine/types.js";
import { formatDenomination, formatUsd } from "../money.js";

export type CapKey = "perPurchaseCapUsdCents" | "dailyCapUsdCents" | "monthlyCapUsdCents" | "autoApproveUpToUsdCents";

export interface SelectedProduct {
  id: string;
  name: string;
  country: string;
  currency: string;
}
export interface SelectedPackage {
  packageId: string;
  value: number;
}

export interface RuleDraft {
  name?: string;
  repository?: string;
  requiredLabel?: string;
  /** Search hint from the user/LLM; the product itself must come from the engine catalog. */
  productQuery?: string;
  country?: string;
  desiredValue?: number;
  desiredCurrency?: string;
  product?: SelectedProduct;
  pkg?: SelectedPackage;
  recipientChatId?: string;
  perPurchaseCapUsdCents?: number;
  dailyCapUsdCents?: number;
  monthlyCapUsdCents?: number;
  autoApproveUpToUsdCents?: number;
  /** Non-USD (or USD) budgets the user mentioned. Suggestions only, never applied automatically. */
  nonUsdHints?: { scope: string; amount: number; currency: string }[];
  usdHints?: Partial<Record<CapKey, number>>;
}

export type Step =
  | "repo"
  | "label"
  | "product_query"
  | "product_pick"
  | "package_pick"
  | "recipient"
  | "cap_per"
  | "cap_daily"
  | "cap_monthly"
  | "cap_auto"
  | "done";

/** The next piece of information still needed, in the order we ask for it. */
export function nextStep(d: RuleDraft): Step {
  if (!d.repository) return "repo";
  if (!d.requiredLabel) return "label";
  if (!d.product) return d.productQuery ? "product_pick" : "product_query";
  if (!d.pkg) return "package_pick";
  if (!d.recipientChatId) return "recipient";
  if (d.perPurchaseCapUsdCents === undefined) return "cap_per";
  if (d.dailyCapUsdCents === undefined) return "cap_daily";
  if (d.monthlyCapUsdCents === undefined) return "cap_monthly";
  if (d.autoApproveUpToUsdCents === undefined) return "cap_auto";
  return "done";
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeRepository(input: string): string | null {
  const s = input
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split(/[?#]/)[0]!;
  return REPO_RE.test(s) && s.length <= 140 ? s : null;
}

export function normalizeLabel(input: string): string | null {
  const s = input.trim().replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "").trim();
  return s.length >= 1 && s.length <= 50 && !/[\r\n]/.test(s) ? s : null;
}

/** Private Telegram chats have positive numeric IDs. Groups and channels are negative. */
export function normalizeRecipient(input: string): string | null {
  const s = input.trim();
  return /^\d{1,15}$/.test(s) && Number(s) > 0 ? s : null;
}

export type CapCheck = { ok: true } | { ok: false; message: string };

/** Cross-field rules: auto-approve <= per-purchase <= daily <= monthly. */
export function checkCap(d: RuleDraft, key: CapKey, cents: number): CapCheck {
  if (!Number.isSafeInteger(cents) || cents < 0) return { ok: false, message: "That amount isn't valid." };
  if (key !== "autoApproveUpToUsdCents" && cents === 0) return { ok: false, message: "This limit must be greater than $0.00." };
  if (key === "dailyCapUsdCents" && d.perPurchaseCapUsdCents !== undefined && cents < d.perPurchaseCapUsdCents) {
    return { ok: false, message: `The daily cap can't be lower than the per-purchase cap (${formatUsd(d.perPurchaseCapUsdCents)}).` };
  }
  if (key === "monthlyCapUsdCents" && d.dailyCapUsdCents !== undefined && cents < d.dailyCapUsdCents) {
    return { ok: false, message: `The monthly cap can't be lower than the daily cap (${formatUsd(d.dailyCapUsdCents)}).` };
  }
  if (key === "autoApproveUpToUsdCents" && d.perPurchaseCapUsdCents !== undefined && cents > d.perPurchaseCapUsdCents) {
    return { ok: false, message: `Auto-approval can't exceed the per-purchase cap (${formatUsd(d.perPurchaseCapUsdCents)}).` };
  }
  return { ok: true };
}

export function defaultRuleName(d: RuleDraft): string {
  const product = d.product?.name ?? "gift card";
  const value = d.pkg && d.product ? ` ${formatDenomination(d.pkg.value, d.product.currency)}` : "";
  return `${d.requiredLabel ?? "reward"}: ${product}${value}`.slice(0, 80);
}

/** Builds the exact engine body. Throws if the draft is incomplete. */
export function toCreateRuleBody(d: RuleDraft, ownerChatId: string): CreateRuleBody {
  if (nextStep(d) !== "done" || !d.product || !d.pkg) throw new Error("Rule draft is incomplete");
  return {
    ownerChatId,
    recipientChatId: d.recipientChatId!,
    name: d.name ?? defaultRuleName(d),
    repository: d.repository!,
    requiredLabel: d.requiredLabel!,
    productId: d.product.id,
    packageId: d.pkg.packageId,
    perPurchaseCapUsdCents: d.perPurchaseCapUsdCents!,
    dailyCapUsdCents: d.dailyCapUsdCents!,
    monthlyCapUsdCents: d.monthlyCapUsdCents!,
    autoApproveUpToUsdCents: d.autoApproveUpToUsdCents!,
  };
}
