import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionPurpose = "maintainer" | "contributor";

export interface VerifiedRepo {
  installationId: string;
  repositoryId: string;
  fullName: string;
  /** Whether GitHub said this user has admin on the repo when the user token was valid. Re-checked at selection. */
  userIsAdmin: boolean;
}

export interface VerifiedIdentity {
  githubUserId: string;
  githubLogin: string;
  repos: VerifiedRepo[];
  hasInstallation: boolean;
  confirmToken: string;
}

export interface LinkSession {
  id: string;
  purpose: SessionPurpose;
  /** Taken from the authenticated Telegram update that started the flow. Never from the browser. */
  telegramUserId: string;
  chatId: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
  /** Random value placed in an HttpOnly cookie so only the browser that started the flow can finish it. */
  browserBinding: string | null;
  verified: VerifiedIdentity | null;
  completed: boolean;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface SessionOptions {
  ttlMs?: number;
  stateTtlMs?: number;
  now?: () => number;
}

/**
 * In-memory, single-use, short-lived linking sessions. A session ID and an OAuth `state`
 * are both unguessable (256-bit); `state` is stored only as a hash and consumed on first use.
 */
export class LinkSessions {
  private readonly sessions = new Map<string, LinkSession>();
  /** sha256(state) -> {sid, kind, expiresAt}. Removed on first use. */
  private readonly states = new Map<string, { sid: string; kind: "oauth" | "install"; expiresAt: number }>();
  private readonly ttl: number;
  private readonly stateTtl: number;
  private readonly now: () => number;

  constructor(opts: SessionOptions = {}) {
    this.ttl = opts.ttlMs ?? 10 * 60_000;
    this.stateTtl = opts.stateTtlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  create(input: { purpose: SessionPurpose; telegramUserId: string; chatId: string; displayName: string }): LinkSession {
    this.purge();
    // One live session per user and purpose: a new request invalidates the previous link.
    for (const s of this.sessions.values()) {
      if (s.telegramUserId === input.telegramUserId && s.purpose === input.purpose) this.sessions.delete(s.id);
    }
    const session: LinkSession = {
      id: token(),
      ...input,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttl,
      browserBinding: null,
      verified: null,
      completed: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** A session that exists, hasn't expired and hasn't been completed. */
  get(id: string): LinkSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.completed || s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  /** Issues a fresh single-use state for either the OAuth or the app-install redirect. */
  issueState(sid: string, kind: "oauth" | "install"): { state: string; binding: string } | null {
    const s = this.get(sid);
    if (!s) return null;
    s.browserBinding ??= token();
    const state = token();
    this.states.set(sha(state), { sid, kind, expiresAt: Math.min(this.now() + this.stateTtl, s.expiresAt) });
    return { state, binding: s.browserBinding };
  }

  /** Returns the session for a state and burns the state. Unknown, expired or replayed -> null. */
  consumeState(state: string, kind: "oauth" | "install"): LinkSession | null {
    const key = sha(state);
    const entry = this.states.get(key);
    this.states.delete(key);
    if (!entry || entry.kind !== kind || entry.expiresAt <= this.now()) return null;
    return this.get(entry.sid);
  }

  bindingMatches(session: LinkSession, cookieValue: string | undefined): boolean {
    return !!cookieValue && !!session.browserBinding && safeEqual(session.browserBinding, cookieValue);
  }

  setVerified(sid: string, v: Omit<VerifiedIdentity, "confirmToken">): VerifiedIdentity | null {
    const s = this.get(sid);
    if (!s) return null;
    s.verified = { ...v, confirmToken: token() };
    return s.verified;
  }

  complete(sid: string): void {
    const s = this.sessions.get(sid);
    if (s) s.completed = true;
    this.sessions.delete(sid);
    for (const [k, v] of this.states) if (v.sid === sid) this.states.delete(k);
  }

  private purge(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
    for (const [k, v] of this.states) if (v.expiresAt <= t) this.states.delete(k);
  }
}
