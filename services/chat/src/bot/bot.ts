import { Bot, type Context, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Logger } from "../logger.js";
import type { Controller } from "./controller.js";
import type { Actor, Button, Reply } from "./types.js";

export const COMMANDS = [
  { command: "newrule", description: "Create a purchasing rule" },
  { command: "rules", description: "Show my rules" },
  { command: "enable", description: "Enable a draft rule" },
  { command: "pause", description: "Pause a rule" },
  { command: "resume", description: "Resume a paused rule" },
  { command: "status", description: "Purchases and automation status" },
  { command: "whoami", description: "Show my Telegram ID" },
  { command: "cancel", description: "Cancel the current setup" },
  { command: "help", description: "What PactPilot can do" },
];

export function toKeyboard(buttons?: Button[][]): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    row.forEach((b) => kb.text(b.text, b.data));
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

function actorOf(ctx: Context): Actor | null {
  if (!ctx.from || !ctx.chat) return null;
  return { userId: String(ctx.from.id), chatId: String(ctx.chat.id), chatType: ctx.chat.type };
}

async function sendReplies(ctx: Context, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    await ctx.reply(r.text, { parse_mode: "HTML", reply_markup: toKeyboard(r.buttons), link_preview_options: { is_disabled: true } });
  }
}

export interface BotOptions {
  token: string;
  controller: Controller;
  logger: Logger;
  /** Lets tests skip the getMe round-trip. */
  botInfo?: UserFromGetMe;
}

export function createBot(opts: BotOptions): Bot {
  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  const { controller, logger } = opts;

  bot.on("message:text", async (ctx) => {
    const actor = actorOf(ctx);
    if (!actor) return;
    const text = ctx.message.text;
    const cmd = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    const replies = cmd
      ? await controller.handleCommand(actor, cmd[1]!, (cmd[2] ?? "").trim())
      : await controller.handleText(actor, text);
    await sendReplies(ctx, replies);
  });

  bot.on("callback_query:data", async (ctx) => {
    const actor = actorOf(ctx);
    if (!actor) return;
    const result = await controller.handleCallback(actor, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: result.toast }).catch(() => {});
    // After a successful action (it sets a toast), remove the buttons so it can't be tapped twice.
    // Failures carry no toast, so the button stays and the owner can retry.
    if (result.toast && result.replies.length) {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
    await sendReplies(ctx, result.replies);
  });

  bot.catch((err) => {
    // Log the failure class only; update contents may hold personal data.
    logger.error("bot_handler_error");
  });

  return bot;
}
