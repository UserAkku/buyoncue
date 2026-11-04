import type { GithubAppConfig } from "../config.js";
import { EngineError } from "../engine/client.js";
import type { BountyEngineApi, BountyTier, ConnectedRepository } from "../engine/bounty-types.js";
import type { EngineApi, Product } from "../engine/types.js";
import { bold, code, esc } from "../html.js";
import type { GithubApp } from "../github/app.js";
import { describeReceipt, renderReview } from "../github/format.js";
import type { GithubPipeline } from "../github/pipeline.js";
import type { LinkSession, LinkSessions, VerifiedIdentity, VerifiedRepo } from "../github/sessions.js";
import type { Logger } from "../logger.js";
import { formatDenomination, formatUsd, parseUsdInput } from "../money.js";
import { type CapKey, checkCap, normalizeLabel, type RuleDraft } from "../rules/draft.js";
import { parseProductQuery } from "../rules/query.js";
import type { ReviewRecord, StateStore } from "../state.js";
import { type Actor, type Button, type CallbackResult, type Reply, UserFacingError } from "./types.js";

/** Commands any Telegram user may run in a private chat. They only touch the caller's own identity. */
export const CONTRIBUTOR_COMMANDS = new Set(["linkgithub", "unlinkgithub", "myrewards"]);
/** Commands restricted to the configured owner (the maintainer). */
export const OWNER_COMMANDS = new Set(["connectgithub", "repositories", "setbounty", "review", "bounties"]);
export const CONTRIBUTOR_CALLBACKS = new Set(["uly", "ucn"]);
export const OWNER_CALLBACKS = new Set(["sr", "sb", "be", "bp", "br", "rv", "bpr", "bpk", "btc", "bts", "bcap", "rvr"]);

const CANCEL_ROW: Button[] = [{ text: "✖️ Cancel", data: "cancel" }];
const FLOW_TTL_MS = 30 * 60_000;
const PICK_TTL_MS = 10 * 60_000;
/** The engine never rewards scores below 50. */
const MIN_REWARD_SCORE = 50;

const CAP_ORDER: { step: BStep; key: CapKey; title: string }[] = [
  { step: "cap_per", key: "perPurchaseCapUsdCents", title: `💳 ${bold("Per-reward hard cap")} (USD): the most one reward purchase may cost. Anything above is blocked.` },
  { step: "cap_daily", key: "dailyCapUsdCents", title: `📅 ${bold("Daily cap")} (USD)` },
  { step: "cap_monthly", key: "monthlyCapUsdCents", title: `🗓 ${bold("Monthly cap")} (USD)` },
  { step: "cap_auto", key: "autoApproveUpToUsdCents", title: `✅ ${bold("Auto-approve threshold")} (USD): rewards up to this are bought automatically; above it I ask you first. Send 0 to approve every reward by hand.` },
];
const CAP_PRESETS: Record<CapKey, number[]> = {
  perPurchaseCapUsdCents: [100, 200, 500],
  dailyCapUsdCents: [200, 500, 1000],
  monthlyCapUsdCents: [1000, 2000, 5000],
  autoApproveUpToUsdCents: [0, 100, 150],
};

type BStep = "label" | "product_query" | "product_pick" | "tier_count" | "tier_score" | "tier_package" | "cap_per" | "cap_daily" | "cap_monthly" | "cap_auto";

interface BountyFlow {
  kind: "bounty";
  repo: { repositoryId: string; fullName: string };
  step: BStep;
  requiredLabel?: string | null;
  productQuery?: string;
  country?: string;
  products: Product[];
  product?: Product;
  tierCount?: number;
  tiers: { minScore: number; packageId: string; value: number }[];
  pendingScore?: number;
  caps: Partial<Record<CapKey, number>>;
  touchedAt: number;
}
interface ReviewFlow {
  kind: "review";
  repo: { repositoryId: string; installationId: string; fullName: string };
  touchedAt: number;
}
type Flow = BountyFlow | ReviewFlow;

interface PendingPick {
  githubUserId: string;
  githubLogin: string;
  repos: VerifiedRepo[];
  expiresAt: number;
}

export interface GithubFeatureDeps {
  cfg: GithubAppConfig;
  ownerUserId: string;
  engine: EngineApi & BountyEngineApi;
  github: Pick<GithubApp, "getInstallation" | "listInstallationRepositories" | "loginForUserId" | "collaboratorRole">;
  sessions: LinkSessions;
  store: StateStore;
  pipeline: GithubPipeline;
  logger: Logger;
  /** Sends HTML to a Telegram chat; throws if Telegram refuses. */
  notify: (chatId: string, html: string, buttons?: Button[][]) => Promise<void>;
  now?: () => number;
}

const isPrivateOwn = (a: Actor) => a.chatType === "private" && a.chatId === a.userId;

/** Telegram-facing side of the GitHub App integration: linking, repositories, bounty policy, reviews. */
export class GithubFeature {
  private readonly flows = new Map<string, Flow>();
  private readonly picks = new Map<string, PendingPick>();
  private readonly now: () => number;

  constructor(private readonly d: GithubFeatureDeps) {
    this.now = d.now ?? Date.now;
  }

  static looksLikeConnectRequest(text: string): boolean {
    return /\b(connect|link|hook up|integrate)\b.*\bgit ?hub\b|\bgit ?hub\b.*\b(connect|link|integrate)\b/i.test(text);
  }

  helpLines(): string[] {
    return [
      `/connectgithub — connect a repository (maintainer)`,
      `/repositories · /setbounty · /review · /bounties — AI bounties (maintainer)`,
      `/linkgithub · /unlinkgithub · /myrewards — contributors`,
    ];
  }

  hasFlow(chatId: string): boolean {
    const f = this.flows.get(chatId);
    if (f && this.now() - f.touchedAt > FLOW_TTL_MS) this.flows.delete(chatId);
    return this.flows.has(chatId);
  }

  cancel(chatId: string): boolean {
    this.picks.delete(chatId);
    return this.flows.delete(chatId);
  }

  // ------------------------------------------------------------ contributor side

  async handleContributorCommand(a: Actor, cmd: string): Promise<Reply[]> {
    if (!isPrivateOwn(a)) return [{ text: "🔒 Please message me in a private chat for this. Account linking never happens in groups." }];
    switch (cmd) {
      case "linkgithub":
        return this.linkGithub(a);
      case "unlinkgithub":
        return this.unlinkPrompt(a);
      default:
        return this.myRewards(a);
    }
  }

  async handleContributorCallback(a: Actor, kind: string): Promise<CallbackResult> {
    if (!isPrivateOwn(a)) return { replies: [], toast: "Not authorized" };
    if (kind === "ucn") return { replies: [{ text: "Okay, your GitHub link is unchanged." }], toast: "Kept" };
    const link = this.d.store.getLink(a.userId);
    if (!link) return { replies: [{ text: "You don't have a GitHub account linked." }] };
    try {
      await this.d.engine.unlinkGithub(a.userId);
    } catch (err) {
      if (err instanceof EngineError && err.kind === "http" && (err.status === 404 || err.status === 405)) {
        return { replies: [{ text: "⚠️ The engine doesn't support unlinking yet, so your link was kept." }] };
      }
      throw err;
    }
    this.d.store.removeLink(a.userId);
    return { replies: [{ text: `🔓 Unlinked GitHub ${code(link.githubLogin)}. Future rewards will not be sent to you until you /linkgithub again.` }], toast: "Unlinked" };
  }

  private linkGithub(a: Actor): Reply[] {
    const existing = this.d.store.getLink(a.userId);
    if (existing) {
      return [{ text: `You're already linked to GitHub ${code(existing.githubLogin)}. To change it, send /unlinkgithub first.` }];
    }
    const s = this.d.sessions.create({ purpose: "contributor", telegramUserId: a.userId, chatId: a.chatId, displayName: a.displayName ?? "Telegram user" });
    return [
      {
        text: `🔗 Link your GitHub identity so rewards for your merged pull requests reach you.\n\nYou'll sign in on GitHub; I only learn your numeric GitHub ID and username. I never ask you to type a username. This link works once and expires in 10 minutes.`,
        buttons: [[{ text: "Connect GitHub", url: `${this.d.cfg.publicUrl}/auth/github/start?s=${s.id}` }]],
      },
    ];
  }

  private unlinkPrompt(a: Actor): Reply[] {
    const link = this.d.store.getLink(a.userId);
    if (!link) return [{ text: "You don't have a GitHub account linked. Use /linkgithub." }];
    return [
      {
        text: `Unlink GitHub ${code(link.githubLogin)} from this Telegram account? You won't receive rewards until you link again.`,
        buttons: [[{ text: "Yes, unlink", data: "uly" }, { text: "Keep it", data: "ucn" }]],
      },
    ];
  }

  private async myRewards(a: Actor): Promise<Reply[]> {
    const link = this.d.store.getLink(a.userId);
    if (!link) return [{ text: "Link your GitHub account first with /linkgithub, then your rewards will show up here." }];
    const records = this.d.store.listReviews((r) => r.authorGithubId === link.githubUserId && !r.supersededBy, 8);
    if (!records.length) return [{ text: `No rewards yet for GitHub ${code(link.githubLogin)}. Rewards appear after a reviewed pull request is merged.` }];
    const lines = await Promise.all(records.map((r) => this.summaryLine(r)));
    return [{ text: [`🎁 ${bold("Your rewards")} (${code(link.githubLogin)})`, ...lines, "", "Gift cards arrive in this chat, privately, once the engine confirms delivery."].join("\n") }];
  }

  // ------------------------------------------------------------ owner commands

  async handleOwnerCommand(a: Actor, cmd: string, args: string): Promise<Reply[]> {
    switch (cmd) {
      case "connectgithub":
        return this.connectGithub(a);
      case "repositories":
        return this.repositories(a);
      case "setbounty":
        return this.setBounty(a, args);
      case "review":
        return this.reviewCommand(a, args);
      default:
        return this.bounties();
    }
  }

  connectGithub(a: Actor): Reply[] {
    const s = this.d.sessions.create({ purpose: "maintainer", telegramUserId: a.userId, chatId: a.chatId, displayName: a.displayName ?? "Owner" });
    return [
      {
        text:
          `Let's connect GitHub securely. I'll need <b>read access</b> to your selected repository so I can inspect pull requests, checks and reviews. The app can't change code or merge anything.\n\n` +
          `You'll sign in on GitHub, install or authorize the app for one repository, then come back here to choose it. The link works once and expires in 10 minutes.`,
        buttons: [[{ text: "Connect GitHub", url: `${this.d.cfg.publicUrl}/auth/github/start?s=${s.id}` }]],
      },
    ];
  }

  /** Called by the OAuth confirm route once the maintainer's GitHub identity is verified. */
  async onMaintainerConnected(session: LinkSession, identity: VerifiedIdentity): Promise<void> {
    const eligible = identity.repos.filter((r) => r.userIsAdmin);
    this.picks.set(session.chatId, { githubUserId: identity.githubUserId, githubLogin: identity.githubLogin, repos: eligible, expiresAt: this.now() + PICK_TTL_MS });
    if (!eligible.length) {
      const why = identity.repos.length
        ? `You can reach ${identity.repos.length} repositor${identity.repos.length === 1 ? "y" : "ies"} through the app, but you need <b>admin</b> rights on a repository to set up spending rules for it.`
        : `The app isn't installed on any repository you can access yet.`;
      await this.d.notify(session.chatId, `✅ Signed in to GitHub as ${code(identity.githubLogin)}.\n\n${why}\nFix that on GitHub, then send /connectgithub again.`);
      return;
    }
    const rows = eligible.slice(0, 10).map((r, i): Button[] => [{ text: r.fullName, data: `sr:${i}` }]);
    await this.d.notify(session.chatId, `✅ GitHub connected as ${code(identity.githubLogin)}.\nWhich repository should earn rewards?`, [...rows, CANCEL_ROW]);
  }

  /** Re-verifies everything against GitHub before the engine is told about the repository. */
  private async connectRepository(a: Actor, index: number): Promise<Reply[]> {
    const pick = this.picks.get(a.chatId);
    const repo = pick && pick.expiresAt > this.now() ? pick.repos[index] : undefined;
    if (!pick || !repo) return [{ text: "That selection expired. Send /connectgithub to start again." }];

    // 1. The installation must exist and be active for this app.
    let installation;
    try {
      installation = await this.d.github.getInstallation(repo.installationId);
    } catch {
      return [{ text: "⚠️ GitHub doesn't recognise that installation of the app. Nothing was connected." }];
    }
    if (installation.suspended) return [{ text: "⚠️ The app installation is suspended on GitHub. Nothing was connected." }];

    // 2. The repository must currently be part of that installation.
    const accessible = await this.d.github.listInstallationRepositories(repo.installationId);
    const live = accessible.find((r) => r.id === repo.repositoryId);
    if (!live) return [{ text: `⚠️ ${code(repo.fullName)} is not accessible to the app installation. Nothing was connected.` }];

    // 3. The authenticated GitHub user (by immutable ID) must be an admin of it, per GitHub right now.
    const login = await this.d.github.loginForUserId(repo.installationId, pick.githubUserId);
    const role = login ? await this.d.github.collaboratorRole(repo.installationId, live.fullName, login) : null;
    if (role !== "admin") {
      return [{ text: `🔒 You need admin rights on ${code(live.fullName)} to create bounty policies for it (GitHub reports: ${esc(role ?? "no access")}). Nothing was connected.` }];
    }

    try {
      await this.d.engine.connectRepository({
        ownerTelegramUserId: a.userId,
        installationId: repo.installationId,
        repositoryId: repo.repositoryId,
        repositoryFullName: live.fullName,
        repositoryPrivate: live.private,
      });
    } catch (err) {
      if (err instanceof EngineError && err.kind === "http" && (err.status === 403 || err.status === 409)) {
        return [{ text: `🔒 The engine refused to connect ${code(live.fullName)} (${esc(err.code ?? String(err.status))}). Nothing was connected. If this says the owner isn't verified, run /connectgithub again.` }];
      }
      throw err;
    }
    this.d.store.setRepo({ repositoryId: repo.repositoryId, installationId: repo.installationId, fullName: live.fullName, ownerChatId: a.userId, status: "connected" });
    this.picks.delete(a.chatId);
    this.d.logger.info("repository_connected", { repositoryId: repo.repositoryId });
    return [
      {
        text: `Connected: ${code(live.fullName)}.\nYou can now configure an AI bounty policy.`,
        buttons: [[{ text: "⚙️ Configure tiers", data: `sb:${repo.repositoryId}` }]],
      },
    ];
  }

  private async connectedRepos(a: Actor): Promise<ConnectedRepository[]> {
    const repos = await this.d.engine.listRepositories(a.userId);
    return repos.filter((r) => (r.status ?? "connected") === "connected" && this.d.store.getRepo(r.repositoryId)?.status !== "revoked");
  }

  private async repositories(a: Actor): Promise<Reply[]> {
    const repos = await this.connectedRepos(a);
    if (!repos.length) return [{ text: "No repositories are connected yet. Send /connectgithub." }];
    return repos.map((r) => {
      const rule = r.bountyRule;
      const buttons: Button[] = [{ text: "⚙️ Configure tiers", data: `sb:${r.repositoryId}` }];
      if (rule) buttons.push(this.ruleButton(rule.id, rule.status));
      return {
        text: `📦 ${code(r.fullName)}\nBounty policy: ${rule ? bold(rule.status.toUpperCase()) : "not configured"}`,
        buttons: [buttons],
      };
    });
  }

  private ruleButton(id: string, status: string): Button {
    const s = status.toLowerCase();
    if (s === "draft") return { text: "✅ Enable bounty", data: `be:${id}` };
    if (s === "paused") return { text: "▶️ Resume rewards", data: `br:${id}` };
    return { text: "⏸ Pause rewards", data: `bp:${id}` };
  }

  // ------------------------------------------------------------ /review

  private async reviewCommand(a: Actor, args: string): Promise<Reply[]> {
    const repos = await this.connectedRepos(a);
    if (!repos.length) return [{ text: "Connect a repository first with /connectgithub." }];
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const num = tokens.find((t) => /^#?\d+$/.test(t));
    const named = tokens.find((t) => t.includes("/"));
    const candidates = named ? repos.filter((r) => r.fullName.toLowerCase() === named.toLowerCase()) : repos;
    if (named && !candidates.length) return [{ text: `${code(named)} isn't one of your connected repositories (see /repositories).` }];
    if (candidates.length > 1) {
      return [{ text: "Which repository?", buttons: [...candidates.map((r): Button[] => [{ text: r.fullName, data: `rvr:${r.repositoryId}` }]), CANCEL_ROW] }];
    }
    const repo = candidates[0]!;
    if (!num) {
      this.flows.set(a.chatId, { kind: "review", repo: { repositoryId: repo.repositoryId, installationId: repo.installationId, fullName: repo.fullName }, touchedAt: this.now() });
      return [{ text: `Which pull request number in ${code(repo.fullName)}?`, buttons: [CANCEL_ROW] }];
    }
    return this.runReview(a, { repositoryId: repo.repositoryId, installationId: repo.installationId, fullName: repo.fullName }, Number(num.replace("#", "")));
  }

  private async runReview(a: Actor, repo: { repositoryId: string; installationId: string; fullName: string }, prNumber: number): Promise<Reply[]> {
    this.flows.delete(a.chatId);
    try {
      const { record, view, reused } = await this.d.pipeline.review({ ...repo, ownerChatId: a.userId }, prNumber);
      const note = reused ? "" : "\n\n<i>New evidence collected from GitHub and submitted for review.</i>";
      return [{ text: renderReview(view, record) + note, buttons: [[{ text: "👁 View review", data: `rv:${record.reviewId}` }]] }];
    } catch (err) {
      if ((err as { status?: number }).status === 404) return [{ text: `PR #${prNumber} wasn't found in ${code(repo.fullName)}.` }];
      throw err;
    }
  }

  private async viewReview(reviewId: string): Promise<Reply[]> {
    const review = await this.d.engine.getReview(reviewId);
    const rec = this.d.store.getReview(reviewId) ?? { prNumber: review.prNumber ?? 0, repositoryFullName: "unknown repository", incompleteReasons: [], merged: false };
    return [{ text: renderReview(review, rec) }];
  }

  private async bounties(): Promise<Reply[]> {
    const records = this.d.store.listReviews((r) => !r.supersededBy, 8);
    if (!records.length) return [{ text: "No contribution reviews yet. Open or update a PR in a connected repository, or use /review." }];
    const lines = await Promise.all(records.map((r) => this.summaryLine(r)));
    return [{ text: [`🏆 ${bold("Recent evaluations")}`, ...lines].join("\n"), buttons: records.slice(0, 5).map((r): Button[] => [{ text: `PR #${r.prNumber} details`, data: `rv:${r.reviewId}` }]) }];
  }

  /** One line per review, with every figure fetched live from the engine. */
  private async summaryLine(r: ReviewRecord): Promise<string> {
    const head = `PR #${r.prNumber} · ${code(r.repositoryFullName)}`;
    try {
      const rv = await this.d.engine.getReview(r.reviewId);
      const score = rv.score !== null && rv.score !== undefined ? `${rv.score}/100` : rv.state.toLowerCase();
      const tier = rv.candidateTier ? ` · Tier ${rv.candidateTier.tier} (₹${rv.candidateTier.faceValueINR})` : "";
      let outcome = r.finalizedAt ? " · finalized, no reward" : r.merged ? " · merged, verifying" : " · provisional";
      if (r.purchaseId) {
        const receipt = await this.d.engine.getReceipt(r.purchaseId).catch(() => null);
        outcome = receipt ? ` · ${describeReceipt(receipt).replace(/<\/?b>/g, "")}` : " · reward authorized";
      }
      const hold = rv.eligibilityState === "HOLD" && rv.reasons.length ? ` · HOLD: ${esc(rv.reasons.slice(0, 2).join(", "))}` : "";
      return `• ${head} · ${esc(score)}${tier}${outcome}${hold}`;
    } catch {
      return `• ${head} · status unavailable right now`;
    }
  }

  // ------------------------------------------------------------ /setbounty flow

  private async setBounty(a: Actor, args: string): Promise<Reply[]> {
    const repos = await this.connectedRepos(a);
    if (!repos.length) return [{ text: "Connect a repository first with /connectgithub." }];
    const named = args.trim().toLowerCase();
    const chosen = named ? repos.filter((r) => r.fullName.toLowerCase() === named) : repos;
    if (chosen.length === 1) return this.startBounty(a, chosen[0]!);
    return [{ text: "Which repository should earn rewards?", buttons: [...repos.map((r): Button[] => [{ text: r.fullName, data: `sb:${r.repositoryId}` }]), CANCEL_ROW] }];
  }

  private startBounty(a: Actor, repo: { repositoryId: string; fullName: string }): Reply[] {
    this.flows.set(a.chatId, { kind: "bounty", repo, step: "label", products: [], tiers: [], caps: {}, touchedAt: this.now() });
    return [
      {
        text: `🏆 Bounty policy for ${code(repo.fullName)}.\nWhich PR label makes a merged PR eligible? Send the label name, e.g. ${code("reward-ready")}. You (the connected maintainer) must apply it, or approve the exact commit, for a PR to count.`,
        buttons: [CANCEL_ROW],
      },
    ];
  }

  async handleText(a: Actor, text: string): Promise<Reply[]> {
    const f = this.flows.get(a.chatId);
    if (!f) return [];
    f.touchedAt = this.now();
    if (f.kind === "review") {
      const m = text.trim().match(/^#?(\d{1,7})$/);
      if (!m) return [{ text: "Send just the pull request number, e.g. 42.", buttons: [CANCEL_ROW] }];
      return this.runReview(a, f.repo, Number(m[1]));
    }
    switch (f.step) {
      case "label": {
        const label = normalizeLabel(text);
        if (!label) return [{ text: "Please send a single label name (up to 50 characters).", buttons: [CANCEL_ROW] }];
        f.requiredLabel = label;
        return this.bountyNext(a, f, "product_query");
      }
      case "product_query":
      case "product_pick": {
        const { query } = parseProductQuery(text);
        if (!query) return [{ text: "Send a brand to search, e.g. flipkart.", buttons: [CANCEL_ROW] }];
        f.productQuery = query;
        return this.searchProducts(f);
      }
      case "tier_score": {
        const n = Number(text.trim());
        return Number.isInteger(n) ? this.setTierScore(f, n) : [{ text: `Send a whole number between ${MIN_REWARD_SCORE} and 100.`, buttons: [CANCEL_ROW] }];
      }
      case "cap_per":
      case "cap_daily":
      case "cap_monthly":
      case "cap_auto": {
        const parsed = parseUsdInput(text);
        if (!parsed.ok) {
          return [{ text: parsed.reason === "non_usd" ? `Limits are enforced in USD and I won't convert currencies silently. Send the USD amount you want, e.g. ${code("2")}.` : `I couldn't read that amount. Try ${code("2")} or ${code("$1.50")}.`, buttons: [CANCEL_ROW] }];
        }
        return this.setCap(a, f, parsed.cents);
      }
      default:
        return [{ text: "Please use the buttons above, or /cancel.", buttons: [CANCEL_ROW] }];
    }
  }

  private async bountyNext(a: Actor, f: BountyFlow, step: BStep): Promise<Reply[]> {
    f.step = step;
    switch (step) {
      case "product_query":
        return [{ text: `🎁 Which gift card should rewards be paid in? Send a brand to search the live Indian catalog, e.g. ${code("flipkart")}. Bounties are paid in INR gift cards verified against Bitrefill's India catalog.`, buttons: [CANCEL_ROW] }];
      case "tier_count":
        return [{ text: "How many reward tiers? (Higher scores unlock higher tiers.)", buttons: [[1, 2, 3].map((n) => ({ text: String(n), data: `btc:${n}` })), CANCEL_ROW] }];
      case "tier_score": {
        const idx = f.tiers.length + 1;
        const prev = f.tiers.at(-1)?.minScore ?? MIN_REWARD_SCORE - 1;
        const presets = [50, 70, 85].filter((s) => s > prev);
        return [{ text: `🏅 ${bold(`Tier ${idx}`)}: minimum AI score (${prev + 1}–100) to earn it. Rewards start at ${MIN_REWARD_SCORE}; scores of 85 or more always need your approval.`, buttons: [presets.map((s) => ({ text: String(s), data: `bts:${s}` })), CANCEL_ROW] }];
      }
      case "tier_package": {
        const product = f.product!;
        const rows = product.packages.slice(0, 12).map((p, i): Button => ({ text: formatDenomination(p.value, product.currency), data: `bpk:${i}` }));
        const grid: Button[][] = [];
        for (let i = 0; i < rows.length; i += 3) grid.push(rows.slice(i, i + 3));
        return [{ text: `📦 Tier ${f.tiers.length + 1} (score ≥ ${f.pendingScore}): which ${esc(product.name)} denomination?`, buttons: [...grid, CANCEL_ROW] }];
      }
      default:
        return this.capPrompt(a, f, step);
    }
  }

  private async searchProducts(f: BountyFlow): Promise<Reply[]> {
    const country = "IN";
    const found = await this.d.engine.searchProducts(f.productQuery!, country);
    const inStock = found.filter((p) => p.inStock && p.packages.length > 0 && p.country === "IN" && p.currency === "INR").slice(0, 8);
    if (!inStock.length) {
      const tried = f.productQuery!;
      f.productQuery = undefined;
      return [{ text: `No in-stock gift cards for “${esc(tried)}” in ${country}. Try another brand.`, buttons: [CANCEL_ROW] }];
    }
    f.step = "product_pick";
    f.products = inStock;
    return [{ text: `🔎 In-stock options for “${esc(f.productQuery!)}” in ${country}:`, buttons: [...inStock.map((p, i): Button[] => [{ text: `${p.name} · ${p.country} (${p.currency})`, data: `bpr:${i}` }]), CANCEL_ROW] }];
  }

  private setTierScore(f: BountyFlow, score: number): Promise<Reply[]> | Reply[] {
    const prev = f.tiers.at(-1)?.minScore ?? MIN_REWARD_SCORE - 1;
    if (score <= prev || score > 100) return [{ text: `The score must be between ${prev + 1} and 100 (higher than the previous tier, and at least ${MIN_REWARD_SCORE}).`, buttons: [CANCEL_ROW] }];
    f.pendingScore = score;
    return this.bountyNext({ userId: "", chatId: "", chatType: "private" }, f, "tier_package");
  }

  private async capPrompt(_a: Actor, f: BountyFlow, step: BStep): Promise<Reply[]> {
    const entry = CAP_ORDER.find((c) => c.step === step)!;
    const lines = [entry.title, `Send an amount like ${code("2")} or ${code("$1.50")}.`];
    if (step === "cap_per" && f.product && f.product.currency !== "USD") {
      lines.push(`ℹ️ The card is denominated in ${esc(f.product.currency)}; its USD price is set by Bitrefill at purchase time. I won't convert anything for you, so choose a cap you're comfortable with.`);
    }
    return [{ text: lines.join("\n"), buttons: [CAP_PRESETS[entry.key].map((c) => ({ text: formatUsd(c), data: `bcap:${c}` })), CANCEL_ROW] }];
  }

  private async setCap(a: Actor, f: BountyFlow, cents: number): Promise<Reply[]> {
    const idx = CAP_ORDER.findIndex((c) => c.step === f.step);
    if (idx < 0) return [];
    const { key } = CAP_ORDER[idx]!;
    const check = checkCap(f.caps as RuleDraft, key, cents);
    if (!check.ok) return [{ text: `${check.message} Please send another amount.`, buttons: [CANCEL_ROW] }];
    f.caps[key] = cents;
    const next = CAP_ORDER[idx + 1];
    return next ? this.bountyNext(a, f, next.step) : this.finishBounty(a, f);
  }

  private async finishBounty(a: Actor, f: BountyFlow): Promise<Reply[]> {
    const product = f.product!;
    // Re-read each tier's product from the live catalog: invented or stale IDs never reach the engine.
    const fresh = await this.d.engine.getProduct(product.id).catch((err) => {
      if (err instanceof EngineError && err.status === 404) throw new UserFacingError("That product isn't in the catalog. Nothing was created.");
      throw err;
    });
    if (!fresh.inStock) throw new UserFacingError(`${fresh.name} is out of stock right now. Nothing was created.`);
    if (fresh.country !== "IN" || fresh.currency !== "INR") throw new UserFacingError("Bounties can only be paid in Indian (INR) gift cards. Nothing was created.");
    if (!f.requiredLabel) throw new UserFacingError("A required label is needed. Nothing was created.");
    const tiers: BountyTier[] = f.tiers.map((t, i) => {
      const pkg = fresh.packages.find((p) => p.packageId === t.packageId);
      if (!pkg || !Number.isInteger(pkg.value)) throw new UserFacingError("A selected package isn't offered any more. Nothing was created.");
      const next = f.tiers[i + 1];
      return { minScore: t.minScore, maxScore: next ? next.minScore - 1 : 100, faceValueINR: pkg.value, productId: fresh.id, packageId: t.packageId, requiresApproval: t.minScore >= 85 };
    });
    const c = f.caps;
    const rule = await this.d.engine.createBountyRule({
      ownerTelegramUserId: a.userId,
      repositoryId: f.repo.repositoryId,
      requiredLabel: f.requiredLabel,
      requireSuccessfulCI: true,
      scoreThreshold: f.tiers[0]!.minScore,
      tiers,
      perPurchaseCapUsdCents: c.perPurchaseCapUsdCents!,
      dailyCapUsdCents: c.dailyCapUsdCents!,
      monthlyCapUsdCents: c.monthlyCapUsdCents!,
      autoApproveUpToUsdCents: c.autoApproveUpToUsdCents!,
      allowSelfReward: false,
    }).catch((err) => {
      if (err instanceof EngineError && err.kind === "http" && err.status === 409) throw new UserFacingError("This repository already has a bounty policy. Policies are immutable in this version; pause it from /repositories instead. Nothing was created.");
      if (err instanceof EngineError && err.kind === "http" && err.status && err.status >= 400 && err.status < 500) throw new UserFacingError(`The engine rejected this policy (${err.code ?? err.status}). Nothing was created.`);
      throw err;
    });
    this.flows.delete(a.chatId);
    const tierLines = tiers.map((t, i) => `Tier ${i + 1}: score ${t.minScore}–${t.maxScore} → ${esc(fresh.name)} ${formatDenomination(t.faceValueINR, "INR")}${t.requiresApproval ? " (needs your approval)" : ""}`);
    return [
      {
        text: [
          `✅ Your bounty policy is ready to review.`,
          ``,
          `🏆 ${bold(f.repo.fullName)} — ${bold(rule.status.toUpperCase())}`,
          `<b>Eligible PRs:</b> merged, label ${code(f.requiredLabel)} applied or commit approved by you, all required CI green`,
          ...tierLines,
          `<b>Limits (USD):</b> ${formatUsd(c.perPurchaseCapUsdCents!)} per reward · ${formatUsd(c.dailyCapUsdCents!)} daily · ${formatUsd(c.monthlyCapUsdCents!)} monthly`,
          c.autoApproveUpToUsdCents === 0 ? `<b>Approval:</b> every reward waits for your tap` : `<b>Approval:</b> up to ${formatUsd(c.autoApproveUpToUsdCents!)} automatic; above that I ask you first`,
          ``,
          `<b>Nothing is bought until you enable this and a reviewed PR is merged.</b> Rewards are decided on the final merged commit.`,
        ].join("\n"),
        buttons: [[{ text: "✅ Enable bounty", data: `be:${rule.id}` }, { text: "✏️ Restart", data: `sb:${f.repo.repositoryId}` }]],
      },
    ];
  }

  // ------------------------------------------------------------ callbacks (owner)

  async handleOwnerCallback(a: Actor, kind: string, arg: string): Promise<CallbackResult> {
    switch (kind) {
      case "sr":
        return { replies: await this.connectRepository(a, Number(arg)) };
      case "sb": {
        const repo = (await this.connectedRepos(a)).find((r) => r.repositoryId === arg);
        if (!repo) return { replies: [{ text: "That repository isn't connected." }] };
        return { replies: this.startBounty(a, repo) };
      }
      case "be":
      case "bp":
      case "br": {
        const action = ({ be: "enable", bp: "pause", br: "resume" } as const)[kind];
        const rule = await this.d.engine.bountyRuleAction(arg, action, a.userId);
        const st = rule?.status ? ` (status: ${esc(rule.status)})` : "";
        const text = {
          enable: `✅ Bounty rewards enabled${st}. I'll review PRs as they change and finalize on merge. The engine enforces every limit.`,
          pause: `⏸ Rewards paused${st}. No bounty purchases will be made until you resume.`,
          resume: `▶️ Rewards resumed${st}.`,
        }[action];
        this.d.logger.info("bounty_rule_action", { action, ruleId: arg });
        return { replies: [{ text, buttons: action === "pause" ? [[{ text: "▶️ Resume rewards", data: `br:${arg}` }]] : [[{ text: "⏸ Pause rewards", data: `bp:${arg}` }]] }], toast: { enable: "Enabled", pause: "Paused", resume: "Resumed" }[action] };
      }
      case "rv":
        return { replies: await this.viewReview(arg) };
      case "rvr": {
        const repo = (await this.connectedRepos(a)).find((r) => r.repositoryId === arg);
        if (!repo) return { replies: [{ text: "That repository isn't connected." }] };
        this.flows.set(a.chatId, { kind: "review", repo: { repositoryId: repo.repositoryId, installationId: repo.installationId, fullName: repo.fullName }, touchedAt: this.now() });
        return { replies: [{ text: `Which pull request number in ${code(repo.fullName)}?`, buttons: [CANCEL_ROW] }] };
      }
      default:
        return { replies: await this.bountyCallback(a, kind, arg) };
    }
  }

  private async bountyCallback(a: Actor, kind: string, arg: string): Promise<Reply[]> {
    const f = this.flows.get(a.chatId);
    if (!f || f.kind !== "bounty") return [{ text: "That option has expired. Send /setbounty to start again." }];
    f.touchedAt = this.now();
    switch (kind) {
      case "bts":
        if (f.step === "tier_score" && /^\d+$/.test(arg)) return this.setTierScore(f, Number(arg));
        return [{ text: "That option has expired." }];
      case "bpr": {
        const product = f.step === "product_pick" ? f.products[Number(arg)] : undefined;
        if (!product) return [{ text: "That option has expired. Send a new search." }];
        const exact = await this.d.engine.getProduct(product.id);
        if (!exact.inStock || !exact.packages.length) return [{ text: `${esc(exact.name)} just went out of stock. Pick another option.` }];
        f.product = exact;
        return this.bountyNext(a, f, "tier_count");
      }
      case "btc": {
        const n = Number(arg);
        if (f.step !== "tier_count" || ![1, 2, 3].includes(n)) return [{ text: "That option has expired." }];
        f.tierCount = n;
        return this.bountyNext(a, f, "tier_score");
      }
      case "bpk": {
        const pkg = f.step === "tier_package" ? f.product?.packages[Number(arg)] : undefined;
        if (!pkg || f.pendingScore === undefined) return [{ text: "That option has expired." }];
        f.tiers.push({ minScore: f.pendingScore, packageId: pkg.packageId, value: pkg.value });
        f.pendingScore = undefined;
        return f.tiers.length < (f.tierCount ?? 1) ? this.bountyNext(a, f, "tier_score") : this.bountyNext(a, f, "cap_per");
      }
      case "bcap": {
        const cents = Number(arg);
        return Number.isSafeInteger(cents) && f.step.startsWith("cap_") ? this.setCap(a, f, cents) : [{ text: "That option has expired." }];
      }
      default:
        return [];
    }
  }
}
