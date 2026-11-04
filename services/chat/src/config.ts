import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_OWNER_USER_ID: optional(z.string().regex(/^\d+$/, "must be a positive numeric Telegram user ID")),
  ENGINE_URL: z.preprocess(blank, z.string().url().default("http://localhost:3001")),
  INTERNAL_API_TOKEN: z.string().min(1, "INTERNAL_API_TOKEN is required"),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  LLM_API_KEY: optional(z.string()),
  LLM_BASE_URL: optional(z.string().url()),
  LLM_MODEL: optional(z.string()),
  PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(3002)),
});

export interface Config {
  telegramBotToken: string;
  ownerUserId: string | null;
  engineUrl: string;
  internalApiToken: string;
  githubWebhookSecret: string;
  llm: { apiKey: string; baseUrl: string; model: string } | null;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  // The LLM is all-or-nothing: a partial configuration falls back to guided mode.
  const llm = e.LLM_API_KEY && e.LLM_BASE_URL && e.LLM_MODEL
    ? { apiKey: e.LLM_API_KEY, baseUrl: e.LLM_BASE_URL.replace(/\/+$/, ""), model: e.LLM_MODEL }
    : null;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    ownerUserId: e.TELEGRAM_OWNER_USER_ID ?? null,
    engineUrl: e.ENGINE_URL.replace(/\/+$/, ""),
    internalApiToken: e.INTERNAL_API_TOKEN,
    githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET,
    llm,
    port: e.PORT,
  };
}
