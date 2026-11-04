import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserFacingError } from "../src/bot/types.js";
import { EngineClient, EngineError } from "../src/engine/client.js";
import { parseProposal } from "../src/rules/interpreter.js";
import { buttonData, cbText, makeController, owner, startEngine, stranger, stubInterpreter, textOf, TOKEN } from "./helpers.js";
import type { MockEngine } from "../mock-engine/engine.js";

let engine: MockEngine;
let client: EngineClient;

beforeEach(async () => {
  ({ engine, client } = await startEngine());
});
afterEach(async () => {
  await engine.stop();
});

const FULL_PROPOSAL = {
  repository: "acme/app",
  requiredLabel: "reward-ready",
  productQuery: "flipkart",
  country: "IN",
  packageValue: 50,
  packageCurrency: "INR",
};

describe("rule conversation", () => {
  it("1. creates a draft rule from a natural-language message, then enables only on button tap", async () => {
    const c = makeController(client, stubInterpreter(FULL_PROPOSAL));

    let replies = await c.handleText(owner, "Whenever a PR with reward-ready label is merged in my repo, send a ₹50 Flipkart gift card");
    expect(textOf(replies)).toContain("acme/app");
    expect(buttonData(replies)).toContain("pr:0"); // real catalog option offered
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);

    // Pick Flipkart -> the ₹50 package matches what was asked, so we go straight to recipient.
    let cb = await c.handleCallback(owner, "pr:0");
    expect(cbText(cb)).toContain("₹50");
    expect(buttonData(cb.replies)).toContain("rc:me");

    cb = await c.handleCallback(owner, "rc:me");
    expect(cbText(cb)).toContain("Per-purchase hard cap");
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0); // limits still unconfirmed

    replies = await c.handleText(owner, "2");
    expect(textOf(replies)).toContain("Daily cap");
    replies = await c.handleText(owner, "$5");
    expect(textOf(replies)).toContain("Monthly cap");
    replies = await c.handleText(owner, "20");
    expect(textOf(replies)).toContain("Auto-approve");
    replies = await c.handleText(owner, "1.50");

    expect(textOf(replies)).toContain("ready to review");
    const created = engine.calls("POST", "/v1/rules");
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({
      ownerChatId: "1001",
      recipientChatId: "1001",
      repository: "acme/app",
      requiredLabel: "reward-ready",
      productId: "mock-flipkart-in",
      packageId: "mock-flipkart-in-50",
      perPurchaseCapUsdCents: 200,
      dailyCapUsdCents: 500,
      monthlyCapUsdCents: 2000,
      autoApproveUpToUsdCents: 150,
    });

    // 4. Draft only: nothing enabled yet.
    const [rule] = [...engine.rules.values()];
    expect(rule!.status).toBe("draft");
    expect(engine.calls("POST", "/v1/rules/")).toHaveLength(0);
    const enableBtn = buttonData(replies).find((d) => d.startsWith("en:"));
    expect(enableBtn).toBe(`en:${rule!.id}`);

    const enabled = await c.handleCallback(owner, enableBtn!);
    expect(cbText(enabled)).toContain("Rule enabled");
    expect(engine.calls("POST", `/v1/rules/${rule!.id}/enable`)).toHaveLength(1);
    expect(engine.calls("POST", `/v1/rules/${rule!.id}/enable`)[0]!.body).toEqual({ ownerChatId: "1001" });
    expect(rule!.status).toBe("active");
  });

  it("works end to end without any LLM (guided flow) and says it is not AI", async () => {
    const c = makeController(client, null);
    let replies = await c.handleCommand(owner, "newrule", "");
    expect(textOf(replies)).toContain("AI parsing is off");
    replies = await c.handleText(owner, "https://github.com/acme/app");
    replies = await c.handleText(owner, "`reward-ready`");
    replies = await c.handleText(owner, "amazon US");
    expect(buttonData(replies)).toContain("pr:0");
    replies = (await c.handleCallback(owner, "pr:0")).replies;
    expect(buttonData(replies)).toEqual(expect.arrayContaining(["pk:0", "pk:1"])); // choose $5 / $10
    replies = (await c.handleCallback(owner, "pk:1")).replies;
    replies = (await c.handleCallback(owner, "rc:me")).replies;
    for (const v of ["1", "3", "10", "0"]) replies = await c.handleText(owner, v);
    expect(engine.calls("POST", "/v1/rules")[0]!.body).toMatchObject({
      repository: "acme/app",
      requiredLabel: "reward-ready",
      packageId: "mock-amazon-us-10",
      autoApproveUpToUsdCents: 0,
    });
  });

  it("2. asks for missing fields instead of guessing", async () => {
    const c = makeController(client, stubInterpreter({ productQuery: "flipkart", packageValue: 50, packageCurrency: "INR" }));
    let replies = await c.handleText(owner, "send me a flipkart card when something is merged");
    expect(textOf(replies)).toContain("Which GitHub repository");
    expect(engine.calls("GET", "/v1/products")).toHaveLength(0); // no catalog search until the basics are known
    replies = await c.handleText(owner, "not a repo!!");
    expect(textOf(replies)).toContain("doesn't look like a repository");
    replies = await c.handleText(owner, "acme/app");
    expect(textOf(replies)).toContain("Which PR label");
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);
  });

  it("rejects bad limits and enforces auto-approve <= per-purchase <= daily <= monthly", async () => {
    const c = makeController(client, stubInterpreter(FULL_PROPOSAL));
    await c.handleText(owner, "go");
    await c.handleCallback(owner, "pr:0");
    await c.handleCallback(owner, "rc:me");
    expect(textOf(await c.handleText(owner, "0"))).toContain("greater than $0.00");
    await c.handleText(owner, "5"); // per purchase $5
    expect(textOf(await c.handleText(owner, "2"))).toContain("can't be lower than the per-purchase cap");
    await c.handleText(owner, "10"); // daily
    expect(textOf(await c.handleText(owner, "5"))).toContain("can't be lower than the daily cap");
    await c.handleText(owner, "50"); // monthly
    expect(textOf(await c.handleText(owner, "6"))).toContain("can't exceed the per-purchase cap");
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);
  });

  it("never converts an INR budget into a USD cap silently", async () => {
    const c = makeController(
      client,
      stubInterpreter({ ...FULL_PROPOSAL, budgetHints: [{ scope: "monthly", amount: 500, currency: "INR" }] }),
    );
    await c.handleText(owner, "go");
    await c.handleCallback(owner, "pr:0");
    await c.handleCallback(owner, "rc:me");
    await c.handleText(owner, "2");
    const monthly = await c.handleText(owner, "5");
    expect(textOf(monthly)).toContain("INR 500");
    expect(textOf(monthly)).toContain("won't convert silently");
    expect(textOf(await c.handleText(owner, "₹500"))).toContain("won't convert currencies silently");
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);
  });
});

describe("catalog safety", () => {
  it("3a. strips product/package IDs an LLM might invent", () => {
    const p = parseProposal(
      JSON.stringify({ intent: "create_rule", productId: "FAKE-ID", packageId: "FAKE-PKG", dailyCapUsdCents: 999999, productQuery: "flipkart" }),
    );
    expect(p).not.toHaveProperty("productId");
    expect(p).not.toHaveProperty("packageId");
    expect(p).not.toHaveProperty("dailyCapUsdCents");
    expect(() => parseProposal("not json")).toThrow();
    expect(() => parseProposal(JSON.stringify({ intent: "buy_everything" }))).toThrow();
  });

  it("3b. ignores a product button that wasn't offered", async () => {
    const c = makeController(client, stubInterpreter(FULL_PROPOSAL));
    await c.handleText(owner, "go");
    const cb = await c.handleCallback(owner, "pr:99");
    expect(cbText(cb)).toContain("expired");
    expect(engine.requests.filter((r) => /^\/v1\/products\/(?!search)/.test(r.path))).toHaveLength(0);
  });

  it("3c. refuses to submit an invented product ID to POST /v1/rules", async () => {
    const c = makeController(client, null);
    const draft = {
      repository: "acme/app",
      requiredLabel: "reward-ready",
      product: { id: "totally-invented-id", name: "Fake", country: "IN", currency: "INR" },
      pkg: { packageId: "invented-pkg", value: 50 },
      recipientChatId: "1001",
      perPurchaseCapUsdCents: 200,
      dailyCapUsdCents: 500,
      monthlyCapUsdCents: 2000,
      autoApproveUpToUsdCents: 150,
    };
    await expect(c.createDraftRule("1001", draft)).rejects.toBeInstanceOf(UserFacingError);
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);

    // Real product but a package that doesn't belong to it.
    await expect(
      c.createDraftRule("1001", { ...draft, product: { id: "mock-flipkart-in", name: "Flipkart", country: "IN", currency: "INR" } }),
    ).rejects.toBeInstanceOf(UserFacingError);
    // Out of stock.
    await expect(
      c.createDraftRule("1001", {
        ...draft,
        product: { id: "mock-soldout-in", name: "SoldOutStore", country: "IN", currency: "INR" },
        pkg: { packageId: "mock-soldout-in-100", value: 100 },
      }),
    ).rejects.toBeInstanceOf(UserFacingError);
    expect(engine.calls("POST", "/v1/rules")).toHaveLength(0);
  });

  it("does not offer out-of-stock products", async () => {
    const c = makeController(client, null);
    await c.handleCommand(owner, "newrule", "");
    await c.handleText(owner, "acme/app");
    await c.handleText(owner, "reward-ready");
    const replies = await c.handleText(owner, "soldoutstore");
    expect(textOf(replies)).toContain("none are in stock");
    expect(buttonData(replies)).not.toContain("pr:0");
  });
});

describe("authorization", () => {
  it("5. a non-owner cannot manage rules or approve spending", async () => {
    const c = makeController(client, stubInterpreter(FULL_PROPOSAL));
    const attempts = [
      await c.handleCommand(stranger, "rules", ""),
      await c.handleCommand(stranger, "newrule", ""),
      await c.handleCommand(stranger, "enable", ""),
      await c.handleText(stranger, "buy me a gift card whenever PRs merge"),
    ];
    for (const r of attempts) expect(textOf(r)).toContain("private");
    for (const data of ["ap:p-1", "rj:p-1", "en:r-1", "pa:r-1", "rs:r-1"]) {
      const res = await c.handleCallback(stranger, data);
      expect(res.toast).toBe("Not authorized");
      expect(res.replies).toEqual([]);
    }
    // Even the owner's ID is refused from a group chat.
    const inGroup = { userId: "1001", chatId: "-500", chatType: "supergroup" };
    expect(await c.handleCommand(inGroup, "rules", "")).toEqual([]);
    expect((await c.handleCallback(inGroup, "ap:p-1")).toast).toBe("Not authorized");

    expect(engine.requests.filter((r) => r.path.startsWith("/v1"))).toHaveLength(0);
    // /whoami works for anyone, since setup depends on it, and reveals only their own IDs.
    expect(textOf(await c.handleCommand(stranger, "whoami", ""))).toContain("2002");
  });
});

describe("approvals", () => {
  it("10. approve and reject buttons call POST /v1/approvals/:id with the right decision", async () => {
    const c = makeController(client, null);
    const res = await c.handleCallback(owner, "ap:purchase-1");
    // The mock has no such purchase -> engine 404 is surfaced, nothing pretends to succeed.
    expect(cbText(res)).toContain("Nothing was changed");

    engine.purchases.push({ id: "purchase-2", ownerChatId: "1001", recipientChatId: "1001", status: "awaiting_approval", invoiceId: null, amountUsdCents: 120 });
    const ok = await c.handleCallback(owner, "ap:purchase-2");
    expect(ok.toast).toBe("Approved");
    const approvals = engine.calls("POST", "/v1/approvals/purchase-2");
    expect(approvals[0]!.body).toEqual({ ownerChatId: "1001", decision: "approve" });
    expect(approvals[0]!.authorization).toBe(`Bearer ${TOKEN}`);

    engine.purchases.push({ id: "purchase-3", ownerChatId: "1001", recipientChatId: "1001", status: "awaiting_approval", invoiceId: null, amountUsdCents: 120 });
    const no = await c.handleCallback(owner, "rj:purchase-3");
    expect(no.toast).toBe("Rejected");
    expect(engine.calls("POST", "/v1/approvals/purchase-3")[0]!.body).toEqual({ ownerChatId: "1001", decision: "reject" });
    expect(engine.purchases.find((p) => p.id === "purchase-3")!.status).toBe("rejected");
    // Approving doesn't claim success; it waits for the engine's delivery notification.
    expect(cbText(ok)).not.toMatch(/delivered/i);
  });
});

describe("engine client", () => {
  it("9. sends the Bearer token on every /v1 call and rejects a wrong token", async () => {
    await client.searchProducts("flipkart", "IN");
    await client.listRules("1001");
    await client.listNotifications(20);
    const v1 = engine.requests.filter((r) => r.path.startsWith("/v1"));
    expect(v1).toHaveLength(3);
    for (const r of v1) expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    expect(engine.requests.find((r) => r.path === "/v1/products/search")!.query).toEqual({ query: "flipkart", country: "IN" });

    const bad = new EngineClient({ baseUrl: engine.url, token: "wrong" });
    await expect(bad.listRules("1001")).rejects.toMatchObject({ kind: "unauthorized" });
    // /health is unauthenticated per the contract, so no token goes out.
    await client.health();
    expect(engine.requests.at(-1)!.authorization).toBeUndefined();
  });
});

describe("engine offline", () => {
  it("13. replies sensibly and changes nothing when the engine is down", async () => {
    await engine.stop();
    const c = makeController(client, null);

    const rules = await c.handleCommand(owner, "rules", "");
    expect(textOf(rules)).toContain("can't reach the PactPilot engine");

    await c.handleCommand(owner, "newrule", "");
    await c.handleText(owner, "acme/app");
    await c.handleText(owner, "reward-ready");
    const search = await c.handleText(owner, "flipkart");
    expect(textOf(search)).toContain("can't reach the PactPilot engine");

    const approve = await c.handleCallback(owner, "ap:whatever");
    expect(cbText(approve)).toContain("can't reach the PactPilot engine");
    expect(cbText(approve)).not.toMatch(/approved/i);

    await expect(client.listRules("1001")).rejects.toBeInstanceOf(EngineError);
    // Restart so afterEach can stop again cleanly.
    await engine.start();
  });
});
