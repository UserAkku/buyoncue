import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient } from "../src/engine/client.js";
import type { EngineApi } from "../src/engine/types.js";
import type { Logger } from "../src/logger.js";
import { NotificationWorker, type Sender } from "../src/notifications/worker.js";
import type { MockEngine } from "../mock-engine/engine.js";
import { OWNER_ID, startEngine } from "./helpers.js";

const SECRET_CODE = "SECRET-GIFT-CODE-777";

let engine: MockEngine;
let client: EngineClient;
let timeline: string[];
let sent: { chatId: string; html: string; buttons?: any }[];
let logLines: string[];
let chatTypes: Record<string, string | null>;
let failSends: number;
let failAcks: number;
let clock: number;

const logger: Logger = {
  info: (m, f) => void logLines.push(m + JSON.stringify(f ?? {})),
  warn: (m, f) => void logLines.push(m + JSON.stringify(f ?? {})),
  error: (m, f) => void logLines.push(m + JSON.stringify(f ?? {})),
};

const sender: Sender = {
  async sendMessage(chatId, html, buttons) {
    if (failSends > 0) {
      failSends--;
      throw new Error("Telegram 502");
    }
    timeline.push(`send:${chatId}`);
    sent.push({ chatId, html, buttons });
  },
  async chatType(chatId) {
    return chatId in chatTypes ? chatTypes[chatId]! : "private";
  },
};

function tracedEngine(): EngineApi {
  return new Proxy(client, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "ackNotification") {
        return async (id: string) => {
          if (failAcks > 0) {
            failAcks--;
            throw new Error("ack down");
          }
          timeline.push(`ack:${id}`);
          return target.ackNotification(id);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as EngineApi;
}

function makeWorker() {
  return new NotificationWorker({ engine: tracedEngine(), sender, ownerChatId: OWNER_ID, logger, now: () => clock });
}

beforeEach(async () => {
  ({ engine, client } = await startEngine());
  timeline = [];
  sent = [];
  logLines = [];
  chatTypes = {};
  failSends = 0;
  failAcks = 0;
  clock = 1_000_000;
  engine.rules.set("r1", { id: "r1", status: "active", ownerChatId: OWNER_ID, recipientChatId: "3003" });
});
afterEach(async () => {
  await engine.stop();
});

const delivered = (chatId: string) =>
  engine.pushNotification({
    chatId,
    type: "purchase_delivered",
    text: "Done.",
    purchaseId: "p1",
    invoiceId: "INV-REAL-1",
    redemption: { code: SECRET_CODE, pin: "1234", link: null, instructions: null },
  });

describe("notification worker", () => {
  it("11a. delivers a receipt with redemption info to the authorized private owner chat", async () => {
    delivered(OWNER_ID);
    await makeWorker().tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(OWNER_ID);
    expect(sent[0]!.html).toContain("Purchase delivered");
    expect(sent[0]!.html).toContain("INV-REAL-1");
    expect(sent[0]!.html).toContain(SECRET_CODE);
  });

  it("11b. delivers to a rule's pre-authorized private recipient", async () => {
    delivered("3003");
    await makeWorker().tick();
    expect(sent.map((s) => s.chatId)).toEqual(["3003"]);
    expect(sent[0]!.html).toContain(SECRET_CODE);
  });

  it("11c. never sends redemption data to groups or unknown chats; the owner gets a redacted notice", async () => {
    delivered("-1001234567890"); // group/channel
    delivered("9999"); // private, but never authorized by the owner
    chatTypes["4004"] = "group"; // positive id but not a private chat (defensive)
    engine.rules.set("r2", { id: "r2", status: "active", ownerChatId: OWNER_ID, recipientChatId: "4004" });
    delivered("4004");
    await makeWorker().tick();

    expect(sent.every((s) => s.chatId === OWNER_ID)).toBe(true);
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.html).not.toContain(SECRET_CODE);
      expect(s.html).not.toContain("1234");
      expect(s.html).toContain("withheld");
    }
    expect(engine.notifications.every((n) => n.acked)).toBe(true); // nothing left to loop on
  });

  it("approval requests carry Approve/Reject buttons for the right purchase, owner only", async () => {
    engine.pushNotification({ chatId: OWNER_ID, type: "approval_required", text: "Needs approval.", purchaseId: "p9", approvalPurchaseId: "p9" });
    engine.pushNotification({ chatId: "3003", type: "approval_required", text: "Needs approval.", purchaseId: "p8", approvalPurchaseId: "p8" });
    await makeWorker().tick();
    const toOwner = sent.filter((s) => s.chatId === OWNER_ID);
    expect(toOwner).toHaveLength(2);
    expect(toOwner[0]!.buttons[0].map((b: any) => b.data)).toEqual(["ap:p9", "rj:p9"]);
    // The mis-addressed approval never reaches the other chat with buttons.
    expect(sent.some((s) => s.chatId === "3003")).toBe(false);
    expect(toOwner[1]!.buttons).toBeUndefined();
  });

  it("12. acknowledges only after Telegram accepted the message", async () => {
    const n = delivered(OWNER_ID);
    await makeWorker().tick();
    expect(timeline).toEqual([`send:${OWNER_ID}`, `ack:${n.id}`]);
    expect(n.acked).toBe(true);
  });

  it("12b. does not ack when Telegram rejects, and retries with backoff", async () => {
    const n = delivered(OWNER_ID);
    const w = makeWorker();
    failSends = 1;
    await w.tick();
    expect(timeline).toEqual([]);
    expect(n.acked).toBe(false);

    await w.tick(); // still inside backoff window: no attempt
    expect(sent).toHaveLength(0);

    clock += 60_000;
    await w.tick();
    expect(timeline).toEqual([`send:${OWNER_ID}`, `ack:${n.id}`]);
  });

  it("12c. a failed ack never causes a duplicate Telegram message", async () => {
    const n = delivered(OWNER_ID);
    const w = makeWorker();
    failAcks = 1;
    await w.tick();
    expect(sent).toHaveLength(1);
    expect(n.acked).toBe(false);

    clock += 60_000;
    await w.tick();
    expect(sent).toHaveLength(1); // not re-sent
    expect(n.acked).toBe(true);
  });

  it("never writes redemption codes or PINs to logs", async () => {
    delivered(OWNER_ID);
    delivered("-100999");
    await makeWorker().tick();
    const all = logLines.join("\n");
    expect(all).not.toContain(SECRET_CODE);
    expect(all).not.toContain("1234");
  });

  it("retains redemption when Telegram chat lookup is temporarily unavailable", async () => {
    const n = delivered("3003");
    chatTypes["3003"] = null;
    const w = makeWorker();
    await w.tick();
    expect(n.acked).toBe(false);
    expect(sent).toHaveLength(0);
    chatTypes["3003"] = "private";
    clock += 60_000;
    await w.tick();
    expect(sent[0]!.chatId).toBe("3003");
    expect(n.acked).toBe(true);
  });

  it("does not log Telegram exception messages containing redemption", async () => {
    delivered(OWNER_ID);
    const failing: Sender = { ...sender, async sendMessage() { throw new Error(SECRET_CODE); } };
    await new NotificationWorker({engine:client,sender:failing,ownerChatId:OWNER_ID,logger}).tick();
    expect(logLines.join("\n")).not.toContain(SECRET_CODE);
  });

  it("escapes engine-supplied text so it can't inject markup", async () => {
    engine.pushNotification({ chatId: OWNER_ID, type: "purchase_blocked", text: "Blocked <b>x</b> & <a href='http://evil'>y</a>" });
    await makeWorker().tick();
    expect(sent[0]!.html).not.toContain("<a href");
    expect(sent[0]!.html).toContain("&lt;a href");
  });

  it("poll failure (engine offline) throws so the loop can back off; nothing is sent", async () => {
    await engine.stop();
    await expect(makeWorker().tick()).rejects.toBeDefined();
    expect(sent).toHaveLength(0);
    await engine.start();
  });
});
