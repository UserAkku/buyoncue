import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { silentLogger } from "../src/logger.js";
import type { MockEngine } from "../mock-engine/engine.js";
import { makeController, OWNER_ID, startEngine } from "./helpers.js";

let engine: MockEngine;
const calls: { method: string; payload: any }[] = [];

beforeEach(async () => {
  calls.length = 0;
  const started = await startEngine();
  engine = started.engine;
});
afterEach(async () => {
  await engine.stop();
});


async function buildBot() {
  const { EngineClient } = await import("../src/engine/client.js");
  const controller = makeController(new EngineClient({ baseUrl: engine.url, token: "test-internal-token" }));
  const bot = createBot({
    token: "123:TESTTOKEN",
    controller,
    logger: silentLogger,
    botInfo: {
      id: 1, is_bot: true, first_name: "PactPilot", username: "pactpilot_bot",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
    } as any,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: true } as any;
  });
  return bot;
}

const msg = (userId: number, text: string, chatType = "private", chatId = userId) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, date: 0, chat: { id: chatId, type: chatType, first_name: "x" }, from: { id: userId, is_bot: false, first_name: "x" }, text },
});

describe("grammY wiring", () => {
  it("5. blocks an unauthorized Telegram user at the bot layer (messages and button presses)", async () => {
    const bot = await buildBot();
    await bot.handleUpdate(msg(2002, "/rules") as any);
    await bot.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb1", chat_instance: "x", data: "ap:some-purchase",
        from: { id: 2002, is_bot: false, first_name: "x" },
        message: { message_id: 9, date: 0, chat: { id: 2002, type: "private", first_name: "x" } },
      },
    } as any);

    expect(engine.requests.filter((r) => r.path.startsWith("/v1"))).toHaveLength(0);
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(reply!.payload.text).toContain("private");
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe("Not authorized");
  });

  it("serves the owner (HTML replies with inline keyboards) and handles /command@botname", async () => {
    const bot = await buildBot();
    await bot.handleUpdate(msg(Number(OWNER_ID), "/whoami@pactpilot_bot") as any);
    const reply = calls.find((c) => c.method === "sendMessage")!;
    expect(reply.payload.parse_mode).toBe("HTML");
    expect(reply.payload.text).toContain(OWNER_ID);

    calls.length = 0;
    await bot.handleUpdate(msg(Number(OWNER_ID), "/newrule") as any);
    const ask = calls.find((c) => c.method === "sendMessage")!;
    expect(ask.payload.text).toContain("AI parsing is off");
  });
});
