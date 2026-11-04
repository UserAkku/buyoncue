import { readFileSync } from "node:fs";
import { bedrockConfig } from "./bedrock.js";
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
  // GitHub App (optional as a group; see loadConfig).
  GITHUB_APP_ID: optional(z.string().regex(/^\d+$/, "must be the numeric GitHub App ID")),
  GITHUB_APP_CLIENT_ID: optional(z.string()),
  GITHUB_APP_CLIENT_SECRET: optional(z.string()),
  GITHUB_APP_PRIVATE_KEY: optional(z.string()),
  GITHUB_OAUTH_CALLBACK_URL: optional(z.string().url()),
  GITHUB_APP_INSTALL_URL: optional(z.string().url()),
  PUBLIC_CHAT_URL: optional(z.string().url()),
  // Test/GHES hooks. Default to github.com.
  GITHUB_API_URL: optional(z.string().url()),
  GITHUB_WEB_URL: optional(z.string().url()),
  CHAT_STATE_FILE: optional(z.string()),
});

export interface GithubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  /** PEM, normalized. Never log it. */
  privateKey: string;
  oauthCallbackUrl: string;
  installUrl: string;
  /** Public base URL of this service, no trailing slash. */
  publicUrl: string;
  apiUrl: string;
  webUrl: string;
}

const GITHUB_APP_REQUIRED = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_OAUTH_CALLBACK_URL",
  "GITHUB_APP_INSTALL_URL",
  "PUBLIC_CHAT_URL",
] as const;

/** Accepts a PEM with real newlines, with literal "\\n" escapes, or base64 of the PEM. */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim().replace(/^"|"$/g, "");
  if (!key.includes("BEGIN")) {
    try {
      key = Buffer.from(key, "base64").toString("utf8");
    } catch {
      /* fall through to the validation below */
    }
  }
  key = key.replace(/\\n/g, "\n");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key (raw, \\n-escaped, or base64)");
  }
  return key;
}

export interface Config {
  telegramBotToken: string;
  ownerUserId: string | null;
  engineUrl: string;
  internalApiToken: string;
  githubWebhookSecret: string;
  llm: { apiKey: string; baseUrl: string; model: string; fetchImpl?: typeof fetch } | null;
  port: number;
  /** null = GitHub App features disabled (legacy webhook + rules still work). */
  github: GithubAppConfig | null;
  stateFile: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const prepared = {...env};
  if(env.GITHUB_APP_PRIVATE_KEY_PATH) {
    if(env.GITHUB_APP_PRIVATE_KEY)throw new Error("Configure a private key path or inline PEM, not both");
    try {prepared.GITHUB_APP_PRIVATE_KEY=readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH,"utf8");}catch{throw new Error("Cannot read GITHUB_APP_PRIVATE_KEY_PATH");}
  }
  const parsed = EnvSchema.safeParse(prepared);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const github = buildGithubConfig(e);
  // The LLM is all-or-nothing: a partial configuration falls back to guided mode.
  const llm = bedrockConfig(env,'CHAT') ?? (e.LLM_API_KEY && e.LLM_BASE_URL && e.LLM_MODEL
    ? { apiKey: e.LLM_API_KEY, baseUrl: e.LLM_BASE_URL.replace(/\/+$/, ""), model: e.LLM_MODEL }
    : null);
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    ownerUserId: e.TELEGRAM_OWNER_USER_ID ?? null,
    engineUrl: e.ENGINE_URL.replace(/\/+$/, ""),
    internalApiToken: e.INTERNAL_API_TOKEN,
    githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET,
    llm,
    port: e.PORT,
    github,
    stateFile: e.CHAT_STATE_FILE ?? ".data/chat-state.json",
  };
}

function buildGithubConfig(e: z.infer<typeof EnvSchema>): GithubAppConfig | null {
  const present = GITHUB_APP_REQUIRED.filter((k) => e[k] !== undefined);
  if (present.length === 0) return null;
  const missing = GITHUB_APP_REQUIRED.filter((k) => e[k] === undefined);
  const problems: string[] = missing.map((k) => `  - ${k}: required when any GitHub App setting is present`);
  if (missing.length === 0) {
    const publicUrl = e.PUBLIC_CHAT_URL!.replace(/\/+$/, "");
    const host = new URL(publicUrl).hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    if (!local && !publicUrl.startsWith("https://")) problems.push("  - PUBLIC_CHAT_URL: must be https (GitHub OAuth and Telegram buttons require it)");
    if (e.GITHUB_OAUTH_CALLBACK_URL!.replace(/\/+$/, "") !== `${publicUrl}/auth/github/callback`) {
      problems.push(`  - GITHUB_OAUTH_CALLBACK_URL: must equal PUBLIC_CHAT_URL + /auth/github/callback (${publicUrl}/auth/github/callback)`);
    }
  }
  let privateKey = "";
  if (e.GITHUB_APP_PRIVATE_KEY) {
    try {
      privateKey = normalizePrivateKey(e.GITHUB_APP_PRIVATE_KEY);
    } catch (err) {
      problems.push(`  - GITHUB_APP_PRIVATE_KEY: ${(err as Error).message.replace("GITHUB_APP_PRIVATE_KEY ", "")}`);
    }
  }
  if (problems.length) throw new Error(`Invalid GitHub App configuration:\n${problems.join("\n")}`);
  return {
    appId: e.GITHUB_APP_ID!,
    clientId: e.GITHUB_APP_CLIENT_ID!,
    clientSecret: e.GITHUB_APP_CLIENT_SECRET!,
    privateKey,
    oauthCallbackUrl: e.GITHUB_OAUTH_CALLBACK_URL!,
    installUrl: e.GITHUB_APP_INSTALL_URL!,
    publicUrl: e.PUBLIC_CHAT_URL!.replace(/\/+$/, ""),
    apiUrl: (e.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    webUrl: (e.GITHUB_WEB_URL ?? "https://github.com").replace(/\/+$/, ""),
  };
}
