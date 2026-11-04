/** Telegram HTML helpers. All externally-sourced text must pass through esc(). */
export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const code = (s: unknown): string => `<code>${esc(s)}</code>`;
export const bold = (s: unknown): string => `<b>${esc(s)}</b>`;
