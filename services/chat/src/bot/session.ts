import type { Product } from "../engine/types.js";
import type { RuleDraft } from "../rules/draft.js";

export interface Session {
  /** "describe" = waiting for a free-text rule description (AI mode only). */
  mode: "describe" | "collect";
  draft: RuleDraft;
  /** Search results currently offered as buttons (indexes are what callbacks refer to). */
  products: Product[];
  packageOptions: { packageId: string; value: number }[];
  touchedAt: number;
}

const TTL_MS = 30 * 60 * 1000;

export class SessionStore {
  private readonly map = new Map<string, Session>();

  get(chatId: string): Session | undefined {
    const s = this.map.get(chatId);
    if (!s) return undefined;
    if (Date.now() - s.touchedAt > TTL_MS) {
      this.map.delete(chatId);
      return undefined;
    }
    s.touchedAt = Date.now();
    return s;
  }

  start(chatId: string, mode: Session["mode"]): Session {
    const s: Session = { mode, draft: {}, products: [], packageOptions: [], touchedAt: Date.now() };
    this.map.set(chatId, s);
    return s;
  }

  clear(chatId: string): boolean {
    return this.map.delete(chatId);
  }
}
