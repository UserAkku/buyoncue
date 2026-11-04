import express, { type Express, type Response } from "express";
import type { GithubAppConfig } from "../config.js";
import { EngineError } from "../engine/client.js";
import type { BountyEngineApi } from "../engine/bounty-types.js";
import { code, esc } from "../html.js";
import type { Logger } from "../logger.js";
import type { Button } from "../bot/types.js";
import type { StateStore } from "../state.js";
import type { GithubApp } from "./app.js";
import { type LinkSession, type LinkSessions, safeEqual, type VerifiedIdentity } from "./sessions.js";

export interface AuthRouteDeps {
  cfg: GithubAppConfig;
  github: Pick<GithubApp, "exchangeCode" | "fetchUserContext" | "revokeUserToken">;
  sessions: LinkSessions;
  engine: Pick<BountyEngineApi, "linkGithub">;
  store: StateStore;
  logger: Logger;
  notify: (chatId: string, html: string, buttons?: Button[][]) => Promise<void>;
  /** Called after a maintainer confirmed their GitHub identity: shows the repository picker in Telegram. */
  onMaintainerConnected: (session: LinkSession, identity: VerifiedIdentity) => Promise<void>;
  botUsername?: string;
}

const COOKIE = "bc_bind";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function page(res: Response, status: number, title: string, bodyHtml: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1rem;color:#1f2328}h1{font-size:1.25rem}button,a.btn{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #1f2328;background:#1f2328;color:#fff;text-decoration:none;cursor:pointer}code{background:#eee;padding:0 .25rem;border-radius:.2rem}.muted{color:#656d76}</style>` +
        `</head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`,
    );
}

const invalid = (res: Response) =>
  page(res, 400, "Link expired or invalid", `<p>This link is no longer valid. Go back to Telegram and send the command again to get a new one.</p>`);

export function registerGithubAuthRoutes(app: Express, d: AuthRouteDeps): void {
  const secure = d.cfg.publicUrl.startsWith("https://");
  const setBinding = (res: Response, binding: string) =>
    res.cookie(COOKIE, binding, { httpOnly: true, secure, sameSite: "lax", path: "/auth/github", maxAge: 10 * 60_000 });

  // 1. Telegram button -> here -> GitHub authorize
  app.get("/auth/github/start", (req, res) => {
    const sid = typeof req.query.s === "string" ? req.query.s : "";
    const issued = d.sessions.issueState(sid, "oauth");
    if (!issued) return invalid(res);
    setBinding(res, issued.binding);
    const url = new URL(`${d.cfg.webUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", d.cfg.clientId);
    url.searchParams.set("redirect_uri", d.cfg.oauthCallbackUrl);
    url.searchParams.set("state", issued.state);
    url.searchParams.set("allow_signup", "false");
    res.redirect(302, url.toString());
  });

  // 2. GitHub -> here. Never trusts anything but the single-use state and the server-side code exchange.
  app.get("/auth/github/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const codeParam = typeof req.query.code === "string" ? req.query.code : "";
    const session = d.sessions.consumeState(state, "oauth"); // burns the state: replays fail
    if (!session) return invalid(res);
    if (!d.sessions.bindingMatches(session, readCookie(req.headers.cookie, COOKIE))) {
      d.logger.warn("oauth_binding_mismatch", { purpose: session.purpose });
      return invalid(res);
    }
    if (req.query.error || !codeParam) {
      return page(res, 200, "Authorization cancelled", `<p>GitHub was not connected. You can close this tab and try again from Telegram.</p>`);
    }

    let token: string | null = null;
    try {
      token = await d.github.exchangeCode(codeParam);
      const ctx = await d.github.fetchUserContext(token);
      const verified = d.sessions.setVerified(session.id, ctx);
      if (!verified) return invalid(res);

      if (session.purpose === "maintainer" && !ctx.hasInstallation) {
        return page(
          res,
          200,
          "Install the GitHub App",
          `<p>You are signed in as <code>${esc(ctx.githubLogin)}</code>, but this app isn't installed on any of your repositories yet.</p>` +
            `<p>Install it on <b>one repository</b> (read-only access), then you will be brought back here.</p>` +
            `<p><a class="btn" href="/auth/github/install?s=${encodeURIComponent(session.id)}">Install the GitHub App</a></p>`,
        );
      }
      // Always ask the browser user to confirm which accounts are being tied together.
      return page(
        res,
        200,
        "Confirm account link",
        `<p>Link GitHub account <b>${esc(ctx.githubLogin)}</b> (ID <code>${esc(ctx.githubUserId)}</code>) to the Telegram account <b>${esc(session.displayName)}</b> (ID <code>${esc(session.telegramUserId)}</code>)?</p>` +
          (session.purpose === "contributor"
            ? `<p class="muted">Bounty rewards for your merged pull requests will be sent to that Telegram account. Only continue if you started this from the PactPilot bot yourself.</p>`
            : `<p class="muted">You will then pick the repository to reward in Telegram. The app has read-only access.</p>`) +
          `<form method="post" action="/auth/github/confirm"><input type="hidden" name="sid" value="${esc(session.id)}"><input type="hidden" name="token" value="${esc(verified.confirmToken)}"><button type="submit">Confirm</button></form>`,
      );
    } catch (err) {
      d.logger.warn("oauth_callback_failed", { purpose: session.purpose, reason: err instanceof Error ? err.message.slice(0, 60) : "unknown" });
      return page(res, 502, "GitHub didn't respond", `<p>Something went wrong talking to GitHub. Go back to Telegram and start again.</p>`);
    } finally {
      if (token) void d.github.revokeUserToken(token); // short-lived by design: we never keep it
    }
  });

  // 2b. Installation selection. GitHub sends the user to the app's install page and back with our own `state`.
  app.get("/auth/github/install", (req, res) => {
    const sid = typeof req.query.s === "string" ? req.query.s : "";
    const session = d.sessions.get(sid);
    if (!session || session.purpose !== "maintainer" || !session.verified) return invalid(res);
    if (!d.sessions.bindingMatches(session, readCookie(req.headers.cookie, COOKIE))) return invalid(res);
    const issued = d.sessions.issueState(sid, "install");
    if (!issued) return invalid(res);
    const url = new URL(d.cfg.installUrl);
    url.searchParams.set("state", issued.state);
    res.redirect(302, url.toString());
  });

  // GitHub "Setup URL". The installation_id query value is NOT trusted: we send the user back through
  // OAuth, and only installations GitHub lists for the authenticated user are ever used.
  app.get("/auth/github/install/callback", (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const session = d.sessions.consumeState(state, "install");
    if (!session || !d.sessions.bindingMatches(session, readCookie(req.headers.cookie, COOKIE))) return invalid(res);
    res.redirect(302, `/auth/github/start?s=${encodeURIComponent(session.id)}`);
  });

  // 3. Browser confirmation (POST, SameSite cookie + per-session token), then bind and notify Telegram.
  app.post("/auth/github/confirm", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    const sid = typeof req.body?.sid === "string" ? req.body.sid : "";
    const tokenField = typeof req.body?.token === "string" ? req.body.token : "";
    const session = d.sessions.get(sid);
    if (!session?.verified || !safeEqual(session.verified.confirmToken, tokenField)) return invalid(res);
    if (!d.sessions.bindingMatches(session, readCookie(req.headers.cookie, COOKIE))) return invalid(res);
    const identity = session.verified;

    try {
      await d.engine.linkGithub({
        githubUserId: identity.githubUserId,
        githubLogin: identity.githubLogin,
        telegramUserId: session.telegramUserId,
        chatId: session.chatId,
      });
    } catch (err) {
      if (err instanceof EngineError && err.kind === "http" && err.status === 409) {
        d.sessions.complete(session.id);
        await d.notify(session.chatId, `⚠️ GitHub account ${code(identity.githubLogin)} is already linked to a different Telegram account, so I did not change anything. Its owner must run /unlinkgithub first.`).catch(() => {});
        return page(res, 409, "Already linked", `<p>That GitHub account is already linked to another Telegram account. Nothing was changed.</p>`);
      }
      d.logger.warn("link_engine_failed", { purpose: session.purpose });
      return page(res, 502, "Couldn't save the link", `<p>The service couldn't save this link right now. You can press Back and Confirm again in a minute.</p>`);
    }

    d.store.setLink(session.telegramUserId, { githubUserId: identity.githubUserId, githubLogin: identity.githubLogin, linkedAt: new Date().toISOString() });
    d.sessions.complete(session.id); // single use
    res.clearCookie(COOKIE, { path: "/auth/github" });
    d.logger.info("github_linked", { purpose: session.purpose, githubUserId: identity.githubUserId });

    try {
      if (session.purpose === "maintainer") await d.onMaintainerConnected(session, identity);
      else {
        await d.notify(
          session.chatId,
          `✅ Linked GitHub ${code(identity.githubLogin)} (ID ${code(identity.githubUserId)}) to this Telegram account.\nRewards for your merged pull requests will be delivered here, privately. Not you? Send /unlinkgithub.`,
        );
      }
    } catch {
      d.logger.warn("link_notify_failed", { purpose: session.purpose });
    }
    const back = d.botUsername ? `<p><a class="btn" href="https://t.me/${esc(d.botUsername)}">Return to Telegram</a></p>` : `<p>You can return to Telegram.</p>`;
    return page(res, 200, "Connected", `<p>Done. GitHub account <b>${esc(identity.githubLogin)}</b> is linked.</p>${back}`);
  });
}
