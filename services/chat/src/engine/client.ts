import { z } from "zod";
import {
  type BountyEngineApi,
  type BountyRule,
  BountyRuleSchema,
  type ConnectedRepository,
  ConnectedRepositorySchema,
  type ConnectRepositoryBody,
  type ContributionReview,
  ContributionReviewSchema,
  type CreateBountyRuleBody,
  type FinalizeBody,
  type GithubLink,
  GithubLinkSchema,
  type LinkGithubBody,
  type SubmitReviewBody,
} from "./bounty-types.js";
import {
  type CreateRuleBody,
  type EngineApi,
  type EngineHealth,
  type GithubTrigger,
  type Notification,
  NotificationSchema,
  type Product,
  ProductSchema,
  type Purchase,
  PurchaseSchema,
  type Rule,
  RuleSchema,
  type TriggerResult,
} from "./types.js";

export type EngineErrorKind = "offline" | "unauthorized" | "http" | "invalid_response";

export class EngineError extends Error {
  constructor(
    public readonly kind: EngineErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EngineClient implements EngineApi, BountyEngineApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EngineClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new EngineError("offline", "Engine unreachable; request outcome may be unknown");
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new EngineError("unauthorized", "Engine rejected the internal API token", res.status);
    }
    if (!res.ok) {
      const detail = extractErrorMessage(json) ?? `HTTP ${res.status}`;
      throw new EngineError("http", detail, res.status);
    }
    return json;
  }

  private parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
    const r = schema.safeParse(value);
    if (!r.success) throw new EngineError("invalid_response", `Unexpected engine response for ${what}`);
    return r.data;
  }

  async health(): Promise<EngineHealth> {
    const json = await this.request("GET", "/health", undefined, false);
    return this.parse(
      z.object({ ok: z.boolean(), service: z.string(), livePurchasesEnabled: z.boolean().default(false) }).loose(),
      json,
      "health",
    );
  }

  async searchProducts(query: string, country: string): Promise<Product[]> {
    const qs = new URLSearchParams({ query, country });
    const json = await this.request("GET", `/v1/products/search?${qs}`);
    return this.parse(z.object({ products: z.array(ProductSchema) }), json, "product search").products;
  }

  async getProduct(id: string): Promise<Product> {
    const json = await this.request("GET", `/v1/products/${encodeURIComponent(id)}`);
    return this.parse(z.object({ product: ProductSchema }), json, "product").product;
  }

  async createRule(body: CreateRuleBody): Promise<Rule> {
    const json = await this.request("POST", "/v1/rules", body);
    return this.parse(z.object({ rule: RuleSchema }), json, "rule").rule;
  }

  async listRules(ownerChatId: string): Promise<Rule[]> {
    const json = await this.request("GET", `/v1/rules?${new URLSearchParams({ ownerChatId })}`);
    return this.parse(z.object({ rules: z.array(RuleSchema) }), json, "rules").rules;
  }

  private async ruleAction(action: "enable" | "pause" | "resume", id: string, ownerChatId: string): Promise<Rule | null> {
    const json = await this.request("POST", `/v1/rules/${encodeURIComponent(id)}/${action}`, { ownerChatId });
    const r = z.object({ rule: RuleSchema }).safeParse(json);
    return r.success ? r.data.rule : null;
  }

  enableRule(id: string, ownerChatId: string) {
    return this.ruleAction("enable", id, ownerChatId);
  }
  pauseRule(id: string, ownerChatId: string) {
    return this.ruleAction("pause", id, ownerChatId);
  }
  resumeRule(id: string, ownerChatId: string) {
    return this.ruleAction("resume", id, ownerChatId);
  }

  async sendGithubTrigger(event: GithubTrigger): Promise<TriggerResult> {
    const json = await this.request("POST", "/v1/triggers/github", event);
    return this.parse(
      z.object({ accepted: z.boolean(), eventId: z.string().optional(), reason: z.string().optional() }).loose(),
      json,
      "trigger",
    );
  }

  decideApproval(purchaseId: string, ownerChatId: string, decision: "approve" | "reject"): Promise<unknown> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(purchaseId)}`, { ownerChatId, decision });
  }

  async listPurchases(ownerChatId: string): Promise<Purchase[]> {
    const json = await this.request("GET", `/v1/purchases?${new URLSearchParams({ ownerChatId })}`);
    return this.parse(z.object({ purchases: z.array(PurchaseSchema) }), json, "purchases").purchases;
  }

  async listNotifications(limit: number): Promise<Notification[]> {
    const json = await this.request("GET", `/v1/notifications?limit=${limit}`);
    return this.parse(z.object({ items: z.array(NotificationSchema) }), json, "notifications").items;
  }

  async ackNotification(id: string): Promise<void> {
    await this.request("POST", `/v1/notifications/${encodeURIComponent(id)}/ack`, {});
  }

  // ---- AI bounty endpoints (see bounty-types.ts)

  async linkGithub(body: LinkGithubBody): Promise<GithubLink> {
    const json = await this.request("POST", "/v1/github/links", body);
    return this.parse(z.object({ link: GithubLinkSchema }), json, "github link").link;
  }

  async unlinkGithub(telegramUserId: string): Promise<void> {
    await this.request("POST", "/v1/github/links/unlink", { telegramUserId });
  }

  async connectRepository(body: ConnectRepositoryBody): Promise<ConnectedRepository> {
    const json = await this.request("POST", "/v1/repositories/connect", body);
    return this.parse(z.object({ repository: ConnectedRepositorySchema }), json, "repository").repository;
  }

  async listRepositories(ownerChatId: string): Promise<ConnectedRepository[]> {
    const json = await this.request("GET", `/v1/repositories?${new URLSearchParams({ ownerChatId })}`);
    return this.parse(z.object({ repositories: z.array(ConnectedRepositorySchema) }), json, "repositories").repositories;
  }

  async disconnectRepository(repositoryId: string, reason: string): Promise<void> {
    await this.request("POST", `/v1/repositories/${encodeURIComponent(repositoryId)}/disconnect`, { reason });
  }

  async createBountyRule(body: CreateBountyRuleBody): Promise<BountyRule> {
    const json = await this.request("POST", "/v1/bounty-rules", body);
    return this.parse(z.object({ bountyRule: BountyRuleSchema }), json, "bounty rule").bountyRule;
  }

  async bountyRuleAction(id: string, action: "enable" | "pause" | "resume", ownerChatId: string): Promise<BountyRule | null> {
    const json = await this.request("POST", `/v1/bounty-rules/${encodeURIComponent(id)}/${action}`, { ownerChatId });
    const r = z.object({ bountyRule: BountyRuleSchema }).safeParse(json);
    return r.success ? r.data.bountyRule : null;
  }

  async submitReview(body: SubmitReviewBody): Promise<ContributionReview> {
    const json = await this.request("POST", "/v1/contributions/review", body);
    return this.parse(z.object({ review: ContributionReviewSchema }), json, "review").review;
  }

  async getReview(reviewId: string): Promise<ContributionReview> {
    const json = await this.request("GET", `/v1/contributions/${encodeURIComponent(reviewId)}`);
    return this.parse(z.object({ review: ContributionReviewSchema }), json, "review").review;
  }

  async finalizeReview(reviewId: string, body: FinalizeBody): Promise<ContributionReview> {
    const json = await this.request("POST", `/v1/contributions/${encodeURIComponent(reviewId)}/finalize`, body);
    return this.parse(z.object({ review: ContributionReviewSchema }), json, "review").review;
  }
}

function extractErrorMessage(json: unknown): string | null {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const key of ["error", "message", "reason"]) {
      const v = o[key];
      if (typeof v === "string" && v) return v.slice(0, 300);
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).message === "string") {
        return String((v as Record<string, unknown>).message).slice(0, 300);
      }
    }
  }
  return null;
}
