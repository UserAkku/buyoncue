import { EngineError } from "../engine/client.js";
import type { EngineApi, Product, Rule } from "../engine/types.js";
import { bold, code, esc } from "../html.js";
import type { Logger } from "../logger.js";
import { formatDenomination, formatUsd, parseUsdInput } from "../money.js";
import {
  type CapKey,
  checkCap,
  nextStep,
  normalizeLabel,
  normalizeRecipient,
  normalizeRepository,
  type RuleDraft,
  type Step,
  toCreateRuleBody,
} from "../rules/draft.js";
import type { RuleInterpreter, RuleProposal } from "../rules/interpreter.js";
import { parseProductQuery } from "../rules/query.js";
import {
  CONTRIBUTOR_CALLBACKS,
  CONTRIBUTOR_COMMANDS,
  GithubFeature,
  OWNER_CALLBACKS,
  OWNER_COMMANDS,
} from "./github-feature.js";
import { renderRule, ruleActionButtons, ruleView } from "./render.js";
import { type Session, SessionStore } from "./session.js";
import { type Actor, type Button, type CallbackResult, type Reply, UserFacingError } from "./types.js";

const DEFAULT_COUNTRY = "IN";
const MAX_PRODUCT_BUTTONS = 8;
const MAX_PACKAGE_BUTTONS = 12;

const CANCEL_ROW: Button[] = [{ text: "✖️ Cancel", data: "cancel" }];

const CAP_STEPS: Record<string, { key: CapKey; hintScope: string }> = {
  cap_per: { key: "perPurchaseCapUsdCents", hintScope: "per_purchase" },
  cap_daily: { key: "dailyCapUsdCents", hintScope: "daily" },
  cap_monthly: { key: "monthlyCapUsdCents", hintScope: "monthly" },
  cap_auto: { key: "autoApproveUpToUsdCents", hintScope: "auto_approve" },
};

const CAP_PRESETS: Record<CapKey, number[]> = {
  perPurchaseCapUsdCents: [100, 200, 500],
  dailyCapUsdCents: [200, 500, 1000],
  monthlyCapUsdCents: [1000, 2000, 5000],
  autoApproveUpToUsdCents: [0, 100, 150],
};

export interface ControllerDeps {
  engine: EngineApi;
  /** null = AI disabled (no LLM credentials) -> guided flow only. */
  interpreter: RuleInterpreter | null;
  /** null = setup mode: only /start, /help and /whoami respond. */
  ownerUserId: string | null;
  logger: Logger;
  sessions?: SessionStore;
  /** Authenticated Telegram getChat lookup; unknown recipients must start the bot first. */
  verifyRecipient?: (chatId: string) => Promise<boolean>;
  /** GitHub App features. Absent when the GitHub App isn't configured. */
  github?: GithubFeature;
}

const GITHUB_NOT_CONFIGURED: Reply = {
  text: "ℹ️ GitHub App integration isn't configured on this server. The operator needs to set the GITHUB_APP_* variables (see docs/GITHUB_APP_SETUP.md).",
};

export class Controller {
  private readonly engine: EngineApi;
  private readonly interpreter: RuleInterpreter | null;
  private readonly ownerUserId: string | null;
  private readonly logger: Logger;
  private readonly sessions: SessionStore;
  private readonly productCache = new Map<string, Product>();
  private readonly verifyRecipient?: (chatId: string) => Promise<boolean>;
  private readonly github?: GithubFeature;

  constructor(deps: ControllerDeps) {
    this.engine = deps.engine;
    this.interpreter = deps.interpreter;
    this.ownerUserId = deps.ownerUserId;
    this.logger = deps.logger;
    this.sessions = deps.sessions ?? new SessionStore();
    this.verifyRecipient = deps.verifyRecipient;
    this.github = deps.github;
  }

  // ---------------------------------------------------------------- auth

  /** Only the configured owner, in their own private chat, may manage rules or spending. */
  private isOwner(a: Actor): boolean {
    return (
      this.ownerUserId !== null &&
      a.userId === this.ownerUserId &&
      a.chatType === "private" &&
      a.chatId === this.ownerUserId
    );
  }

  private denied(a: Actor): Reply[] {
    if (a.chatType !== "private") return []; // never chatter in groups
    if (this.ownerUserId === null) {
      return [
        {
          text: `🔧 Setup mode: no owner is configured yet. Your Telegram ID is ${code(a.userId)}. Put it in ${code("TELEGRAM_OWNER_USER_ID")} and restart me.`,
        },
      ];
    }
    return [{ text: "🔒 This PactPilot instance is private. Only its owner can manage rules or approve spending." }];
  }

  // ------------------------------------------------------------ commands

  async handleCommand(a: Actor, command: string, args: string): Promise<Reply[]> {
    const cmd = command.toLowerCase();
    if (cmd === "whoami") return [this.whoami(a)];
    if (cmd === "help") return [this.help(a)];
    if (cmd === "start") return [this.start(a)];
    // Contributor commands only ever act on the caller's own identity, so any user may run them privately.
    if (CONTRIBUTOR_COMMANDS.has(cmd)) {
      const github = this.github;
      return github ? this.guard(() => github.handleContributorCommand(a, cmd)) : [GITHUB_NOT_CONFIGURED];
    }
    if (!this.isOwner(a)) return this.denied(a);

    return this.guard(async () => {
      switch (cmd) {
        case "newrule":
          return this.newRule(a, args);
        case "rules":
          return this.listRules(a);
        case "enable":
          return this.pickRule(a, "enable");
        case "pause":
          return this.pickRule(a, "pause");
        case "resume":
          return this.pickRule(a, "resume");
        case "status":
          return this.status(a);
        case "cancel":
          return [this.cancel(a)];
        default:
          if (OWNER_COMMANDS.has(cmd)) return this.github ? this.github.handleOwnerCommand(a, cmd, args) : [GITHUB_NOT_CONFIGURED];
          return [{ text: "I don't know that command. Try /help." }];
      }
    });
  }

  async handleText(a: Actor, text: string): Promise<Reply[]> {
    if (!this.isOwner(a)) return this.denied(a);
    return this.guard(async () => {
      if (this.github?.hasFlow(a.chatId)) return this.github.handleText(a, text);
      const s = this.sessions.get(a.chatId);
      if (!s && GithubFeature.looksLikeConnectRequest(text)) {
        return this.github ? this.github.connectGithub(a) : [GITHUB_NOT_CONFIGURED];
      }
      if (!s) {
        if (!this.interpreter) {
          return [{ text: "I can set up purchase rules with a quick guided chat. Send /newrule to begin." }];
        }
        const fresh = this.sessions.start(a.chatId, "describe");
        return this.describe(a, fresh, text);
      }
      if (s.mode === "describe") return this.describe(a, s, text);
      return this.answerStep(a, s, text);
    });
  }

  async handleCallback(a: Actor, data: string): Promise<CallbackResult> {
    const [kind, ...rest] = data.split(":");
    const arg = rest.join(":");
    if (CONTRIBUTOR_CALLBACKS.has(kind ?? "")) {
      if (!this.github) return { replies: [GITHUB_NOT_CONFIGURED] };
      try {
        return await this.github.handleContributorCallback(a, kind!);
      } catch (err) {
        return { replies: [this.errorReply(err)] };
      }
    }
    if (!this.isOwner(a)) return { replies: [], toast: "Not authorized" };
    try {
      return await this.dispatchCallback(a, kind ?? "", arg);
    } catch (err) {
      return { replies: [this.errorReply(err)] };
    }
  }

  private async dispatchCallback(a: Actor, kind: string, arg: string): Promise<CallbackResult> {
    switch (kind) {
      case "ap":
        return this.decide(a, arg, "approve");
      case "rj":
        return this.decide(a, arg, "reject");
      case "en":
        return this.ruleAction(a, arg, "enable");
      case "pa":
        return this.ruleAction(a, arg, "pause");
      case "rs":
        return this.ruleAction(a, arg, "resume");
      case "enq":
        return { replies: await this.confirmEnable(a, arg) };
      case "cancel":
        return { replies: [this.cancel(a)] };
      case "restart":
        this.sessions.clear(a.chatId);
        return { replies: await this.newRule(a, "") };
      case "guided": {
        const s = this.sessions.get(a.chatId) ?? this.sessions.start(a.chatId, "collect");
        s.mode = "collect";
        return { replies: await this.advance(a, s) };
      }
      case "pr":
        return { replies: await this.pickProduct(a, Number(arg)) };
      case "pk":
        return { replies: await this.pickPackage(a, Number(arg)) };
      case "rc":
        return { replies: await this.setRecipientFromCallback(a, arg) };
      case "cap":
        return { replies: await this.setCapFromCallback(a, arg) };
      default:
        if (OWNER_CALLBACKS.has(kind)) {
          return this.github ? this.github.handleOwnerCallback(a, kind, arg) : { replies: [GITHUB_NOT_CONFIGURED] };
        }
        return { replies: [], toast: "That button is no longer valid" };
    }
  }

  // ------------------------------------------------------------ simple replies

  private whoami(a: Actor): Reply {
    return {
      text: [
        `👤 Telegram user ID: ${code(a.userId)}`,
        `💬 This chat ID: ${code(a.chatId)} (${esc(a.chatType)})`,
        a.chatType === "private"
          ? `Use the user ID as ${code("TELEGRAM_OWNER_USER_ID")}, and as the recipient chat ID when a rule should deliver to you.`
          : `⚠️ Group chats are never used for gift-card delivery. Message me privately for setup.`,
      ].join("\n"),
    };
  }

  private help(a: Actor): Reply {
    const ai = this.interpreter ? "AI-assisted (LLM)" : "guided (no LLM configured)";
    return {
      text: [
        `${bold("PactPilot")} — buys gift cards for you, automatically, within limits you set.`,
        ``,
        `/newrule — create a rule (${ai})`,
        `/rules — your saved rules`,
        `/enable — enable a draft rule`,
        `/pause · /resume — stop or restart a rule`,
        `/status — engine mode and recent purchases`,
        ...(this.github ? this.github.helpLines() : []),
        `/whoami — your Telegram user and chat ID`,
        `/cancel — abandon the current setup`,
        ``,
        `Nothing is spent until you enable a rule. The engine, not this chat, enforces every limit. ${this.isOwner(a) ? "" : "(Only the owner can use these.)"}`,
      ].join("\n"),
    };
  }

  private start(a: Actor): Reply {
    if (!this.isOwner(a)) {
      if (this.ownerUserId === null && a.chatType === "private") return this.denied(a)[0]!;
      return { text: `👋 This is a private PactPilot instance. Your Telegram ID is ${code(a.userId)}.` };
    }
    return {
      text: [
        `👋 ${bold("Welcome to PactPilot.")}`,
        `Describe a purchasing rule once, enable it, and I'll act when an authorized GitHub event happens, with approvals, limits and receipts right here.`,
        ``,
        this.interpreter
          ? `Try: <i>“Whenever a PR with the reward-ready label is merged in my repo, send a ₹50 Flipkart gift card, subject to my spending limits.”</i>`
          : `Send /newrule for guided setup.`,
        ``,
        `/help lists everything I can do.`,
      ].join("\n"),
    };
  }

  private cancel(a: Actor): Reply {
    const clearedRule = this.sessions.clear(a.chatId);
    const clearedGithub = this.github?.cancel(a.chatId) ?? false;
    return clearedRule || clearedGithub
      ? { text: "Okay, setup cancelled. Nothing was created." }
      : { text: "There's nothing to cancel." };
  }

  // ------------------------------------------------------------ rule creation

  private async newRule(a: Actor, args: string): Promise<Reply[]> {
    this.sessions.clear(a.chatId);
    if (this.interpreter) {
      const s = this.sessions.start(a.chatId, "describe");
      if (args.trim()) return this.describe(a, s, args);
      return [
        {
          text: `Describe the rule in your own words, for example:\n<i>“When a PR labelled reward-ready is merged in acme/app, send a ₹50 Flipkart gift card.”</i>\n\nOr tap below for step-by-step setup.`,
          buttons: [[{ text: "🧭 Guided setup", data: "guided" }], CANCEL_ROW],
        },
      ];
    }
    const s = this.sessions.start(a.chatId, "collect");
    return [{ text: "ℹ️ AI parsing is off (no LLM credentials configured), so I'll walk you through it step by step." }, ...(await this.advance(a, s))];
  }

  private async describe(a: Actor, s: Session, text: string): Promise<Reply[]> {
    if (!this.interpreter) {
      s.mode = "collect";
      return this.advance(a, s);
    }
    let proposal: RuleProposal;
    try {
      proposal = await this.interpreter.interpret(text);
    } catch (err) {
      this.logger.warn("llm_interpret_failed");
      s.mode = "collect";
      return [
        { text: "⚠️ I couldn't interpret that automatically, so let's do it step by step." },
        ...(await this.advance(a, s)),
      ];
    }
    if (proposal.intent !== "create_rule") {
      return [
        {
          text: "That doesn't look like a purchasing rule. Tell me what should trigger a gift card, or tap Guided setup.",
          buttons: [[{ text: "🧭 Guided setup", data: "guided" }], CANCEL_ROW],
        },
      ];
    }
    s.mode = "collect";
    const understood = this.applyProposal(s.draft, proposal);
    const intro: Reply = {
      text: understood.length
        ? `Here's what I understood (please check — nothing is created yet):\n${understood.map((l) => `• ${l}`).join("\n")}`
        : `I couldn't pick out specifics, so I'll ask for each detail.`,
    };
    return [intro, ...(await this.advance(a, s))];
  }

  /** Copies LLM text-level hints into the draft. Never touches product IDs or limits. */
  private applyProposal(d: RuleDraft, p: RuleProposal): string[] {
    const lines: string[] = [];
    const repo = p.repository ? normalizeRepository(p.repository) : null;
    if (repo) {
      d.repository = repo;
      lines.push(`Repository: ${code(repo)}`);
    }
    const label = p.requiredLabel ? normalizeLabel(p.requiredLabel) : null;
    if (label) {
      d.requiredLabel = label;
      lines.push(`Label: ${code(label)}`);
    }
    if (p.productQuery?.trim()) {
      d.productQuery = p.productQuery.trim().slice(0, 60);
      const cur = p.packageCurrency?.toUpperCase();
      d.country = p.country?.toUpperCase() ?? (cur === "INR" ? "IN" : cur === "USD" ? "US" : undefined);
      if (p.packageValue) {
        d.desiredValue = p.packageValue;
        d.desiredCurrency = cur;
      }
      const denom = p.packageValue ? ` ${formatDenomination(p.packageValue, cur ?? "")}`.replace(/ $/, "") : "";
      lines.push(`Gift card: ${esc(d.productQuery)}${esc(denom)} (I'll look up real catalog options next)`);
    }
    const recipient = p.recipientChatId ? normalizeRecipient(p.recipientChatId) : null;
    if (recipient) {
      d.recipientChatId = recipient;
      lines.push(`Deliver to chat: ${code(recipient)}`);
    }
    if (p.ruleName?.trim()) d.name = p.ruleName.trim().slice(0, 80);

    for (const h of p.budgetHints) {
      if (h.currency.toUpperCase() === "USD") {
        const key = ({ per_purchase: "perPurchaseCapUsdCents", daily: "dailyCapUsdCents", monthly: "monthlyCapUsdCents", auto_approve: "autoApproveUpToUsdCents" } as const)[h.scope];
        d.usdHints = { ...d.usdHints, [key]: Math.round(h.amount * 100) };
      } else {
        d.nonUsdHints = [...(d.nonUsdHints ?? []), { scope: h.scope, amount: h.amount, currency: h.currency.toUpperCase() }];
      }
    }
    if (d.usdHints || d.nonUsdHints) {
      lines.push(`You mentioned a budget. I'll ask you to confirm each spending limit explicitly.`);
    }
    return lines;
  }

  /** Ask for whatever is still missing; runs the catalog search when that's the next step. */
  private async advance(a: Actor, s: Session): Promise<Reply[]> {
    const step = nextStep(s.draft);
    switch (step) {
      case "repo":
        return [{ text: `📁 Which GitHub repository should trigger this? Send it as ${code("owner/repo")} (or paste the URL).`, buttons: [CANCEL_ROW] }];
      case "label":
        return [{ text: `🏷 Which PR label should trigger it? (e.g. ${code("reward-ready")})`, buttons: [CANCEL_ROW] }];
      case "product_query":
        return [
          {
            text: `🎁 Which gift card? Send a brand to search the live Bitrefill catalog, e.g. ${code("flipkart")} or ${code("amazon US")} (default country: ${DEFAULT_COUNTRY}).`,
            buttons: [CANCEL_ROW],
          },
        ];
      case "product_pick":
        return this.searchProducts(s);
      case "package_pick":
        return this.offerPackages(a, s);
      case "recipient":
        return [
          {
            text: `📬 Who receives the gift card? Redemption codes are only ever sent to a <b>private</b> chat.\nTap below to use this chat, or send a numeric Telegram chat ID (that person must have started this bot).`,
            buttons: [[{ text: "👤 Me (this chat)", data: "rc:me" }], CANCEL_ROW],
          },
        ];
      case "cap_per":
      case "cap_daily":
      case "cap_monthly":
      case "cap_auto":
        return [this.capPrompt(s.draft, step)];
      case "done":
        return this.finalize(a, s);
    }
  }

  private async answerStep(a: Actor, s: Session, text: string): Promise<Reply[]> {
    const d = s.draft;
    const step = nextStep(d);
    switch (step) {
      case "repo": {
        const repo = normalizeRepository(text);
        if (!repo) return [{ text: `That doesn't look like a repository. Use the form ${code("owner/repo")}.`, buttons: [CANCEL_ROW] }];
        d.repository = repo;
        break;
      }
      case "label": {
        const label = normalizeLabel(text);
        if (!label) return [{ text: "Please send a single label name (up to 50 characters).", buttons: [CANCEL_ROW] }];
        d.requiredLabel = label;
        break;
      }
      case "product_query":
      case "product_pick":
      case "package_pick": {
        if (step === "package_pick") {
          const n = Number(text.replace(/[^\d.]/g, ""));
          const idx = s.packageOptions.findIndex((p) => p.value === n);
          if (n > 0 && idx >= 0) return this.pickPackage(a, idx);
          return [{ text: "Please tap one of the package buttons above.", buttons: [CANCEL_ROW] }];
        }
        const { query, country } = parseProductQuery(text);
        if (!query) return [{ text: "Send a brand name to search, e.g. flipkart.", buttons: [CANCEL_ROW] }];
        d.productQuery = query;
        d.country = country ?? d.country;
        d.product = undefined;
        d.pkg = undefined;
        break;
      }
      case "recipient": {
        const r = /^(me|self|myself)$/i.test(text.trim()) ? a.userId : normalizeRecipient(text);
        if (!r) {
          return [{ text: `Send a positive numeric chat ID of a <b>private</b> chat (group IDs are negative and are not allowed), or tap “Me”.`, buttons: [[{ text: "👤 Me (this chat)", data: "rc:me" }], CANCEL_ROW] }];
        }
        d.recipientChatId = r;
        break;
      }
      case "cap_per":
      case "cap_daily":
      case "cap_monthly":
      case "cap_auto":
        return this.setCap(a, s, step, text);
      case "done":
        return this.advance(a, s);
    }
    return this.advance(a, s);
  }

  private async searchProducts(s: Session): Promise<Reply[]> {
    const d = s.draft;
    const country = d.country ?? DEFAULT_COUNTRY;
    const found = await this.engine.searchProducts(d.productQuery!, country);
    const inStock = found.filter((p) => p.inStock && p.packages.length > 0);
    if (inStock.length === 0) {
      const tried = d.productQuery!;
      d.productQuery = undefined;
      s.products = [];
      return [
        {
          text: found.length
            ? `I found ${found.length} match(es) for “${esc(tried)}” in ${country}, but none are in stock. Try another brand or country (e.g. ${code("amazon US")}).`
            : `No gift cards found for “${esc(tried)}” in ${country}. Try another brand or country (e.g. ${code("amazon US")}).`,
          buttons: [CANCEL_ROW],
        },
      ];
    }
    s.products = inStock.slice(0, MAX_PRODUCT_BUTTONS);
    for (const p of s.products) this.productCache.set(p.id, p);
    const rows = s.products.map((p, i): Button[] => [{ text: `${p.name} · ${p.country} (${p.currency})`, data: `pr:${i}` }]);
    return [
      {
        text: `🔎 In-stock options for “${esc(d.productQuery!)}” in ${country}. Pick one, or send another search:`,
        buttons: [...rows, CANCEL_ROW],
      },
    ];
  }

  private async pickProduct(a: Actor, index: number): Promise<Reply[]> {
    const s = this.sessions.get(a.chatId);
    const offered = s?.products[index];
    if (!s || !offered) return [{ text: "That option has expired. Send a new search or /newrule." }];
    // Re-read the exact product from the engine: the catalog is the source of truth.
    const product = await this.engine.getProduct(offered.id);
    if (!product.inStock || product.packages.length === 0) {
      return [{ text: `${esc(product.name)} just went out of stock. Pick another option.` }];
    }
    this.productCache.set(product.id, product);
    s.draft.product = { id: product.id, name: product.name, country: product.country, currency: product.currency };
    s.draft.pkg = undefined;
    s.packageOptions = product.packages.map((p) => ({ packageId: p.packageId, value: p.value }));
    return this.advance(a, s);
  }

  private async offerPackages(a: Actor, s: Session): Promise<Reply[]> {
    const d = s.draft;
    const product = d.product!;
    const wanted = d.desiredValue;
    if (wanted !== undefined) {
      const idx = s.packageOptions.findIndex((p) => p.value === wanted);
      if (idx >= 0) {
        const chosen = s.packageOptions[idx]!;
        d.pkg = chosen;
        return [
          { text: `📦 Using the ${bold(formatDenomination(chosen.value, product.currency))} package of ${esc(product.name)} (matches what you asked for).` },
          ...(await this.advance(a, s)),
        ];
      }
    }
    const rows = s.packageOptions.slice(0, MAX_PACKAGE_BUTTONS).map((p, i): Button => ({ text: formatDenomination(p.value, product.currency), data: `pk:${i}` }));
    const grid: Button[][] = [];
    for (let i = 0; i < rows.length; i += 3) grid.push(rows.slice(i, i + 3));
    const miss = wanted !== undefined ? `There's no ${formatDenomination(wanted, d.desiredCurrency ?? product.currency)} package. ` : "";
    return [{ text: `📦 ${miss}Which ${esc(product.name)} denomination?`, buttons: [...grid, CANCEL_ROW] }];
  }

  private async pickPackage(a: Actor, index: number): Promise<Reply[]> {
    const s = this.sessions.get(a.chatId);
    const pkg = s?.packageOptions[index];
    if (!s || !pkg || !s.draft.product) return [{ text: "That option has expired. Send /newrule to start over." }];
    s.draft.pkg = pkg;
    return this.advance(a, s);
  }

  private async setRecipientFromCallback(a: Actor, arg: string): Promise<Reply[]> {
    const s = this.sessions.get(a.chatId);
    if (!s || arg !== "me") return [{ text: "That option has expired. Send /newrule to start over." }];
    s.draft.recipientChatId = a.userId;
    return this.advance(a, s);
  }

  private capPrompt(d: RuleDraft, step: Step): Reply {
    const { key, hintScope } = CAP_STEPS[step]!;
    const titles: Record<CapKey, string> = {
      perPurchaseCapUsdCents: `💳 ${bold("Per-purchase hard cap")} (USD): the most a single purchase may cost. Anything above is blocked.`,
      dailyCapUsdCents: `📅 ${bold("Daily cap")} (USD): total spend allowed per day.`,
      monthlyCapUsdCents: `🗓 ${bold("Monthly cap")} (USD): total spend allowed per month.`,
      autoApproveUpToUsdCents: `✅ ${bold("Auto-approve threshold")} (USD): purchases up to this run automatically; above it I wait for your Approve tap. Send 0 to approve every purchase manually.`,
    };
    const lines = [titles[key], `Send an amount like ${code("2")} or ${code("$1.50")}.`];
    const noteFor = d.nonUsdHints?.filter((h) => h.scope === hintScope) ?? [];
    for (const h of noteFor) {
      lines.push(`ℹ️ You mentioned ${esc(h.currency)} ${h.amount}. The MVP enforces limits in the payment currency (USD) and I won't convert silently, so please confirm the USD amount you want.`);
    }
    if (step === "cap_per" && d.pkg && d.product && d.product.currency !== "USD") {
      lines.push(`ℹ️ The card is denominated in ${esc(d.product.currency)}; its USD price is set by Bitrefill at purchase time. Choose a cap you're comfortable with.`);
    }
    const hint = d.usdHints?.[key];
    const presets = [...new Set([...(hint !== undefined ? [hint] : []), ...CAP_PRESETS[key]])];
    const row: Button[] = presets.map((c) => ({ text: formatUsd(c) + (c === hint ? " (you said)" : ""), data: `cap:${c}` }));
    return { text: lines.join("\n"), buttons: [row, CANCEL_ROW] };
  }

  private async setCap(a: Actor, s: Session, step: Step, text: string): Promise<Reply[]> {
    const { key } = CAP_STEPS[step]!;
    const parsed = parseUsdInput(text);
    if (!parsed.ok) {
      return [
        {
          text:
            parsed.reason === "non_usd"
              ? `Limits are enforced in USD and I won't convert currencies silently. Please send the USD amount you want (e.g. ${code("2")} or ${code("$1.50")}).`
              : `I couldn't read that amount. Try ${code("2")}, ${code("$1.50")} or ${code("150 cents")}.`,
          buttons: [CANCEL_ROW],
        },
      ];
    }
    return this.applyCap(a, s, key, parsed.cents);
  }

  private async applyCap(a: Actor, s: Session, key: CapKey, cents: number): Promise<Reply[]> {
    const check = checkCap(s.draft, key, cents);
    if (!check.ok) return [{ text: `${check.message} Please send another amount.`, buttons: [CANCEL_ROW] }];
    s.draft[key] = cents;
    return this.advance(a, s);
  }

  private async setCapFromCallback(a: Actor, arg: string): Promise<Reply[]> {
    const s = this.sessions.get(a.chatId);
    const step = s ? nextStep(s.draft) : "done";
    const entry = CAP_STEPS[step];
    const cents = Number(arg);
    if (!s || !entry || !Number.isSafeInteger(cents)) return [{ text: "That option has expired. Send /newrule to start over." }];
    return this.applyCap(a, s, entry.key, cents);
  }

  // ------------------------------------------------------------ draft creation

  /**
   * Validates the product/package against the live catalog, then creates a DRAFT rule.
   * Exposed for tests: an ID that isn't in the engine catalog can never reach POST /v1/rules.
   */
  async createDraftRule(ownerChatId: string, draft: RuleDraft): Promise<Rule> {
    const body = toCreateRuleBody(draft, ownerChatId);
    await this.checkRecipient(body.recipientChatId, ownerChatId);
    let product: Product;
    try {
      product = await this.engine.getProduct(body.productId);
    } catch (err) {
      if (err instanceof EngineError && err.kind === "http" && err.status === 404) {
        throw new UserFacingError("That product isn't in the catalog. Nothing was created.");
      }
      throw err;
    }
    if (product.id !== body.productId) throw new UserFacingError("That product isn't in the catalog. Nothing was created.");
    if (!product.inStock) throw new UserFacingError(`${product.name} is out of stock right now. Nothing was created.`);
    if (!product.packages.some((p) => p.packageId === body.packageId)) {
      throw new UserFacingError("That package isn't offered for this product. Nothing was created.");
    }
    this.productCache.set(product.id, product);
    return this.engine.createRule(body);
  }

  private async checkRecipient(recipient: string, owner: string): Promise<void> {
    if (!normalizeRecipient(recipient) || (recipient !== owner && !this.verifyRecipient)) {
      throw new UserFacingError("Recipient is not linked to a verified private chat. Ask them to start this bot first.");
    }
    if (this.verifyRecipient && !await this.verifyRecipient(recipient)) {
      throw new UserFacingError("Recipient could not be verified as a private chat. Ask them to start this bot, then retry.");
    }
  }

  private async finalize(a: Actor, s: Session): Promise<Reply[]> {
    const rule = await this.createDraftRule(a.userId, s.draft);
    this.sessions.clear(a.chatId);
    const product = this.productCache.get(rule.productId ?? s.draft.product?.id ?? "");
    const view = ruleView(
      {
        ...rule,
        // Fall back to what the owner just confirmed if the engine echoes fewer fields.
        repository: rule.repository ?? s.draft.repository,
        requiredLabel: rule.requiredLabel ?? s.draft.requiredLabel,
        recipientChatId: rule.recipientChatId ?? s.draft.recipientChatId,
        productId: rule.productId ?? s.draft.product?.id,
        packageId: rule.packageId ?? s.draft.pkg?.packageId,
        name: rule.name ?? s.draft.name,
        perPurchaseCapUsdCents: rule.perPurchaseCapUsdCents ?? s.draft.perPurchaseCapUsdCents,
        dailyCapUsdCents: rule.dailyCapUsdCents ?? s.draft.dailyCapUsdCents,
        monthlyCapUsdCents: rule.monthlyCapUsdCents ?? s.draft.monthlyCapUsdCents,
        autoApproveUpToUsdCents: rule.autoApproveUpToUsdCents ?? s.draft.autoApproveUpToUsdCents,
      },
      product,
    );
    return [
      {
        text: `✅ Your rule is ready to review.\n\n${renderRule(view, a.userId)}\n\n<b>It's a draft — nothing will be bought until you enable it.</b>`,
        buttons: [[...ruleActionButtons(view), { text: "✏️ Edit / restart", data: "restart" }]],
      },
    ];
  }

  // ------------------------------------------------------------ managing rules

  private async viewRules(a: Actor): Promise<{ rule: Rule; view: ReturnType<typeof ruleView> }[]> {
    const rules = await this.engine.listRules(a.userId);
    const ids = [...new Set(rules.map((r) => r.productId).filter((x): x is string => !!x))];
    await Promise.allSettled(
      ids
        .filter((id) => !this.productCache.has(id))
        .map(async (id) => this.productCache.set(id, await this.engine.getProduct(id))),
    );
    return rules.map((rule) => ({ rule, view: ruleView(rule, this.productCache.get(rule.productId ?? "")) }));
  }

  private async listRules(a: Actor): Promise<Reply[]> {
    const items = await this.viewRules(a);
    if (items.length === 0) return [{ text: "You have no rules yet. Send /newrule to create one." }];
    return items.map(({ view }) => ({ text: renderRule(view, a.userId), buttons: [ruleActionButtons(view)].filter((r) => r.length) }));
  }

  private async pickRule(a: Actor, action: "enable" | "pause" | "resume"): Promise<Reply[]> {
    const items = await this.viewRules(a);
    const eligible = items.filter(({ view }) => {
      const s = view.status.toLowerCase();
      if (action === "enable") return s === "draft";
      if (action === "resume") return s === "paused";
      return !["draft", "paused", "archived", "disabled", "deleted"].includes(s);
    });
    if (eligible.length === 0) {
      const none = { enable: "No draft rules to enable.", pause: "No active rules to pause.", resume: "No paused rules to resume." }[action];
      return [{ text: `${none} See /rules.` }];
    }
    const data = { enable: "enq", pause: "pa", resume: "rs" }[action];
    const label = { enable: "✅ Enable", pause: "⏸ Pause", resume: "▶️ Resume" }[action];
    return eligible.map(({ view }) => ({
      text: renderRule(view, a.userId),
      buttons: [[{ text: `${label} “${view.name.slice(0, 30)}”`, data: `${data}:${view.id}` }]],
    }));
  }

  private async confirmEnable(a: Actor, ruleId: string): Promise<Reply[]> {
    const items = await this.viewRules(a);
    const hit = items.find((i) => i.rule.id === ruleId);
    if (!hit) return [{ text: "I couldn't find that rule." }];
    return [
      {
        text: `${renderRule(hit.view, a.userId)}\n\n⚠️ Enabling lets PactPilot spend automatically, within these limits, every time a matching PR is merged. Enable it?`,
        buttons: [[{ text: "✅ Yes, enable", data: `en:${ruleId}` }, { text: "Not now", data: "cancel" }]],
      },
    ];
  }

  private async ruleAction(a: Actor, ruleId: string, action: "enable" | "pause" | "resume"): Promise<CallbackResult> {
    if (action !== "pause") {
      const pending = (await this.engine.listRules(a.userId)).find(r => r.id === ruleId);
      if (pending?.recipientChatId) await this.checkRecipient(pending.recipientChatId, a.userId);
    }
    const fn = { enable: this.engine.enableRule, pause: this.engine.pauseRule, resume: this.engine.resumeRule }[action];
    const rule = await fn.call(this.engine, ruleId, a.userId);
    const status = rule?.status ? ` (status: ${esc(rule.status)})` : "";
    const text = {
      enable: `✅ Rule enabled${status}. I'll act on merged PRs that match, within your limits, and message you here at every step.`,
      pause: `⏸ Rule paused${status}. No purchases will be made until you resume it.`,
      resume: `▶️ Rule resumed${status}.`,
    }[action];
    this.logger.info("rule_action", { action, ruleId });
    return { replies: [{ text }], toast: { enable: "Rule enabled", pause: "Rule paused", resume: "Rule resumed" }[action] };
  }

  private async decide(a: Actor, purchaseId: string, decision: "approve" | "reject"): Promise<CallbackResult> {
    await this.engine.decideApproval(purchaseId, a.userId, decision);
    this.logger.info("approval_decision", { purchaseId, decision });
    return decision === "approve"
      ? {
          replies: [{ text: "👍 Approved. The engine is processing the purchase. I'll confirm here once it reports delivery." }],
          toast: "Approved",
        }
      : { replies: [{ text: "🚫 Rejected. No purchase will be made for this request." }], toast: "Rejected" };
  }

  private async status(a: Actor): Promise<Reply[]> {
    const [health, rules, purchases] = await Promise.all([
      this.engine.health().catch(() => null),
      this.engine.listRules(a.userId),
      this.engine.listPurchases(a.userId),
    ]);
    const live = health ? (health.livePurchasesEnabled ? "🟢 live purchases ON" : "🟡 live purchases OFF (dry run)") : "🔴 health check failed";
    const active = rules.filter((r) => !["draft", "paused"].includes(r.status.toLowerCase())).length;
    const recent = purchases
      .slice(-5).reverse()
      .map((p) => {
        const amt = p.amountUsdCents != null ? formatUsd(p.amountUsdCents) : "—";
        const inv = p.invoiceId ? ` · invoice ${code(p.invoiceId)}` : "";
        return `• ${esc(p.status)} · ${amt}${inv}`;
      });
    return [
      {
        text: [
          `📊 ${bold("Status")}`,
          `Engine: ${live}`,
          `Rules: ${rules.length} total, ${active} active`,
          recent.length ? `Recent purchases:\n${recent.join("\n")}` : `No purchases yet.`,
        ].join("\n"),
      },
    ];
  }

  // ------------------------------------------------------------ errors

  private async guard(fn: () => Promise<Reply[]>): Promise<Reply[]> {
    try {
      return await fn();
    } catch (err) {
      return [this.errorReply(err)];
    }
  }

  private errorReply(err: unknown): Reply {
    if (err instanceof UserFacingError) return { text: `⚠️ ${esc(err.message)}` };
    if (err instanceof EngineError) {
      this.logger.warn("engine_error", { kind: err.kind, status: err.status });
      switch (err.kind) {
        case "offline":
          return { text: "⚠️ I can't reach the PactPilot engine right now. The request outcome may be unknown. Check /rules or /status before retrying an action." };
        case "unauthorized":
          return { text: "🔒 The engine rejected my internal API token. Check INTERNAL_API_TOKEN on both services. Nothing was changed." };
        case "invalid_response":
          return { text: "⚠️ The engine sent an unexpected response. Check /rules or /status to confirm the action's outcome." };
        default:
          return { text: `⚠️ The engine said: ${esc(err.message)} (HTTP ${err.status}). Nothing was changed.` };
      }
    }
    this.logger.error("unexpected_error");
    return { text: "⚠️ Something went wrong on my side. Nothing was changed." };
  }
}

export { parseProductQuery } from "../rules/query.js";
