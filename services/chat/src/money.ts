/** Money helpers. All spending limits are exact integer USD cents. */

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function formatDenomination(value: number, currency: string): string {
  const sym = SYMBOLS[currency.toUpperCase()];
  return sym ? `${sym}${value}` : `${value} ${currency.toUpperCase()}`;
}

export type UsdParse =
  | { ok: true; cents: number }
  | { ok: false; reason: "non_usd" | "invalid" };

/**
 * Parses a user-typed USD amount into integer cents without floating point.
 * Accepts "2", "$2", "1.5", "$1.50", "usd 3", "150 cents", "150c".
 * Refuses INR/other currencies: we never convert silently.
 */
export function parseUsdInput(raw: string): UsdParse {
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  if (/[₹€£]|\binr\b|\brs\.?\b|\brupees?\b|\beur\b|\bgbp\b/.test(text)) return { ok: false, reason: "non_usd" };

  const centsMatch = text.match(/^(\d+)\s*(?:c|cents?)$/);
  if (centsMatch) return { ok: true, cents: Number(centsMatch[1]) };

  const cleaned = text.replace(/^\$\s*/, "").replace(/^usd\s*/, "").replace(/\s*(?:usd|dollars?)$/, "").replace(/^\$\s*/, "");
  const m = cleaned.match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!m) return { ok: false, reason: "invalid" };
  const dollars = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0") || "0");
  return { ok: true, cents: dollars * 100 + frac };
}
