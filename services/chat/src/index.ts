import "dotenv/config";
import { Controller } from "./bot/controller.js";
import { COMMANDS, createBot, toKeyboard } from "./bot/bot.js";
import { loadConfig } from "./config.js";
import { EngineClient } from "./engine/client.js";
import { consoleLogger as logger } from "./logger.js";
import { type Sender, NotificationWorker } from "./notifications/worker.js";
import { LlmRuleInterpreter } from "./rules/interpreter.js";
import { triggerNotice } from "./triggerNotice.js";
import { createApp } from "./webhook/github.js";

async function main() {
  const config = loadConfig();
  const engine = new EngineClient({ baseUrl: config.engineUrl, token: config.internalApiToken });
  const interpreter = config.llm ? new LlmRuleInterpreter(config.llm) : null;

  logger.info("starting", {
    engineUrl: config.engineUrl,
    port: config.port,
    rulesMode: interpreter ? "ai" : "guided",
    ownerConfigured: config.ownerUserId !== null,
  });
  if (!interpreter) logger.info("LLM credentials not set: /newrule uses the guided flow (not AI-powered)");
  if (!config.ownerUserId) logger.warn("TELEGRAM_OWNER_USER_ID not set: setup mode (/whoami only)");

  const controller = new Controller({ engine, interpreter, ownerUserId: config.ownerUserId, logger });
  const bot = createBot({ token: config.telegramBotToken, controller, logger });

  const sender: Sender = {
    async sendMessage(chatId, html, buttons) {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        reply_markup: toKeyboard(buttons),
        link_preview_options: { is_disabled: true },
      });
    },
    async chatType(chatId) {
      try {
        return (await bot.api.getChat(chatId)).type;
      } catch {
        return null;
      }
    },
  };

  const app = createApp({
    secret: config.githubWebhookSecret,
    engine,
    logger,
    onTriggerResult: async (trigger, result) => {
      const notice = triggerNotice(trigger, result);
      if (notice && config.ownerUserId) await sender.sendMessage(config.ownerUserId, notice);
    },
  });
  const server = app.listen(config.port, () => logger.info("http_listening", { port: config.port }));

  let worker: NotificationWorker | null = null;
  if (config.ownerUserId) {
    worker = new NotificationWorker({ engine, sender, ownerChatId: config.ownerUserId, logger });
    worker.start();
  }

  engine.health().then(
    (h) => logger.info("engine_health", { ok: h.ok, livePurchasesEnabled: h.livePurchasesEnabled }),
    () => logger.warn("engine_unreachable_at_boot: will keep retrying in the background"),
  );

  const shutdown = async (signal: string) => {
    logger.info("shutting_down", { signal });
    worker?.stop();
    server.close();
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.api.setMyCommands(COMMANDS).catch(() => logger.warn("set_my_commands_failed"));
  await bot.start({ onStart: (me) => logger.info("telegram_polling", { username: me.username }) });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
