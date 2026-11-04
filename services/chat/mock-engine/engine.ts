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
      const bounty = this.bountyRules.get(act[1]!);
      const rule = this.rules.get(act[1]!) ?? bounty;
      if (!rule || rule.ownerChatId !== body?.ownerChatId) return send(404, { error: "rule not found" });
      rule.status = act[2] === "pause" ? "paused" : bounty ? "enabled" : "active";
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

  // ---- AI bounty endpoints: a lightweight fake of the CANONICAL engine contract (services/engine/BOUNTY_API.md).
  // The real engine is exercised end to end in tests/integration/ai-bounty-e2e.test.ts.
  readonly links = new Map<string, any>(); // telegramUserId -> { telegramUserId, githubUserId:number, githubLogin, verifiedAt, revoked }
  readonly repositories = new Map<number, any>();
  readonly bountyRules = new Map<string, any>();
  readonly reviews = new Map<string, any>();
  readonly awards = new Map<string, any>(); // `${repositoryId}#${pr}` -> award
  /** What the fake "AI" returns. Tests override. */
  mockScore = { score: 81, subscores: { correctness: 24, tests: 20, feedback: 17, maintainability: 12, security: 8 } };
  mockCandidate: any = { tier: 2, minScore: 70, maxScore: 84, faceValueINR: 100, requiresApproval: false, enabled: true };
  mockReviewState = "REVIEWED";
  mockEligibility: "ELIGIBLE" | "HOLD" = "ELIGIBLE";
  mockReasons: string[] = [];
  mockFinalAccepted = true;
  mockReceiptStatus = "QUEUED";
  mockReceiptInvoice: string | null = null;
  mockReceiptOrders: { id: string; status: string }[] = [];

  private static readonly EVIDENCE_KEYS = ["installationId", "repositoryId", "repositoryFullName", "repositoryPrivate", "prNumber", "headSha", "baseSha", "authorGithubUserId", "authorLogin", "authorIsBot", "merged", "collectedAt", "title", "description", "labels", "files", "commits", "checks", "reviews", "linkedIssues", "evidenceTruncated", "ciComplete", "maintainerAuthorization"];

  private handleBounty(m: string, path: string, url: URL, body: any, send: (s: number, j: unknown) => void): boolean {
    const err = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    const bad = (why: string) => (err(400, "INVALID_REQUEST", why), true);
    const exact = (o: any, keys: string[]) => o && typeof o === "object" && Object.keys(o).sort().join() === [...keys].sort().join();
    const positiveInt = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
    if (m === "POST" && path === "/v1/github/links") {
      if (!exact(body, ["telegramUserId", "githubUserId", "githubLogin", "verificationSource", "verifiedAt"]) || !positiveInt(body.githubUserId) || body.verificationSource !== "github_oauth" || !/^[1-9]\d{0,14}$/.test(String(body.telegramUserId))) return bad("bad link body");
      const clash = [...this.links.values()].find((l) => l.githubUserId === body.githubUserId && l.telegramUserId !== body.telegramUserId);
      const mine = this.links.get(body.telegramUserId);
      if (clash || (mine && mine.githubUserId !== body.githubUserId)) return err(409, "IDENTITY_CONFLICT", "Verified identity is already linked to another account"), true;
      const link = { telegramUserId: body.telegramUserId, githubUserId: body.githubUserId, githubLogin: body.githubLogin, verifiedAt: body.verifiedAt, verificationSource: "github_oauth", revoked: false };
      this.links.set(body.telegramUserId, link);
      return send(201, { link }), true;
    }
    if (m === "POST" && path === "/v1/github/links/unlink") {
      if (!exact(body, ["telegramUserId"])) return bad("bad unlink body");
      const l = this.links.get(body.telegramUserId);
      const unlinked = !!l && !l.revoked;
      if (l) l.revoked = true;
      return send(200, { unlinked }), true;
    }
    if (m === "POST" && path === "/v1/repositories/connect") {
      if (!exact(body, ["ownerTelegramUserId", "repositoryId", "repositoryFullName", "installationId", "verifiedOwnerAccess", "repositoryPrivate"]) || body.verifiedOwnerAccess !== true || !positiveInt(body.repositoryId) || !positiveInt(body.installationId)) return bad("bad connect body");
      const owner = this.links.get(body.ownerTelegramUserId);
      if (!owner || owner.revoked) return err(403, "OWNER_IDENTITY_NOT_VERIFIED", "Maintainer must link GitHub through OAuth first"), true;
      const prior = this.repositories.get(body.repositoryId);
      if (prior && (prior.ownerTelegramUserId !== body.ownerTelegramUserId || prior.installationId !== body.installationId)) return err(409, "REPOSITORY_OWNERSHIP_CONFLICT", "conflict"), true;
      const repository = { repositoryId: body.repositoryId, installationId: body.installationId, repositoryFullName: String(body.repositoryFullName).toLowerCase(), ownerTelegramUserId: body.ownerTelegramUserId, ownerGithubUserId: owner.githubUserId, repositoryPrivate: body.repositoryPrivate };
      this.repositories.set(body.repositoryId, repository);
      return send(201, { repository }), true;
    }
    if (m === "GET" && path === "/v1/repositories") {
      const owner = url.searchParams.get("ownerTelegramUserId");
      return send(200, { repositories: [...this.repositories.values()].filter((r) => r.ownerTelegramUserId === owner) }), true;
    }
    if (m === "GET" && path === "/v1/bounty-rules") {
      const owner = url.searchParams.get("ownerTelegramUserId");
      return send(200, { rules: [...this.bountyRules.values()].filter((r) => r.ownerTelegramUserId === owner) }), true;
    }
    if (m === "POST" && path === "/v1/bounty-rules") {
      if (!exact(body, ["ownerTelegramUserId", "repositoryId", "requiredLabel", "mode", "requireMerged", "requireSuccessfulCI", "scoreThreshold", "tiers", "autoApproveUpToUsdCents", "perPurchaseCapUsdCents", "dailyCapUsdCents", "monthlyCapUsdCents", "allowSelfReward"]) || body.mode !== "ai_contribution_bounty" || body.requireMerged !== true || !body.requiredLabel || !(body.scoreThreshold >= 50)) return bad("bad rule body");
      const repo = this.repositories.get(body.repositoryId);
      if (!repo || repo.ownerTelegramUserId !== body.ownerTelegramUserId) return err(403, "REPOSITORY_NOT_AUTHORIZED", "Repository is not connected for this maintainer"), true;
      if ([...this.bountyRules.values()].some((r) => r.repositoryId === body.repositoryId)) return err(409, "BOUNTY_POLICY_EXISTS", "exists"), true;
      for (const t of body.tiers) {
        if (!exact(t, ["minScore", "maxScore", "faceValueINR", "productId", "packageId", "requiresApproval"])) return bad("bad tier");
        const p = this.products.find((x) => x.id === t.productId);
        const pkg = p?.packages.find((k) => k.packageId === t.packageId);
        if (!p || p.currency !== "INR" || p.country !== "IN" || !pkg || pkg.value !== t.faceValueINR) return err(400, "UNVERIFIED_TIER", "Tier must match an exact Indian INR catalogue package"), true;
      }
      const rule = { id: randomUUID(), status: "draft", kind: "bounty", name: "AI contribution bounty", repositoryId: body.repositoryId, installationId: repo.installationId, ownerTelegramUserId: body.ownerTelegramUserId, ownerChatId: body.ownerTelegramUserId, ownerGithubUserId: repo.ownerGithubUserId, policyVersion: 1, mode: body.mode, requiredLabel: body.requiredLabel, requireSuccessfulCI: body.requireSuccessfulCI, scoreThreshold: body.scoreThreshold, tiers: body.tiers.map((t: any) => ({ ...t, enabled: true })), perPurchaseCapUsdCents: body.perPurchaseCapUsdCents, dailyCapUsdCents: body.dailyCapUsdCents, monthlyCapUsdCents: body.monthlyCapUsdCents, autoApproveUpToUsdCents: body.autoApproveUpToUsdCents };
      this.bountyRules.set(rule.id, rule);
      return send(201, { rule }), true;
    }
    if (m === "POST" && path === "/v1/contributions/review") {
      if (!body || typeof body !== "object") return bad("bad evidence");
      const unknown = Object.keys(body).filter((k) => !MockEngine.EVIDENCE_KEYS.includes(k));
      const missing = MockEngine.EVIDENCE_KEYS.filter((k) => !(k in body));
      if (unknown.length || missing.length || !positiveInt(body.repositoryId) || !positiveInt(body.installationId) || !positiveInt(body.authorGithubUserId) || !/^[a-f0-9]{40}$/.test(body.headSha) || !/^[a-f0-9]{40}$/.test(body.baseSha)) return bad(`bad evidence: unknown=${unknown} missing=${missing}`);
      const repo = this.repositories.get(body.repositoryId);
      if (!repo || repo.installationId !== body.installationId) return err(403, "REPOSITORY_NOT_AUTHORIZED", "No approved repository bounty policy"), true;
      const { collectedAt: _c, ...stable } = body;
      const key = JSON.stringify(stable);
      const prior = [...this.reviews.values()].find((r) => r.key === key);
      if (prior) return send(202, { reviewId: prior.reviewId, state: prior.state, eligibilityState: "HOLD" }), true;
      for (const r of this.reviews.values()) if (r.request.repositoryId === body.repositoryId && r.request.prNumber === body.prNumber) r.state = "STALE";
      const review = { reviewId: randomUUID(), key, request: body, state: "QUEUED" as string, finalizedFor: null as string | null };
      this.reviews.set(review.reviewId, review);
      return send(202, { reviewId: review.reviewId, state: "QUEUED", eligibilityState: "HOLD" }), true;
    }
    const getRev = path.match(/^\/v1\/contributions\/([^/]+)$/);
    if (m === "GET" && getRev) {
      const r = this.reviews.get(getRev[1]!);
      if (!r) return err(404, "REVIEW_NOT_FOUND", "Contribution review not found"), true;
      if (r.state === "QUEUED") r.state = this.mockReviewState;
      return send(200, this.reviewView(r)), true;
    }
    const fin = path.match(/^\/v1\/contributions\/([^/]+)\/finalize$/);
    if (m === "POST" && fin) {
      const r = this.reviews.get(fin[1]!);
      if (!r) return err(404, "REVIEW_NOT_FOUND", "Contribution review not found"), true;
      if (!exact(body, ["githubDeliveryId", "repositoryId", "prNumber", "headSha", "merged"])) return bad("bad finalize body");
      if (body.repositoryId !== r.request.repositoryId || body.prNumber !== r.request.prNumber) return err(409, "FINALIZATION_IDENTITY_MISMATCH", "mismatch"), true;
      if (body.headSha !== r.request.headSha) return send(200, { accepted: false, reviewId: r.reviewId, state: "STALE", eligibilityState: "HOLD", reasons: ["FINAL_SHA_MISMATCH"] }), true;
      const reasons = [...(r.request.merged ? [] : ["FINAL_MERGED_REVIEW_REQUIRED"]), ...(body.merged ? [] : ["NOT_MERGED"]), ...this.mockReasons];
      if (reasons.length || !this.mockFinalAccepted) return send(200, { accepted: false, reviewId: r.reviewId, state: r.state, eligibilityState: "HOLD", reasons }), true;
      const k = `${body.repositoryId}#${body.prNumber}`;
      const existing = this.awards.get(k);
      if (existing) return send(202, { accepted: true, reviewId: r.reviewId, reason: "duplicate_pr", awardId: existing.awardId, purchaseId: existing.purchaseId }), true;
      const award = { awardId: randomUUID(), purchaseId: randomUUID() };
      this.awards.set(k, award);
      return send(202, { accepted: true, reviewId: r.reviewId, reason: "queued", ...award }), true;
    }
    const rc = path.match(/^\/v1\/bounty-receipts\/([^/]+)$/);
    if (m === "GET" && rc) {
      const a = [...this.awards.entries()].find(([, v]) => v.purchaseId === rc[1]);
      if (!a) return err(404, "RECEIPT_NOT_FOUND", "Bounty receipt not found"), true;
      return send(200, { receipt: { purchaseId: rc[1], mode: "test", status: this.mockReceiptStatus, invoiceId: this.mockReceiptInvoice, amountUsdCents: null, invoiceStatus: null, errorCode: null, score: this.mockScore.score, tier: this.mockCandidate?.tier ?? null, faceValueINR: this.mockCandidate?.faceValueINR ?? null, prNumber: Number(a[0].split("#")[1]), orders: this.mockReceiptOrders } }), true;
    }
    return false;
  }

  private reviewView(r: any) {
    const done = r.state === "REVIEWED";
    return {
      reviewId: r.reviewId,
      ruleId: [...this.bountyRules.values()].find((b) => b.repositoryId === r.request.repositoryId)?.id ?? null,
      policyVersion: 1,
      repositoryId: r.request.repositoryId,
      prNumber: r.request.prNumber,
      headSha: r.request.headSha,
      authorGithubUserId: r.request.authorGithubUserId,
      state: r.state,
      eligibilityState: done ? this.mockEligibility : "HOLD",
      reasons: done ? this.mockReasons : r.state === "STALE" ? ["SUPERSEDED_EVIDENCE"] : [],
      score: done ? this.mockScore.score : null,
      subscores: done ? this.mockScore.subscores : null,
      confidence: done ? 0.95 : null,
      findings: done ? [{ severity: "info", message: "Mock finding", evidenceRefs: ["goal"] }] : [],
      reasoningSummary: done ? "Mock summary" : null,
      riskFlags: [],
      candidateTier: done ? this.mockCandidate : null,
      model: "mock-reviewer",
      validUntil: new Date(Date.now() + 3600_000).toISOString(),
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
