import { Controller } from "../src/bot/controller.js";
import type { Actor, CallbackResult, Reply } from "../src/bot/types.js";
import { EngineClient } from "../src/engine/client.js";
import { silentLogger } from "../src/logger.js";
import type { RuleInterpreter, RuleProposal } from "../src/rules/interpreter.js";
import { MockEngine } from "../mock-engine/engine.js";

export const TOKEN = "test-internal-token";
export const OWNER_ID = "1001";
export const owner: Actor = { userId: OWNER_ID, chatId: OWNER_ID, chatType: "private" };
export const stranger: Actor = { userId: "2002", chatId: "2002", chatType: "private" };

export async function startEngine(opts: { mockCostCents?: number } = {}) {
  const engine = new MockEngine({ token: TOKEN, ...opts });
  await engine.start();
  const client = new EngineClient({ baseUrl: engine.url, token: TOKEN, timeoutMs: 2000 });
  return { engine, client };
}

export function stubInterpreter(proposal: Partial<RuleProposal>): RuleInterpreter {
  return {
    interpret: async () => ({ intent: "create_rule", budgetHints: [], ...proposal }) as RuleProposal,
  };
}

export function makeController(client: EngineClient, interpreter: RuleInterpreter | null = null) {
  return new Controller({ engine: client, interpreter, ownerUserId: OWNER_ID, logger: silentLogger, verifyRecipient:async()=>true });
}

export const textOf = (replies: Reply[]) => replies.map((r) => r.text).join("\n---\n");
export const buttonData = (replies: Reply[]) => replies.flatMap((r) => (r.buttons ?? []).flat().map((b) => b.data));
export const cbText = (r: CallbackResult) => textOf(r.replies);
