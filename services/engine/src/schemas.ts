import { z } from 'zod';
export const chatId = z.string().regex(/^-?[1-9]\d{0,19}$/, 'A nonzero Telegram chat ID is required');
export const ruleSchema = z.object({
  ownerChatId: chatId, recipientChatId: chatId, name: z.string().trim().min(1).max(150),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(250).transform(x => x.toLowerCase()),
  requiredLabel: z.string().min(1).max(100), productId: z.string().min(1).max(500), packageId: z.string().min(1).max(500),
  perPurchaseCapUsdCents: z.number().int().positive().max(2_000_000_000),
  dailyCapUsdCents: z.number().int().positive().max(2_000_000_000),
  monthlyCapUsdCents: z.number().int().positive().max(2_000_000_000),
  autoApproveUpToUsdCents: z.number().int().min(0).max(2_000_000_000)
}).strict().refine(x => x.autoApproveUpToUsdCents <= x.perPurchaseCapUsdCents && x.perPurchaseCapUsdCents <= x.dailyCapUsdCents && x.dailyCapUsdCents <= x.monthlyCapUsdCents,
{ message: 'Limits must satisfy automatic <= per-purchase <= daily <= monthly' });
export const triggerSchema = z.object({
  deliveryId: z.string().min(1).max(200),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(250).transform(x => x.toLowerCase()),
  prNumber: z.number().int().positive().max(2147483647), merged: z.boolean(),
  labels: z.array(z.string().max(100)).max(100), authorLogin: z.string().min(1).max(100), mergedAt: z.string().datetime({ offset: true })
}).strict();
export type RuleInput = z.infer<typeof ruleSchema>;
export type TriggerInput = z.infer<typeof triggerSchema>;
