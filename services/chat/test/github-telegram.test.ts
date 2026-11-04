import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, normalizePrivateKey } from "../src/config.js";
import { NotificationWorker, type Sender } from "../src/notifications/worker.js";
import { silentLogger } from "../src/logger.js";
import { buttonData, cbText, owner, stranger, textOf } from "./helpers.js";
import { contributor, prPayload, sha, startStack, type Stack } from "./github-stack.js";

let s: Stack;
beforeEach(async () => {
  s = await startStack();
  s.connectRepo();
});
afterEach(async () => {
  await s.stop();
});

const GITHUB_OWNER_ONLY = [
  ["cmd", "connectgithub"],
  ["cmd", "repositories"],
  ["cmd", "setbounty"],
  ["cmd", "review"],
  ["cmd", "bounties"],
] as const;

describe("/setbounty", () => {
  beforeEach(() => s.engine.bountyRules.clear()); // beforeEach in the outer scope created a policy; this suite configures its own
  async function runFlow() {
    let replies = await s.controller.handleCommand(owner, "setbounty", "");
    expect(textOf(replies)).toContain("acme/app");
    expect(textOf(replies)).toContain("Which PR label");
    replies = await s.controller.handleText(owner, "reward-ready");
    expect(textOf(replies)).toContain("Which gift card");
    replies = await s.controller.handleText(owner, "flipkart");
    expect(buttonData(replies)).toContain("bpr:0");
    replies = (await s.controller.handleCallback(owner, "bpr:0")).replies;
    expect(buttonData(replies)).toEqual(expect.arrayContaining(["btc:1", "btc:2", "btc:3"]));
    replies = (await s.controller.handleCallback(owner, "btc:2")).replies;
    expect(textOf(replies)).toContain("Tier 1");
    replies = (await s.controller.handleCallback(owner, "bts:60")).replies;
    expect(buttonData(replies)).toContain("bpk:0");
    replies = (await s.controller.handleCallback(owner, "bpk:0")).replies; // tier 1 -> ₹50
    expect(textOf(replies)).toContain("Tier 2");
    expect(textOf(await s.controller.handleText(owner, "50"))).toContain("higher than the previous tier");
    replies = await s.controller.handleText(owner, "80");
    replies = (await s.controller.handleCallback(owner, "bpk:1")).replies; // tier 2 -> ₹100
    expect(textOf(replies)).toContain("Per-reward hard cap");
    expect(s.engine.calls("POST", "/v1/bounty-rules")).toHaveLength(0); // limits still unconfirmed
    replies = await s.controller.handleText(owner, "2");
    replies = await s.controller.handleText(owner, "$5");
    replies = await s.controller.handleText(owner, "20");
    return s.controller.handleText(owner, "1.50");
  }

  it("collects tiers and typed limits, creates a DRAFT, and enables only on the button", async () => {
    const replies = await runFlow();
    expect(textOf(replies)).toContain("ready to review");
    expect(textOf(replies)).toContain("DRAFT");
    expect(textOf(replies)).toContain("Nothing is bought until you enable");
    const created = s.engine.calls("POST", "/v1/bounty-rules");
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toEqual({
      ownerTelegramUserId: "1001",
      repositoryId: 4242,
      requiredLabel: "reward-ready",
      mode: "ai_contribution_bounty",
      requireMerged: true,
      requireSuccessfulCI: true,
      scoreThreshold: 60,
      tiers: [
        { minScore: 60, maxScore: 79, faceValueINR: 50, productId: "mock-flipkart-in", packageId: "mock-flipkart-in-50", requiresApproval: false },
        { minScore: 80, maxScore: 100, faceValueINR: 100, productId: "mock-flipkart-in", packageId: "mock-flipkart-in-100", requiresApproval: false },
      ],
      autoApproveUpToUsdCents: 150,
      perPurchaseCapUsdCents: 200,
      dailyCapUsdCents: 500,
      monthlyCapUsdCents: 2000,
      allowSelfReward: false,
    });
    const rule = [...s.engine.bountyRules.values()].find((r) => r.id !== "rule-1")!;
    expect(rule.status).toBe("draft");
    expect(s.engine.calls("POST", `/v1/rules/${rule.id}/enable`)).toHaveLength(0);

    const enable = buttonData(replies).find((d) => d.startsWith("be:"))!;
    const res = await s.controller.handleCallback(owner, enable);
    expect(cbText(res)).toContain("enabled");
    expect(rule.status).toBe("enabled");
    expect(buttonData(res.replies)).toContain(`bp:${rule.id}`); // Pause rewards

    const paused = await s.controller.handleCallback(owner, `bp:${rule.id}`);
    expect(rule.status).toBe("paused");
    expect(buttonData(paused.replies)).toContain(`br:${rule.id}`);
  });

  it("never converts INR to a USD limit and keeps limits ordered", async () => {
    await s.controller.handleCommand(owner, "setbounty", "");
    await s.controller.handleText(owner, "reward-ready");
    await s.controller.handleText(owner, "flipkart");
    await s.controller.handleCallback(owner, "bpr:0");
    await s.controller.handleCallback(owner, "btc:1");
    await s.controller.handleCallback(owner, "bts:60");
    await s.controller.handleCallback(owner, "bpk:0");
    expect(textOf(await s.controller.handleText(owner, "₹500"))).toContain("won't convert currencies silently");
    await s.controller.handleText(owner, "5");
    expect(textOf(await s.controller.handleText(owner, "2"))).toContain("can't be lower than the per-purchase cap");
  });

  it("rejects a product that disappeared from the catalog before creating anything", async () => {
    await s.controller.handleCommand(owner, "setbounty", "");
    await s.controller.handleText(owner, "reward-ready");
    await s.controller.handleText(owner, "flipkart");
    await s.controller.handleCallback(owner, "bpr:0");
    await s.controller.handleCallback(owner, "btc:1");
    await s.controller.handleCallback(owner, "bts:60");
    await s.controller.handleCallback(owner, "bpk:0");
    s.engine.products.length = 0; // catalog changes under us
    for (const v of ["2", "5", "20"]) await s.controller.handleText(owner, v);
    const res = await s.controller.handleText(owner, "1");
    expect(textOf(res)).toContain("isn't in the catalog");
    expect(s.engine.calls("POST", "/v1/bounty-rules")).toHaveLength(0);
  });
});

describe("/review, /bounties, /myrewards, /repositories", () => {
  it("/review collects fresh evidence, submits it, and shows the engine's score; payment is never started", async () => {
    s.engine.mockScore = { score: 64, subscores: { correctness: 20, tests: 15, feedback: 14, maintainability: 10, security: 5 } };
    const res = await s.controller.handleCommand(owner, "review", "42");
    expect(textOf(res)).toContain("PR #42");
    expect(textOf(res)).toContain("Total: 64/100");
    expect(s.engine.calls("POST", "/v1/contributions/review")).toHaveLength(1);
    expect(s.engine.requests.filter((r) => r.path.endsWith("/finalize"))).toHaveLength(0);

    // Same head SHA: no resubmission, just the engine's current view.
    await s.controller.handleCommand(owner, "review", "42");
    expect(s.engine.calls("POST", "/v1/contributions/review")).toHaveLength(1);

    // Missing number -> asks for it.
    expect(textOf(await s.controller.handleCommand(owner, "review", ""))).toContain("Which pull request number");
    expect(textOf(await s.controller.handleText(owner, "999"))).toContain("wasn't found");
  });

  it("/bounties and 'View review' show engine data", async () => {
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    const list = await s.controller.handleCommand(owner, "bounties", "");
    expect(textOf(list)).toContain("PR #42");
    expect(textOf(list)).toContain("81/100");
    expect(textOf(list)).toContain("provisional");
    const view = await s.controller.handleCallback(owner, buttonData(list).find((d) => d.startsWith("rv:"))!);
    expect(cbText(view)).toContain("Correctness / issue alignment: 24/30");
  });

  it("/repositories lists connected repos with bounty status and the right action button", async () => {
    const res = await s.controller.handleCommand(owner, "repositories", "");
    expect(textOf(res)).toContain("acme/app");
    expect(textOf(res)).toContain("ENABLED");
    expect(buttonData(res)).toEqual(expect.arrayContaining(["sb:4242", "bp:rule-1"]));
  });

  it("/myrewards shows only the linked contributor's own outcomes and never a redemption code", async () => {
    s.engine.mockReceiptStatus = "DELIVERED";
    s.engine.mockReceiptInvoice = "MOCK-INV-BOUNTY";
    s.engine.mockReceiptOrders = [{ id: "o1", status: "delivered" }];
    await s.deliver("pull_request", prPayload({ action: "opened" }), "d1");
    await s.pipeline.idle();
    s.gh.setPr("acme/app", 42, { headSha: sha("a"), merged: true });
    await s.deliver("pull_request", prPayload({ action: "closed", merged: true }), "d2");
    await s.pipeline.idle();

    expect(textOf(await s.controller.handleCommand(contributor, "myrewards", ""))).toContain("/linkgithub");
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    s.store.setLink("3003", { githubUserId: "7777", githubLogin: "someone", linkedAt: "x" });
    const mine = textOf(await s.controller.handleCommand(contributor, "myrewards", ""));
    expect(mine).toContain("PR #42");
    expect(mine).toContain("Bounty delivered.");
    expect(mine).toContain("MOCK-INV-BOUNTY");
    expect(mine).not.toMatch(/MOCK-CODE|redemption code/i);
    const theirs = textOf(await s.controller.handleCommand({ userId: "3003", chatId: "3003", chatType: "private" }, "myrewards", ""));
    expect(theirs).toContain("No rewards yet");
  });
});

describe("authorization", () => {
  it("20. only the owner can configure or change spending policies, and never from a group", async () => {
    for (const [, cmd] of GITHUB_OWNER_ONLY) {
      expect(textOf(await s.controller.handleCommand(stranger, cmd, ""))).toContain("private");
      expect(await s.controller.handleCommand({ userId: "1001", chatId: "-9", chatType: "supergroup" }, cmd, "")).toEqual([]);
    }
    for (const data of ["sr:0", "sb:4242", "be:r1", "bp:r1", "br:r1", "rv:x", "bpr:0", "bpk:0", "btc:1", "bts:60", "bcap:100", "rvr:4242"]) {
      const res = await s.controller.handleCallback(stranger, data);
      expect(res.toast).toBe("Not authorized");
      const inGroup = await s.controller.handleCallback({ userId: "1001", chatId: "-9", chatType: "supergroup" }, data);
      expect(inGroup.toast).toBe("Not authorized");
    }
    expect(await s.controller.handleText(stranger, "Connect my GitHub repository please")).not.toEqual([]);
    expect(s.sessions.get("none")).toBeNull();
    expect(s.engine.requests.filter((r) => /bounty|repositories|contributions/.test(r.path))).toHaveLength(0);
    expect(s.gh.requests).toHaveLength(0);
  });

  it("contributors can link/unlink/see rewards but have no path to rules or credentials", async () => {
    const reply = textOf(await s.controller.handleCommand(contributor, "linkgithub", ""));
    expect(reply).toContain("Link your GitHub identity");
    expect(reply).not.toMatch(/token|secret|password/i);
    expect(textOf(await s.controller.handleCommand(contributor, "setbounty", ""))).toContain("private");
  });

  it("22. all pre-existing commands still work with GitHub features enabled", async () => {
    expect(textOf(await s.controller.handleCommand(owner, "help", ""))).toContain("/newrule");
    expect(textOf(await s.controller.handleCommand(owner, "help", ""))).toContain("/connectgithub");
    expect(textOf(await s.controller.handleCommand(stranger, "whoami", ""))).toContain("2002");
    expect(textOf(await s.controller.handleCommand(owner, "start", ""))).toContain("Welcome");
    expect(textOf(await s.controller.handleCommand(owner, "rules", ""))).toContain("no rules");
    expect(textOf(await s.controller.handleCommand(owner, "status", ""))).toContain("Status");
    expect(textOf(await s.controller.handleCommand(owner, "newrule", ""))).toContain("AI parsing is off");
    await s.controller.handleText(owner, "acme/app");
    await s.controller.handleText(owner, "reward-ready");
    const search = await s.controller.handleText(owner, "amazon US");
    expect(buttonData(search)).toContain("pr:0");
    expect(textOf(await s.controller.handleCommand(owner, "cancel", ""))).toContain("cancelled");
    expect(textOf(await s.controller.handleCommand(owner, "cancel", ""))).toContain("nothing to cancel");
    // Without the GitHub App configured the new commands explain themselves.
  });
});

describe("private redemption delivery to linked contributors", () => {
  function worker(chatTypes: Record<string, string> = {}) {
    const sent: { chatId: string; html: string }[] = [];
    const sender: Sender = {
      async sendMessage(chatId, html) {
        sent.push({ chatId, html });
      },
      async chatType(chatId) {
        return chatTypes[chatId] ?? "private";
      },
    };
    const w = new NotificationWorker({ engine: s.client, sender, ownerChatId: "1001", logger: silentLogger, extraRecipientChats: () => s.store.linkedTelegramUsers() });
    return { w, sent };
  }
  const delivered = (chatId: string) =>
    s.engine.pushNotification({ chatId, type: "purchase_delivered", text: "Bounty.", purchaseId: "p", invoiceId: "INV-1", redemption: { code: "SECRET-CODE-XYZ", pin: null, link: null, instructions: null } });

  it("21. the code reaches only the linked, private recipient chat", async () => {
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    delivered("2002"); // linked contributor
    delivered("4004"); // never linked
    delivered("-100500"); // group
    const { w, sent } = worker();
    await w.tick();
    const toContributor = sent.filter((m) => m.chatId === "2002");
    expect(toContributor).toHaveLength(1);
    expect(toContributor[0]!.html).toContain("SECRET-CODE-XYZ");
    const everyoneElse = sent.filter((m) => m.chatId !== "2002");
    expect(everyoneElse.every((m) => m.chatId === "1001" && !m.html.includes("SECRET-CODE-XYZ"))).toBe(true);
  });

  it("21b. a linked user whose chat isn't private, or who unlinked, gets nothing", async () => {
    s.store.setLink("2002", { githubUserId: "6001", githubLogin: "contrib", linkedAt: "x" });
    const { w, sent } = worker({ "2002": "group" });
    delivered("2002");
    await w.tick();
    expect(sent.some((m) => m.chatId === "2002")).toBe(false);

    s.store.setLink("5005", { githubUserId: "1", githubLogin: "a", linkedAt: "x" });
    s.store.removeLink("5005");
    delivered("5005");
    const second = worker();
    await second.w.tick();
    expect(second.sent.some((m) => m.chatId === "5005")).toBe(false);
  });
});

describe("configuration", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", INTERNAL_API_TOKEN: "i", GITHUB_WEBHOOK_SECRET: "w" };
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
  const full = {
    ...base,
    GITHUB_APP_ID: "123",
    GITHUB_APP_CLIENT_ID: "Iv1.x",
    GITHUB_APP_CLIENT_SECRET: "sec",
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_OAUTH_CALLBACK_URL: "https://chat.example.com/auth/github/callback",
    GITHUB_APP_INSTALL_URL: "https://github.com/apps/buyoncue/installations/new",
    PUBLIC_CHAT_URL: "https://chat.example.com/",
  };

  it("boots without any GitHub App settings (feature off)", () => {
    expect(loadConfig(base).github).toBeNull();
  });

  it("names every missing setting when the GitHub App is partially configured, without echoing values", () => {
    const err = (() => {
      try {
        loadConfig({ ...base, GITHUB_APP_ID: "123", GITHUB_APP_CLIENT_SECRET: "super-secret-value" });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    for (const k of ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_OAUTH_CALLBACK_URL", "GITHUB_APP_INSTALL_URL", "PUBLIC_CHAT_URL"]) expect(err).toContain(k);
    expect(err).not.toContain("super-secret-value");
  });

  it("validates URLs and normalizes private keys", () => {
    expect(loadConfig(full).github!.publicUrl).toBe("https://chat.example.com");
    expect(() => loadConfig({ ...full, PUBLIC_CHAT_URL: "http://chat.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...full, GITHUB_OAUTH_CALLBACK_URL: "https://chat.example.com/other" })).toThrow(/auth\/github\/callback/);
    expect(() => loadConfig({ ...full, GITHUB_APP_PRIVATE_KEY: "not a key" })).toThrow(/PEM/);
    expect(normalizePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem);
    expect(() => loadConfig({ ...full, GITHUB_APP_PRIVATE_KEY: "not a key" })).not.toThrow(/not a key/);
  });

  it("without the GitHub App configured the new commands explain how to enable them", async () => {
    const { Controller } = await import("../src/bot/controller.js");
    const bare = new Controller({ engine: s.client, interpreter: null, ownerUserId: "1001", logger: silentLogger });
    expect(textOf(await bare.handleCommand(owner, "connectgithub", ""))).toContain("isn't configured");
    expect(textOf(await bare.handleCommand(contributor, "linkgithub", ""))).toContain("isn't configured");
  });
});
