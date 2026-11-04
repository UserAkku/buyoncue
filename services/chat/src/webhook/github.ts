import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { z } from "zod";
import { EngineError } from "../engine/client.js";
import type { EngineApi, GithubTrigger, TriggerResult } from "../engine/types.js";
import type { Logger } from "../logger.js";

/** Verifies GitHub's `X-Hub-Signature-256` over the raw request bytes. */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  // timingSafeEqual throws on length mismatch, so check first (length isn't secret).
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const PullRequestEventSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string().min(1) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().nullish(),
    merged_at: z.string().nullish(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    user: z.object({ login: z.string() }),
  }),
});

export type Normalized =
  | { kind: "trigger"; trigger: GithubTrigger }
  | { kind: "ignored"; reason: string };

/**
 * Turns a raw GitHub delivery into the engine's trigger body, or says why it's ignored.
 * Only the structured fields listed here are read. PR titles, bodies and comments are
 * never extracted, so untrusted text cannot reach the LLM or the engine.
 */
export function normalizeEvent(eventName: string | undefined, deliveryId: string, payload: unknown): Normalized {
  if (eventName !== "pull_request") return { kind: "ignored", reason: `event_${eventName ?? "unknown"}` };
  const parsed = PullRequestEventSchema.safeParse(payload);
  if (!parsed.success) return { kind: "ignored", reason: "malformed_payload" };
  const { action, repository, pull_request: pr } = parsed.data;
  if (action !== "closed") return { kind: "ignored", reason: `action_${action}` };
  if (pr.merged !== true || !pr.merged_at) return { kind: "ignored", reason: "not_merged" };
  return {
    kind: "trigger",
    trigger: {
      deliveryId,
      repository: repository.full_name,
      prNumber: pr.number,
      merged: true,
      labels: pr.labels.map((l) => l.name),
      authorLogin: pr.user.login,
      mergedAt: pr.merged_at,
    },
  };
}

export interface WebhookDeps {
  secret: string;
  engine: EngineApi;
  logger: Logger;
  /** Optional hook to tell the owner what the engine decided about a trigger (IDs only). */
  onTriggerResult?: (trigger: GithubTrigger, result: TriggerResult) => Promise<void> | void;
}

export function createApp(deps: WebhookDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "chat" });
  });

  // Raw bytes are required: the signature covers the exact body GitHub sent.
  app.post("/webhooks/github", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.header("x-github-delivery");

    if (!verifySignature(deps.secret, raw, req.header("x-hub-signature-256"))) {
      deps.logger.warn("webhook_rejected", { reason: "bad_signature", deliveryId });
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    const eventName = req.header("x-github-event");
    if (eventName === "ping") {
      res.json({ ok: true, pong: true });
      return;
    }
    if (!deliveryId) {
      res.status(400).json({ error: "missing X-GitHub-Delivery" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }

    const normalized = normalizeEvent(eventName, deliveryId, payload);
    if (normalized.kind === "ignored") {
      deps.logger.info("webhook_ignored", { deliveryId, reason: normalized.reason });
      res.status(200).json({ ok: true, ignored: normalized.reason });
      return;
    }

    try {
      const result = await deps.engine.sendGithubTrigger(normalized.trigger);
      deps.logger.info("trigger_forwarded", {
        deliveryId,
        eventId: result.eventId,
        accepted: result.accepted,
        reason: result.reason,
      });
      try {
        await deps.onTriggerResult?.(normalized.trigger, result);
      } catch (err) {
        deps.logger.warn("trigger_notify_failed", { deliveryId, reason: (err as Error).message });
      }
      res.status(202).json({ ok: true, accepted: result.accepted, eventId: result.eventId, reason: result.reason });
    } catch (err) {
      const kind = err instanceof EngineError ? err.kind : "unknown";
      deps.logger.error("trigger_forward_failed", { deliveryId, kind });
      // 5xx makes GitHub mark the delivery failed so it can be redelivered. The engine dedups on deliveryId.
      res.status(502).json({ error: "engine unavailable" });
    }
  });

  return app;
}
