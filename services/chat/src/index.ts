import "dotenv/config";
import type { Button } from "./bot/types.js";
import { Controller } from "./bot/controller.js";
import { COMMANDS, createBot, toKeyboard } from "./bot/bot.js";
import { loadConfig } from "./config.js";
import { EngineClient } from "./engine/client.js";
import { consoleLogger as logger } from "./logger.js";
import { type Sender, NotificationWorker } from "./notifications/worker.js";
import { LlmRuleInterpreter } from "./rules/interpreter.js";
import { triggerNotice } from "./triggerNotice.js";
import { GithubFeature } from "./bot/github-feature.js";
import { GithubApp } from "./github/app.js";
import { registerGithubAuthRoutes } from "./github/auth-routes.js";
import { GithubPipeline } from "./github/pipeline.js";
import { LinkSessions } from "./github/sessions.js";
import { StateStore } from "./state.js";
import { createApp } from "./webhook/github.js";

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    // Validation messages name variables and rules only, never values, so they are safe to print.
    console.error((err as Error).message);
    process.exit(1);
  }
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

  const store = new StateStore(config.stateFile);
  const sessions = new LinkSessions();
  const githubApp = config.github ? new GithubApp(config.github) : null;
  // `sender` is defined below, once the bot exists; it is only called after startup.
  const notify = (chatId: string, html: string, buttons?: Button[][]) => sender.sendMessage(chatId, html, buttons);

  let pipeline: GithubPipeline | null = null;
  let github: GithubFeature | undefined;
  if (config.github && githubApp && config.ownerUserId) {
    pipeline = new GithubPipeline({ github: githubApp, engine, store, logger, ownerChatId: config.ownerUserId, notify });
    github = new GithubFeature({ cfg: config.github, ownerUserId: config.ownerUserId, engine, github: githubApp, sessions, store, pipeline, logger, notify });
    logger.info("github_app_enabled");
  } else if (config.github) {
    logger.warn("GitHub App is configured but TELEGRAM_OWNER_USER_ID is not: GitHub features stay off until the owner is set");
  } else {
    logger.info("GitHub App not configured: AI bounty features are off (legacy rule triggers still work)");
  }

  const controller = new Controller({ engine, interpreter, ownerUserId: config.ownerUserId, logger, github,
    verifyRecipient: async chatId => (await bot.api.getChat(chatId)).type === "private" });
  const bot = createBot({ token: config.telegramBotToken, controller, logger });
  await bot.init(); // fetches the bot's own identity (used for the 'Return to Telegram' link)

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
    appEvents: pipeline ?? undefined,
    onTriggerResult: async (trigger, result) => {
      const notice = triggerNotice(trigger, result);
      if (notice && config.ownerUserId) await sender.sendMessage(config.ownerUserId, notice);
    },
  });
  if (config.github && githubApp && github) {
    const feature = github;
    registerGithubAuthRoutes(app, {
      cfg: config.github, github: githubApp, sessions, engine, store, logger, notify, botUsername: bot.botInfo.username,
      onMaintainerConnected: (s, id) => feature.onMaintainerConnected(s, id),
    });
  }
  const server = app.listen(config.port, () => logger.info("http_listening", { port: config.port }));

  let worker: NotificationWorker | null = null;
  if (config.ownerUserId) {
    worker = new NotificationWorker({ engine, sender, ownerChatId: config.ownerUserId, logger, extraRecipientChats: () => store.linkedTelegramUsers() });
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
  console.error("Chat service failed; check configuration and Telegram connectivity (error details suppressed)");
  process.exit(1);
});
