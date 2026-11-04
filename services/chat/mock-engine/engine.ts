/**
 * Mock of the frozen PactPilot engine HTTP contract. For local development and tests ONLY.
 * It never talks to Bitrefill. Every ID, invoice and redemption code it produces is fake
 * and prefixed "MOCK" so it can't be mistaken for a real purchase.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockProduct {
  id: string;
  name: string;
  country: string;
  currency: string;
  inStock: boolean;
  packages: { packageId: string; value: number }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  body: any;
}

export interface MockRule {
  id: string;
  status: string;
  [k: string]: any;
}

export interface MockNotification {
  id: string;
  chatId: string;
  type: string;
  text: string;
  purchaseId: string | null;
  invoiceId: string | null;
  approvalPurchaseId: string | null;
  redemption: { code: string | null; pin: string | null; link: string | null; instructions: string | null } | null;
  acked: boolean;
}

export interface MockEngineOptions {
  token: string;
  /** Simulated USD cost of any purchase triggered through this mock. */
  mockCostCents?: number;
  livePurchasesEnabled?: boolean;
}

export const FIXTURE_PRODUCTS: MockProduct[] = [
  {
    id: "mock-flipkart-in",
    name: "Flipkart",
    country: "IN",
    currency: "INR",
    inStock: true,
    packages: [
      { packageId: "mock-flipkart-in-50", value: 50 },
      { packageId: "mock-flipkart-in-100", value: 100 },
      { packageId: "mock-flipkart-in-500", value: 500 },
    ],
  },
  {
    id: "mock-amazon-us",
    name: "Amazon",
    country: "US",
    currency: "USD",
    inStock: true,
    packages: [
      { packageId: "mock-amazon-us-5", value: 5 },
      { packageId: "mock-amazon-us-10", value: 10 },
    ],
  },
  {
    id: "mock-soldout-in",
    name: "SoldOutStore",
    country: "IN",
    currency: "INR",
    inStock: false,
    packages: [{ packageId: "mock-soldout-in-100", value: 100 }],
  },
];

export class MockEngine {
  readonly products: MockProduct[] = structuredClone(FIXTURE_PRODUCTS);
  readonly rules = new Map<string, MockRule>();
  readonly notifications: MockNotification[] = [];
  readonly purchases: any[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly seenDeliveries = new Set<string>();
  private server: Server | null = null;
  url = "";

  constructor(private readonly opts: MockEngineOptions) {}

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  calls(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  pushNotification(n: Partial<MockNotification> & { chatId: string; type: string }): MockNotification {
    const full: MockNotification = {
      id: randomUUID(),
      text: "",
      purchaseId: null,
      invoiceId: null,
      approvalPurchaseId: null,
      redemption: null,
      acked: false,
      ...n,
    };
    this.notifications.push(full);
    return full;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;
    this.requests.push({
      method: req.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      body,
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };

    if (req.method === "GET" && path === "/health") {
      return send(200, { ok: true, service: "engine", livePurchasesEnabled: this.opts.livePurchasesEnabled ?? false });
    }
    if (req.headers.authorization !== `Bearer ${this.opts.token}`) return send(401, { error: "unauthorized" });

    const m = req.method;
    if (m === "GET" && path === "/v1/products/search") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const country = (url.searchParams.get("country") ?? "").toUpperCase();
      return send(200, {
        products: this.products.filter((p) => p.name.toLowerCase().includes(q) && (!country || p.country === country)),
      });
    }
    const prod = path.match(/^\/v1\/products\/([^/]+)$/);
    if (m === "GET" && prod) {
      const p = this.products.find((x) => x.id === decodeURIComponent(prod[1]!));
      return p ? send(200, { product: p }) : send(404, { error: "product not found" });
    }
    if (m === "POST" && path === "/v1/rules") {
      const p = this.products.find((x) => x.id === body.productId);
      if (!p) return send(404, { error: "product not found" });
      if (!p.packages.some((k) => k.packageId === body.packageId)) return send(400, { error: "package not found" });
      const rule: MockRule = { id: randomUUID(), status: "draft", ...body };
      this.rules.set(rule.id, rule);
      return send(201, { rule });
    }
    if (m === "GET" && path === "/v1/rules") {
      const owner = url.searchParams.get("ownerChatId");
      return send(200, { rules: [...this.rules.values()].filter((r) => r.ownerChatId === owner) });
    }
    const act = path.match(/^\/v1\/rules\/([^/]+)\/(enable|pause|resume)$/);
    if (m === "POST" && act) {
      const rule = this.rules.get(act[1]!);
      if (!rule || rule.ownerChatId !== body?.ownerChatId) return send(404, { error: "rule not found" });
      rule.status = act[2] === "pause" ? "paused" : "active";
      return send(200, { rule });
    }
    if (m === "POST" && path === "/v1/triggers/github") return send(202, this.onTrigger(body));
    const appr = path.match(/^\/v1\/approvals\/([^/]+)$/);
    if (m === "POST" && appr) {
      const purchase = this.purchases.find((p) => p.id === appr[1]);
      if (!purchase) return send(404, { error: "purchase not found" });
      if (purchase.ownerChatId !== body.ownerChatId) return send(403, { error: "not the owner" });
      if (body.decision === "approve") this.deliver(purchase);
      else purchase.status = "rejected";
      return send(200, { ok: true, status: purchase.status });
    }
    if (m === "GET" && path === "/v1/purchases") {
      return send(200, { purchases: this.purchases.filter((p) => p.ownerChatId === url.searchParams.get("ownerChatId")) });
    }
    if (m === "GET" && path === "/v1/notifications") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const items = this.notifications.filter((n) => !n.acked).slice(0, limit).map(({ acked: _a, ...n }) => n);
      return send(200, { items });
    }
    const ack = path.match(/^\/v1\/notifications\/([^/]+)\/ack$/);
    if (m === "POST" && ack) {
      const n = this.notifications.find((x) => x.id === ack[1]);
      if (n) n.acked = true;
      return send(200, { ok: true });
    }
    if (this.handleBounty(m ?? "GET", path, url, body, send)) return;
    return send(404, { error: "not found" });
  }

  // ---- AI bounty endpoints (working assumption of the contract; see docs/BOUNTY_ENGINE_CONTRACT.md)
  readonly links = new Map<string, any>(); // telegramUserId -> link
  readonly repositories = new Map<string, any>();
  readonly bountyRules = new Map<string, any>();
  readonly reviews = new Map<string, any>();
  /** What the mock "AI" returns. Tests override. */
  mockScore = {
    total: 81,
    max: 100,
    breakdown: [
      { category: "Correctness", score: 24, max: 30 },
      { category: "Tests/CI", score: 20, max: 25 },
      { category: "Review", score: 17, max: 20 },
      { category: "Maintainability", score: 12, max: 15 },
      { category: "Security", score: 8, max: 10 },
    ],
  };
  mockTier: string | null = "Tier 2";
  mockFinalStatus: string = "pending_approval";

  private handleBounty(m: string, path: string, url: URL, body: any, send: (s: number, j: unknown) => void): boolean {
    const err = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (m === "POST" && path === "/v1/github/links") {
      const clash = [...this.links.values()].find((l) => l.githubUserId === body.githubUserId && l.telegramUserId !== body.telegramUserId);
      if (clash) return err(409, "LINK_CONFLICT", "GitHub account already linked"), true;
      const link = { githubUserId: body.githubUserId, githubLogin: body.githubLogin, telegramUserId: body.telegramUserId, chatId: body.chatId, linkedAt: new Date().toISOString() };
      this.links.set(body.telegramUserId, link);
      return send(201, { link }), true;
    }
    if (m === "POST" && path === "/v1/github/links/unlink") {
      this.links.delete(body.telegramUserId);
      return send(200, { ok: true }), true;
    }
    if (m === "POST" && path === "/v1/repositories/connect") {
      const repository = { repositoryId: body.repositoryId, installationId: body.installationId, fullName: body.fullName, ownerChatId: body.ownerChatId, status: "connected" };
      this.repositories.set(body.repositoryId, repository);
      return send(201, { repository }), true;
    }
    if (m === "GET" && path === "/v1/repositories") {
      const owner = url.searchParams.get("ownerChatId");
      const repositories = [...this.repositories.values()].filter((r) => r.ownerChatId === owner).map((r) => ({ ...r, bountyRule: [...this.bountyRules.values()].find((b) => b.repositoryId === r.repositoryId) ?? null }));
      return send(200, { repositories }), true;
    }
    const disc = path.match(/^\/v1\/repositories\/([^/]+)\/disconnect$/);
    if (m === "POST" && disc) {
      const r = this.repositories.get(decodeURIComponent(disc[1]!));
      if (r) r.status = "disconnected";
      return send(200, { ok: true }), true;
    }
    if (m === "POST" && path === "/v1/bounty-rules") {
      if (!this.repositories.has(body.repositoryId)) return err(404, "REPOSITORY_NOT_FOUND", "repository not connected"), true;
      for (const t of body.tiers) {
        const p = this.products.find((x) => x.id === t.productId);
        if (!p || !p.packages.some((k) => k.packageId === t.packageId)) return err(404, "PRODUCT_NOT_FOUND", "unknown product or package"), true;
      }
      const bountyRule = { id: randomUUID(), status: "draft", ...body };
      this.bountyRules.set(bountyRule.id, bountyRule);
      return send(201, { bountyRule }), true;
    }
    const ract = path.match(/^\/v1\/bounty-rules\/([^/]+)\/(enable|pause|resume)$/);
    if (m === "POST" && ract) {
      const rule = this.bountyRules.get(ract[1]!);
      if (!rule || rule.ownerChatId !== body?.ownerChatId) return err(404, "NOT_FOUND", "bounty rule not found"), true;
      rule.status = ract[2] === "pause" ? "paused" : "active";
      return send(200, { bountyRule: rule }), true;
    }
    if (m === "POST" && path === "/v1/contributions/review") {
      const prior = [...this.reviews.values()].find((r) => r.idempotencyKey === body.idempotencyKey);
      if (prior) return send(200, { review: this.reviewView(prior) }), true;
      if (body.supersedesReviewId) {
        const old = this.reviews.get(body.supersedesReviewId);
        if (old) old.status = "superseded";
      }
      const review = { reviewId: randomUUID(), idempotencyKey: body.idempotencyKey, status: "completed", repositoryId: body.repositoryId, prNumber: body.prNumber, headSha: body.headSha, purpose: body.purpose, request: body, finalization: null as any };
      this.reviews.set(review.reviewId, review);
      return send(202, { review: this.reviewView(review) }), true;
    }
    const getRev = path.match(/^\/v1\/contributions\/([^/]+)$/);
    if (m === "GET" && getRev) {
      const r = this.reviews.get(getRev[1]!);
      return r ? send(200, { review: this.reviewView(r) }) : err(404, "NOT_FOUND", "review not found"), true;
    }
    const fin = path.match(/^\/v1\/contributions\/([^/]+)\/finalize$/);
    if (m === "POST" && fin) {
      const r = this.reviews.get(fin[1]!);
      if (!r) return err(404, "NOT_FOUND", "review not found"), true;
      if (body.expectedHeadSha !== r.headSha) return err(409, "HEAD_SHA_MISMATCH", "review is for a different commit"), true;
      r.finalizeRequest = body;
      r.finalization = { status: this.mockFinalStatus, tier: this.mockTier, purchaseId: null, invoiceId: this.mockFinalStatus === "delivered" ? "MOCK-INV-BOUNTY" : null };
      return send(200, { review: this.reviewView(r) }), true;
    }
    return false;
  }

  private reviewView(r: any) {
    const superseded = r.status === "superseded";
    return {
      reviewId: r.reviewId,
      status: r.status,
      repositoryId: r.repositoryId,
      prNumber: r.prNumber,
      headSha: r.headSha,
      provisional: r.finalization ? false : true,
      score: superseded ? null : this.mockScore,
      candidateTier: superseded ? null : this.mockTier,
      summary: "Mock summary",
      finalization: r.finalization,
    };
  }

  private onTrigger(t: any): { accepted: boolean; eventId: string; reason: string } {
    const eventId = randomUUID();
    if (this.seenDeliveries.has(t.deliveryId)) return { accepted: true, eventId, reason: "duplicate_delivery" };
    this.seenDeliveries.add(t.deliveryId);
    const rule = [...this.rules.values()].find(
      (r) => r.status === "active" && r.repository === t.repository && t.labels.includes(r.requiredLabel),
    );
    if (!rule) return { accepted: true, eventId, reason: "no_matching_rule" };

    const cost = this.opts.mockCostCents ?? 120;
    const purchase = { id: randomUUID(), ruleId: rule.id, ownerChatId: rule.ownerChatId, recipientChatId: rule.recipientChatId, status: "pending", invoiceId: null, amountUsdCents: cost, createdAt: new Date().toISOString() };
    this.purchases.push(purchase);
    if (cost > rule.perPurchaseCapUsdCents) {
      purchase.status = "blocked";
      this.pushNotification({ chatId: rule.ownerChatId, type: "purchase_blocked", text: "Purchase blocked: per-purchase cap exceeded.", purchaseId: purchase.id });
    } else if (cost > rule.autoApproveUpToUsdCents) {
      purchase.status = "awaiting_approval";
      this.pushNotification({ chatId: rule.ownerChatId, type: "approval_required", text: "This purchase needs your approval.", purchaseId: purchase.id, approvalPurchaseId: purchase.id });
    } else {
      this.deliver(purchase);
    }
    return { accepted: true, eventId, reason: "queued" };
  }

  private deliver(purchase: any): void {
    purchase.status = "delivered";
    purchase.invoiceId = `MOCK-INV-${purchase.id.slice(0, 8)}`;
    this.pushNotification({
      chatId: purchase.recipientChatId,
      type: "purchase_delivered",
      text: "Gift card delivered (MOCK ENGINE, not a real purchase).",
      purchaseId: purchase.id,
      invoiceId: purchase.invoiceId,
      redemption: { code: "MOCK-CODE-0000-0000", pin: null, link: null, instructions: "This is fake data from the mock engine." },
    });
  }
}
