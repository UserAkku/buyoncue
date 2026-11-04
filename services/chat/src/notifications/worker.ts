import { EngineError } from "../engine/client.js";
import type { EngineApi, Notification } from "../engine/types.js";
import { bold, code, esc } from "../html.js";
import type { Logger } from "../logger.js";
import type { Button } from "../bot/types.js";

/** The slice of Telegram the worker needs. Implementations must throw if Telegram did not accept the message. */
export interface Sender {
  sendMessage(chatId: string, html: string, buttons?: Button[][]): Promise<void>;
  /** "private" | "group" | "supergroup" | "channel", or null if unknown/unreachable. */
  chatType(chatId: string): Promise<string | null>;
}

export interface WorkerOptions {
  engine: EngineApi;
  sender: Sender;
  /** Owner's Telegram user ID == their private chat ID. */
  ownerChatId: string;
  logger: Logger;
  intervalMs?: number;
  batchSize?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

type Outcome = "sent" | "dropped" | "retry";

/**
 * Polls the engine's notification outbox and relays it to Telegram.
 * Order for every item: validate chat -> send -> only then ack.
 * Single instance only (no distributed locking).
 */
export class NotificationWorker {
  private readonly engine: EngineApi;
  private readonly sender: Sender;
  private readonly ownerChatId: string;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  /** Sent to Telegram but not yet acked (ack failed). We only retry the ack, never the message. */
  private readonly sentUnacked = new Set<string>();
  private readonly attempts = new Map<string, { count: number; nextAt: number }>();
  private recipientCache: { chats: Set<string>; fetchedAt: number } | null = null;
  private pollFailures = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(opts: WorkerOptions) {
    this.engine = opts.engine;
    this.sender = opts.sender;
    this.ownerChatId = opts.ownerChatId;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.batchSize = opts.batchSize ?? 20;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      let delay = this.intervalMs;
      try {
        await this.tick();
        this.pollFailures = 0;
      } catch (err) {
        this.pollFailures++;
        delay = Math.min(this.intervalMs * 2 ** this.pollFailures, this.maxBackoffMs);
        this.logger.warn("notification_poll_failed", {
          kind: err instanceof EngineError ? err.kind : "unknown",
          retryInMs: delay,
        });
      }
      if (!this.stopped) this.timer = setTimeout(loop, delay);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One poll cycle. Throws only if the poll itself fails; per-item failures are isolated. */
  async tick(): Promise<void> {
    const items = await this.engine.listNotifications(this.batchSize);
    for (const n of items) {
      const gate = this.attempts.get(n.id);
      if (gate && gate.nextAt > this.now()) continue;
      const outcome = await this.process(n);
      if (outcome === "retry") this.scheduleRetry(n.id);
      else this.attempts.delete(n.id);
    }
  }

  private scheduleRetry(id: string): void {
    const count = (this.attempts.get(id)?.count ?? 0) + 1;
    const wait = Math.min(2000 * 2 ** (count - 1), this.maxBackoffMs);
    this.attempts.set(id, { count, nextAt: this.now() + wait });
  }

  private async process(n: Notification): Promise<Outcome> {
    // The message already went out; only the ack is outstanding.
    if (this.sentUnacked.has(n.id)) return (await this.ack(n.id)) ? "sent" : "retry";

    let allowed: boolean;
    try {
      allowed = await this.isAuthorizedPrivateChat(n.chatId);
    } catch (err) {
      this.logger.warn("notification_validation_failed", { id: n.id, kind: err instanceof EngineError ? err.kind : "unknown" });
      return "retry";
    }

    const hasSecrets = !!(n.redemption && (n.redemption.code || n.redemption.pin || n.redemption.link || n.redemption.instructions));
    const approvalOk = !n.approvalPurchaseId || n.chatId === this.ownerChatId;

    let message: { html: string; buttons?: Button[][] } | null = null;
    let target = n.chatId;
    if (allowed && approvalOk) {
      message = renderNotification(n);
    } else if (hasSecrets || n.approvalPurchaseId) {
      // Never leak redemption data or approval buttons to an unverified chat. Tell the owner instead.
      target = this.ownerChatId;
      message = {
        html: `⚠️ A notification (${esc(n.type)}${n.invoiceId ? ", invoice " + code(n.invoiceId) : ""}) was addressed to a chat that isn't an authorized private chat, so I withheld its details. Check the rule's recipient.`,
      };
    }

    if (!message) {
      this.logger.warn("notification_dropped_unauthorized_chat", { id: n.id, type: n.type });
      return (await this.ack(n.id)) ? "dropped" : "retry";
    }

    try {
      await this.sender.sendMessage(target, message.html, message.buttons);
    } catch (err) {
      // Not acked: the engine will redeliver it on the next poll.
      this.logger.warn("telegram_send_failed", { id: n.id, type: n.type });
      return "retry";
    }
    this.sentUnacked.add(n.id);
    this.logger.info("notification_sent", { id: n.id, type: n.type, purchaseId: n.purchaseId });
    return (await this.ack(n.id)) ? "sent" : "retry";
  }

  /** Acknowledges to the engine. Returns false (and keeps the message marked as sent) if the ack failed. */
  private async ack(id: string): Promise<boolean> {
    try {
      await this.engine.ackNotification(id);
      this.sentUnacked.delete(id);
      return true;
    } catch (err) {
      this.logger.warn("notification_ack_failed", { id, kind: err instanceof EngineError ? err.kind : "unknown" });
      return false;
    }
  }

  /** The recipient must be a private chat that the owner authorized: themselves or a rule's recipient. */
  private async isAuthorizedPrivateChat(chatId: string): Promise<boolean> {
    if (!/^\d{1,15}$/.test(chatId) || Number(chatId) <= 0) return false; // groups/channels are negative
    if (chatId !== this.ownerChatId) {
      const known = await this.recipientChats();
      if (!known.has(chatId)) {
        const fresh = await this.recipientChats(true);
        if (!fresh.has(chatId)) return false;
      }
    }
    const type = await this.sender.chatType(chatId);
    // null means the lookup failed, not that Telegram proved this is an unsafe chat.
    // Retain the encrypted delivery and retry instead of acknowledging lost redemption.
    if (type === null) throw new Error("Telegram chat lookup unavailable");
    return type === "private";
  }

  private async recipientChats(force = false): Promise<Set<string>> {
    const c = this.recipientCache;
    if (!force && c && this.now() - c.fetchedAt < 30_000) return c.chats;
    const rules = await this.engine.listRules(this.ownerChatId);
    const chats = new Set(rules.map((r) => r.recipientChatId).filter((x): x is string => !!x));
    this.recipientCache = { chats, fetchedAt: this.now() };
    return chats;
  }
}

function icon(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("deliver")) return "🎁";
  if (t.includes("approv")) return "🔔";
  if (t.includes("block") || t.includes("reject") || t.includes("denied")) return "🚫";
  if (t.includes("fail") || t.includes("error")) return "⚠️";
  if (t.includes("duplicate")) return "♻️";
  return "ℹ️";
}

/** Plain-text-safe rendering. `text` comes from the engine but is still escaped. */
export function renderNotification(n: Notification): { html: string; buttons?: Button[][] } {
  const lines: string[] = [];
  let buttons: Button[][] | undefined;
  const simulated = n.type === "test_purchase_delivered";
  const isDelivered = n.type === "purchase_delivered" || simulated;

  if (isDelivered) {
    lines.push(`🎁 ${bold(simulated ? "TEST MODE: simulated delivery. No real purchase." : "Purchase delivered.")}`);
    if (n.invoiceId) lines.push(`Invoice: ${code(n.invoiceId)}`);
    if (n.text) lines.push(esc(n.text));
    const r = n.redemption;
    if (r && (r.code || r.pin || r.link || r.instructions)) {
      lines.push("", bold("Redemption details (keep private):"));
      if (r.code) lines.push(`Code: ${code(r.code)}`);
      if (r.pin) lines.push(`PIN: ${code(r.pin)}`);
      if (r.link) lines.push(`Link: ${esc(r.link)}`);
      if (r.instructions) lines.push(esc(r.instructions));
    }
  } else {
    lines.push(`${icon(n.type)} ${esc(n.text ?? n.type)}`);
    if (n.invoiceId) lines.push(`Invoice: ${code(n.invoiceId)}`);
  }

  if (n.approvalPurchaseId) {
    buttons = [[
      { text: "✅ Approve", data: `ap:${n.approvalPurchaseId}` },
      { text: "❌ Reject", data: `rj:${n.approvalPurchaseId}` },
    ]];
  }
  return { html: lines.join("\n"), buttons };
}
