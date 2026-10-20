/**
 * Price-drop auto-buy (phase 3 spec P3-01, ADR-0036). Pure model, port and in-memory fake; no UI imports.
 * Money is integer piastres. Everything binding comes from the server: the mandate text and version, whether
 * unattended charging is available at all, the 15 minute cancel deadline and its server clock. The app never
 * pre-ticks consent, never invents a countdown from the device clock, and shows the unattended mode only when
 * the server reports it as available.
 */
import { clockFromServer, countdownParts, serverNow, type CountdownParts, type ServerClock } from "../drops/serverClock";
import type { Membership } from "../plus/model";
import { parseBudgetEgp } from "../search/model";
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export type DisplayLocale = "ar" | "en";
export type AutoBuyMode = "notifyConfirm" | "unattended";

/** Spec: a rule lasts at most 90 days. */
export const MAX_RULE_DAYS = 90;
export const EXPIRY_CHOICES_DAYS: readonly number[] = [30, 60, 90];
/** Spec: 15 minutes between the pre-charge notice and the charge. The deadline itself always comes from the server. */
export const CANCEL_WINDOW_MINUTES = 15;
const DAY_MS = 86_400_000;

export interface AutoBuyTerms {
  readonly version: number;
  readonly locale: DisplayLocale;
  /** Shown verbatim. Never edited, summarised or re-flowed by the app. */
  readonly text: string;
}

export interface SavedCard {
  readonly tokenRef: string;
  readonly label: string;
}

export interface AutoBuyCapabilities {
  /** Kill switch `price_drop_auto_buy` is off: stored rules are paused and creation is refused. */
  readonly enabled: boolean;
  /** Server says unattended charging (kill switch `auto_buy.charge`, VR-P3-01/02) is available. Absent = false. */
  readonly unattendedAvailable: boolean;
  /** Needed for unattended mode only; notify-and-confirm never needs a card. */
  readonly savedCard: SavedCard | null;
  /** True when the current session is passkey-assured, null when the app cannot tell (the server then decides). */
  readonly passkeySession: boolean | null;
}

export type AttemptState =
  | "TRIGGERED" | "SKIPPED" | "NOTIFIED" | "CHARGING" | "REQUIRES_USER_ACTION" | "PURCHASED" | "CANCELLED_BY_USER" | "FAILED" | "DISARMED";
export type RuleStatus = "ARMED" | "PURCHASED" | "DISARMED" | "EXPIRED";

export interface AutoBuyAttempt {
  readonly id: string;
  readonly state: AttemptState;
  readonly mode: AutoBuyMode;
  readonly noticeSentAtMs: number;
  /** Server-stamped end of the cancel window (epoch ms). */
  readonly cancelDeadlineMs: number;
  /** Server verdict at read time: false once the window closed or the charge was claimed. */
  readonly cancellable: boolean;
  readonly failureReason: string | null;
  readonly orderGroupId: string | null;
}

export interface AutoBuyRule {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string | null;
  /** Null when the contract does not carry it (gap): the row then shows the size only. */
  readonly title: string | null;
  readonly sizeLabel: string;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly mode: AutoBuyMode;
  readonly status: RuleStatus;
  readonly closedReason: string | null;
  readonly paused: boolean;
  readonly expiresAtMs: number;
  readonly acceptedAtMs: number;
  readonly termsVersion: number;
  readonly latestAttempt: AutoBuyAttempt | null;
}

export interface AutoBuyList {
  /** Kill switch blocks evaluation: stored rules stay armed and are shown as paused. */
  readonly paused: boolean;
  readonly rules: readonly AutoBuyRule[];
  /** Server `now` (epoch ms) at read time, or null when the contract gives none (gap). Never the device clock. */
  readonly serverNowMs: number | null;
}

export interface AutoBuyDraft {
  readonly skuId: string;
  readonly sizeLabel: string;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly expiresAtMs: number;
  readonly mode: AutoBuyMode;
  readonly termsVersion: number;
  readonly locale: DisplayLocale;
  /** Required for unattended mode only. */
  readonly paymentTokenRef: string | null;
}

export type CreateRefusal =
  | "stepUpRequired" | "plusRequired" | "ageRestricted" | "riskBlocked" | "unattendedUnavailable" | "disabled"
  | "skuUnavailable" | "dropExcluded" | "sizeInvalid" | "tokenInvalid" | "limitReached" | "duplicate" | "invalidTerms";

export type CreateOutcome =
  | { readonly kind: "created"; readonly rule: AutoBuyRule }
  | { readonly kind: "termsStale"; readonly currentVersion: number | null }
  | { readonly kind: "refused"; readonly reason: CreateRefusal };

export interface AutoBuyPort {
  capabilities(): Promise<AutoBuyCapabilities>;
  /** The current mandate text and version for the shopper's language. */
  terms(locale: DisplayLocale): Promise<AutoBuyTerms>;
  list(): Promise<AutoBuyList>;
  create(draft: AutoBuyDraft, idempotencyKey: string): Promise<CreateOutcome>;
  cancelRule(ruleId: string, idempotencyKey: string): Promise<void>;
  cancelAttempt(attemptId: string, idempotencyKey: string): Promise<void>;
  /** Plain "notify me at my target price" (no charge, no Plus needed): a price_drop product alert. */
  notifyAtTarget(productId: string, skuId: string, targetPrice: bigint, idempotencyKey: string): Promise<void>;
}

/* ---- entitlement and capability helpers ---- */

/** Plus benefits apply while the subscription is active, in trial, or in the paid-up grace period. */
export function isPlusMember(m: Membership | null): boolean {
  return m !== null && (m.status === "ACTIVE" || m.status === "TRIALING" || m.status === "PAST_DUE");
}

export type RuleSheetAccess =
  | { readonly kind: "notifyOnly"; readonly why: "notPlus" | "disabled" | "unknown" }
  | { readonly kind: "stepUp" }
  | { readonly kind: "full"; readonly offerUnattended: boolean };

/**
 * What the rule sheet may offer. Notify-and-confirm is the default product; unattended is offered only when the
 * server reports it available and a saved card exists. A session known not to be passkey-assured gets a step-up
 * prompt instead of the form (the server enforces it either way).
 */
export function ruleSheetAccess(plus: boolean | null, caps: AutoBuyCapabilities | null): RuleSheetAccess {
  if (plus === null || caps === null) return { kind: "notifyOnly", why: "unknown" };
  if (!plus) return { kind: "notifyOnly", why: "notPlus" };
  if (!caps.enabled) return { kind: "notifyOnly", why: "disabled" };
  if (caps.passkeySession === false) return { kind: "stepUp" };
  return { kind: "full", offerUnattended: caps.unattendedAvailable && caps.savedCard !== null };
}

/* ---- draft validation ---- */

export type DraftError =
  | "targetInvalid" | "targetNotBelowPrice" | "maxInvalid" | "maxBelowTarget" | "expiryInvalid" | "consentMissing" | "termsMissing" | "sizeMissing" | "cardMissing";

export interface DraftInput {
  readonly targetText: string;
  readonly maxText: string;
  readonly currentPrice: bigint;
  readonly expiryDays: number;
  readonly consent: boolean;
  readonly terms: AutoBuyTerms | null;
  readonly skuId: string | null;
  readonly sizeLabel: string | null;
  readonly mode: AutoBuyMode;
  readonly savedCard: SavedCard | null;
  readonly nowMs: number;
  readonly locale: DisplayLocale;
}

export type DraftResult =
  | { readonly ok: true; readonly draft: AutoBuyDraft }
  | { readonly ok: false; readonly errors: readonly DraftError[] };

export function validateDraft(i: DraftInput): DraftResult {
  const errors: DraftError[] = [];
  const target = parseBudgetEgp(i.targetText);
  const max = parseBudgetEgp(i.maxText);
  if (target === null) errors.push("targetInvalid");
  else if (target >= i.currentPrice) errors.push("targetNotBelowPrice");
  if (max === null) errors.push("maxInvalid");
  else if (target !== null && max < target) errors.push("maxBelowTarget");
  if (!Number.isInteger(i.expiryDays) || i.expiryDays < 1 || i.expiryDays > MAX_RULE_DAYS) errors.push("expiryInvalid");
  if (i.terms === null) errors.push("termsMissing");
  if (!i.consent) errors.push("consentMissing");
  if (i.skuId === null || i.sizeLabel === null) errors.push("sizeMissing");
  if (i.mode === "unattended" && i.savedCard === null) errors.push("cardMissing");
  if (errors.length > 0 || target === null || max === null || i.terms === null || i.skuId === null || i.sizeLabel === null) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      skuId: i.skuId,
      sizeLabel: i.sizeLabel,
      targetPrice: target,
      maxPrice: max,
      expiresAtMs: i.nowMs + i.expiryDays * DAY_MS,
      mode: i.mode,
      termsVersion: i.terms.version,
      locale: i.locale,
      paymentTokenRef: i.mode === "unattended" ? (i.savedCard?.tokenRef ?? null) : null,
    },
  };
}

/** Notify-only needs just a target below the current price. */
export function validateNotify(targetText: string, currentPrice: bigint, skuId: string | null): { readonly ok: true; readonly target: bigint } | { readonly ok: false; readonly error: DraftError } {
  if (skuId === null) return { ok: false, error: "sizeMissing" };
  const target = parseBudgetEgp(targetText);
  if (target === null) return { ok: false, error: "targetInvalid" };
  if (target >= currentPrice) return { ok: false, error: "targetNotBelowPrice" };
  return { ok: true, target };
}

/* ---- cancel window ---- */

export type CancelWindow =
  | { readonly kind: "closed" }
  /** The server clock is unknown (contract gap): show the deadline as a time, never a ticking countdown. */
  | { readonly kind: "deadline"; readonly deadlineMs: number }
  | { readonly kind: "open"; readonly remainingMs: number; readonly parts: CountdownParts; readonly deadlineMs: number };

const OPEN_STATES: readonly AttemptState[] = ["TRIGGERED", "NOTIFIED"];

/**
 * The remaining cancel window on SERVER time: deadline minus (device now + the offset captured when the server's
 * own timestamp arrived). Without a server timestamp no countdown is computed at all.
 */
export function cancelWindow(a: AutoBuyAttempt, clock: ServerClock | null, deviceNowMs: number): CancelWindow {
  if (!a.cancellable || !OPEN_STATES.includes(a.state)) return { kind: "closed" };
  if (clock === null) return { kind: "deadline", deadlineMs: a.cancelDeadlineMs };
  const remaining = a.cancelDeadlineMs - serverNow(clock, deviceNowMs);
  if (remaining <= 0) return { kind: "closed" };
  return { kind: "open", remainingMs: remaining, parts: countdownParts(remaining), deadlineMs: a.cancelDeadlineMs };
}

/** Africa/Cairo wall-clock time (hour and minute) for a server deadline. */
export function formatCairoClock(ms: number, locale: DisplayLocale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export function listClock(l: AutoBuyList, deviceNowMs: number): ServerClock | null {
  return l.serverNowMs === null ? null : clockFromServer(l.serverNowMs, deviceNowMs);
}

/* ---- list view ---- */

export type RuleBadge = "armed" | "paused" | "purchased" | "stopped" | "expired";

export interface RuleRowView {
  readonly rule: AutoBuyRule;
  readonly badge: RuleBadge;
  readonly canCancel: boolean;
  /** Attempt that needs the shopper's attention (a notice with an open cancel window or a pending confirmation). */
  readonly attention: AutoBuyAttempt | null;
}

export function ruleBadge(r: AutoBuyRule, listPaused: boolean): RuleBadge {
  if (r.status === "PURCHASED") return "purchased";
  if (r.status === "EXPIRED") return "expired";
  if (r.status === "DISARMED") return "stopped";
  return listPaused || r.paused ? "paused" : "armed";
}

export function buildRuleRows(l: AutoBuyList): readonly RuleRowView[] {
  const order: Record<RuleBadge, number> = { armed: 0, paused: 1, purchased: 2, stopped: 3, expired: 4 };
  return l.rules
    .map((rule): RuleRowView => {
      const a = rule.latestAttempt;
      const attention = a !== null && (a.state === "NOTIFIED" || a.state === "TRIGGERED" || a.state === "REQUIRES_USER_ACTION") ? a : null;
      return { rule, badge: ruleBadge(rule, l.paused), canCancel: rule.status === "ARMED", attention };
    })
    .sort((x, y) => order[x.badge] - order[y.badge]);
}

export type AutoBuyScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly list: AutoBuyList };

export function autoBuyFailureState(e: unknown): AutoBuyScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export const FIXTURE_TERMS: Readonly<Record<DisplayLocale, AutoBuyTerms>> = {
  en: { version: 3, locale: "en", text: "Fixture mandate text, version 3. Not a real mandate." },
  ar: { version: 3, locale: "ar", text: "نص تفويض تجريبي، الإصدار 3. ليس تفويضاً حقيقياً." },
};

export const FIXTURE_CAPABILITIES: AutoBuyCapabilities = { enabled: true, unattendedAvailable: false, savedCard: null, passkeySession: true };

export class InMemoryAutoBuyPort implements AutoBuyPort {
  private rules: AutoBuyRule[] = [];
  private readonly seen = new Map<string, CreateOutcome>();
  readonly alerts: { productId: string; skuId: string; target: bigint }[] = [];
  private n = 0;
  constructor(
    private caps: AutoBuyCapabilities = FIXTURE_CAPABILITIES,
    private failure: PortFailure | null = null,
    private readonly clock: () => number = Date.now,
    private termsVersion = FIXTURE_TERMS.en.version,
  ) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  setCapabilities(c: AutoBuyCapabilities): void {
    this.caps = c;
  }
  setTermsVersion(v: number): void {
    this.termsVersion = v;
  }
  seed(rules: readonly AutoBuyRule[]): void {
    this.rules = [...rules];
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async capabilities(): Promise<AutoBuyCapabilities> {
    this.check();
    return this.caps;
  }
  async terms(locale: DisplayLocale): Promise<AutoBuyTerms> {
    this.check();
    return { ...FIXTURE_TERMS[locale], version: this.termsVersion };
  }
  async list(): Promise<AutoBuyList> {
    this.check();
    return { paused: !this.caps.enabled, rules: this.rules, serverNowMs: this.clock() };
  }
  async create(d: AutoBuyDraft, key: string): Promise<CreateOutcome> {
    this.check();
    const prior = this.seen.get(key);
    if (prior !== undefined) return prior;
    let out: CreateOutcome;
    if (!this.caps.enabled) out = { kind: "refused", reason: "disabled" };
    else if (this.caps.passkeySession === false) out = { kind: "refused", reason: "stepUpRequired" };
    else if (d.termsVersion !== this.termsVersion) out = { kind: "termsStale", currentVersion: this.termsVersion };
    else if (d.mode === "unattended" && !this.caps.unattendedAvailable) out = { kind: "refused", reason: "unattendedUnavailable" };
    else if (this.rules.some((r) => r.skuId === d.skuId && r.status === "ARMED")) out = { kind: "refused", reason: "duplicate" };
    else if (this.rules.filter((r) => r.status === "ARMED").length >= 5) out = { kind: "refused", reason: "limitReached" };
    else {
      const now = this.clock();
      const rule: AutoBuyRule = {
        id: `rule-${++this.n}`, skuId: d.skuId, productId: null, title: null, sizeLabel: d.sizeLabel, targetPrice: d.targetPrice, maxPrice: d.maxPrice,
        mode: d.mode, status: "ARMED", closedReason: null, paused: false, expiresAtMs: d.expiresAtMs, acceptedAtMs: now, termsVersion: d.termsVersion, latestAttempt: null,
      };
      this.rules = [rule, ...this.rules];
      out = { kind: "created", rule };
    }
    this.seen.set(key, out);
    return out;
  }
  async cancelRule(ruleId: string): Promise<void> {
    this.check();
    this.rules = this.rules.map((r) => (r.id === ruleId ? { ...r, status: "DISARMED", closedReason: "cancelled_by_user" } : r));
  }
  async cancelAttempt(attemptId: string): Promise<void> {
    this.check();
    this.rules = this.rules.map((r) =>
      r.latestAttempt !== null && r.latestAttempt.id === attemptId
        ? { ...r, latestAttempt: { ...r.latestAttempt, state: "CANCELLED_BY_USER", cancellable: false } }
        : r);
  }
  async notifyAtTarget(productId: string, skuId: string, target: bigint): Promise<void> {
    this.check();
    this.alerts.push({ productId, skuId, target });
  }
}
