import { z } from "zod";

const idString = z.union([z.string(), z.number()]).transform(String);

export const PackageSchema = z.object({ packageId: z.string(), value: z.number() }).loose();

export const ProductSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.string(),
    currency: z.string(),
    inStock: z.boolean(),
    packages: z.array(PackageSchema),
  })
  .loose();

export const RuleSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    name: z.string().nullish(),
    ownerChatId: idString.nullish(),
    recipientChatId: idString.nullish(),
    repository: z.string().nullish(),
    requiredLabel: z.string().nullish(),
    productId: z.string().nullish(),
    packageId: z.string().nullish(),
    perPurchaseCapUsdCents: z.number().nullish(),
    dailyCapUsdCents: z.number().nullish(),
    monthlyCapUsdCents: z.number().nullish(),
    autoApproveUpToUsdCents: z.number().nullish(),
  })
  .loose();

export const PurchaseSchema = z
  .object({
    id: z.string(),
    ruleId: z.string().nullish(),
    status: z.string(),
    invoiceId: z.string().nullish(),
    amountUsdCents: z.number().nullish(),
    createdAt: z.string().nullish(),
  })
  .loose();

export const RedemptionSchema = z
  .object({
    code: z.string().nullish(),
    pin: z.string().nullish(),
    link: z.string().nullish(),
    instructions: z.string().nullish(),
  })
  .loose();

export const NotificationSchema = z
  .object({
    id: z.string(),
    chatId: idString,
    type: z.string(),
    text: z.string().nullish(),
    purchaseId: z.string().nullish(),
    invoiceId: z.string().nullish(),
    approvalPurchaseId: z.string().nullish(),
    redemption: RedemptionSchema.nullish(),
  })
  .loose();

export type Product = z.infer<typeof ProductSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Purchase = z.infer<typeof PurchaseSchema>;
export type Notification = z.infer<typeof NotificationSchema>;

export interface CreateRuleBody {
  ownerChatId: string;
  recipientChatId: string;
  name: string;
  repository: string;
  requiredLabel: string;
  productId: string;
  packageId: string;
  perPurchaseCapUsdCents: number;
  dailyCapUsdCents: number;
  monthlyCapUsdCents: number;
  autoApproveUpToUsdCents: number;
}

export interface GithubTrigger {
  deliveryId: string;
  repository: string;
  prNumber: number;
  merged: boolean;
  labels: string[];
  authorLogin: string;
  mergedAt: string;
}

export interface TriggerResult {
  accepted: boolean;
  eventId?: string;
  reason?: string;
}

export interface EngineHealth {
  ok: boolean;
  service: string;
  livePurchasesEnabled: boolean;
}

/** Everything the chat service needs from the engine. The engine is the only authority for spending. */
export interface EngineApi {
  health(): Promise<EngineHealth>;
  searchProducts(query: string, country: string): Promise<Product[]>;
  getProduct(id: string): Promise<Product>;
  createRule(body: CreateRuleBody): Promise<Rule>;
  listRules(ownerChatId: string): Promise<Rule[]>;
  enableRule(id: string, ownerChatId: string): Promise<Rule | null>;
  pauseRule(id: string, ownerChatId: string): Promise<Rule | null>;
  resumeRule(id: string, ownerChatId: string): Promise<Rule | null>;
  sendGithubTrigger(event: GithubTrigger): Promise<TriggerResult>;
  decideApproval(purchaseId: string, ownerChatId: string, decision: "approve" | "reject"): Promise<unknown>;
  listPurchases(ownerChatId: string): Promise<Purchase[]>;
  listNotifications(limit: number): Promise<Notification[]>;
  ackNotification(id: string): Promise<void>;
}
