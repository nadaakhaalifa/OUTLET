import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, ms, toMoney, toPortError, money, type AdapterContext } from "../../services/wire";
import {
  type AttemptState, type AutoBuyAttempt, type AutoBuyCapabilities, type AutoBuyDraft, type AutoBuyList, type AutoBuyMode, type AutoBuyPort, type AutoBuyRule,
  type AutoBuyTerms, type CreateOutcome, type CreateRefusal, type DisplayLocale,
} from "./model";

const MODE_FROM_WIRE: Readonly<Record<schemas.AutoBuyRule["mode"], AutoBuyMode>> = { notify_confirm: "notifyConfirm", unattended: "unattended" };
const MODE_TO_WIRE: Readonly<Record<AutoBuyMode, "notify_confirm" | "unattended">> = { notifyConfirm: "notify_confirm", unattended: "unattended" };

const REFUSALS: Readonly<Record<string, CreateRefusal>> = {
  step_up_required: "stepUpRequired",
  plus_required: "plusRequired",
  age_restricted: "ageRestricted",
  risk_blocked: "riskBlocked",
  unattended_unavailable: "unattendedUnavailable",
  sku_unavailable: "skuUnavailable",
  drop_sku_excluded: "dropExcluded",
  size_invalid: "sizeInvalid",
  payment_token_invalid: "tokenInvalid",
  auto_buy_limit_reached: "limitReached",
  auto_buy_rule_exists: "duplicate",
  terms_invalid: "invalidTerms",
};

function blankToNull(s: string): string | null {
  return s === "" ? null : s;
}

function attempt(a: schemas.AutoBuyAttempt): AutoBuyAttempt {
  const state: AttemptState = a.state;
  return {
    id: a.id,
    state,
    mode: MODE_FROM_WIRE[a.mode],
    noticeSentAtMs: ms(a.notice_sent_at),
    cancelDeadlineMs: ms(a.cancel_deadline),
    cancellable: a.cancellable,
    failureReason: blankToNull(a.failure_reason),
    orderGroupId: blankToNull(a.order_group_id),
  };
}

export function ruleFromWire(r: schemas.AutoBuyRule): AutoBuyRule {
  return {
    id: r.id,
    skuId: r.sku_id,
    productId: null,
    title: null,
    sizeLabel: r.size_label,
    targetPrice: money(r.target_price),
    maxPrice: money(r.max_price),
    mode: MODE_FROM_WIRE[r.mode],
    status: r.status,
    closedReason: blankToNull(r.closed_reason),
    paused: r.paused,
    expiresAtMs: ms(r.expires_at),
    acceptedAtMs: ms(r.accepted_at),
    termsVersion: r.terms_version,
    latestAttempt: attempt(r.latest_attempt),
  };
}

/** Maps a refused create call to an outcome; anything unexpected stays an error (never silently swallowed). */
export function createOutcomeFromError(e: unknown): CreateOutcome {
  if (e instanceof ApiError) {
    if (e.status === 404) return { kind: "refused", reason: "disabled" };
    const code = e.code ?? "";
    if (e.status === 409 && code === "terms_version_stale") {
      const cur = e.problem["current_version"];
      return { kind: "termsStale", currentVersion: typeof cur === "number" ? cur : null };
    }
    const reason = REFUSALS[code];
    if (reason !== undefined && (e.status === 403 || e.status === 409 || e.status === 422)) return { kind: "refused", reason };
  }
  throw toPortError(e);
}

/**
 * /v1/me/auto-buy*. The list carries `server_time` (anchors the 15 minute cancel countdown, never the device
 * clock) and `capabilities.unattended_available`; the mandate text and version come from GET /v1/me/auto-buy/terms.
 * The list has no product id / title.
 */
export class ApiAutoBuyPort implements AutoBuyPort {
  constructor(private readonly ctx: AdapterContext) {}

  capabilities(): Promise<AutoBuyCapabilities> {
    return guard(async () => {
      let enabled = true;
      let unattendedAvailable = false;
      try {
        const r = dataOf(await this.ctx.client.listAutoBuyRules());
        enabled = !r.paused;
        unattendedAvailable = r.capabilities.unattended_available;
      } catch (e) {
        // A non-Plus shopper may be refused the list; creation is gated separately by the Plus entitlement.
        if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) throw e;
      }
      return { enabled, unattendedAvailable, savedCard: null, passkeySession: null };
    });
  }

  terms(locale: DisplayLocale): Promise<AutoBuyTerms> {
    return guard(async () => {
      const t = dataOf(await this.ctx.client.getAutoBuyTerms({ query: { locale } }));
      return { version: t.version, locale: t.locale, text: t.text };
    });
  }

  list(): Promise<AutoBuyList> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.listAutoBuyRules());
      return { paused: r.paused, rules: r.items.map(ruleFromWire), serverNowMs: ms(r.server_time) };
    });
  }

  async create(d: AutoBuyDraft, idempotencyKey: string): Promise<CreateOutcome> {
    try {
      const body: schemas.AutoBuyCreateRequest = {
        sku_id: d.skuId,
        size_label: d.sizeLabel,
        target_price: toMoney(d.targetPrice),
        max_price: toMoney(d.maxPrice),
        expires_at: new Date(d.expiresAtMs).toISOString(),
        mode: MODE_TO_WIRE[d.mode],
        ...(d.paymentTokenRef !== null ? { payment_token_ref: d.paymentTokenRef } : {}),
        locale: d.locale,
        accepted_terms_version: d.termsVersion,
      };
      const r = dataOf(await this.ctx.client.createAutoBuyRule({ body }, { idempotencyKey }));
      return { kind: "created", rule: ruleFromWire(r) };
    } catch (e) {
      return createOutcomeFromError(e);
    }
  }

  /** Prompts the server after the SCA challenge; the server looks the charge up itself (the call is never evidence). */
  completeSca(attemptId: string, idempotencyKey: string): Promise<{ status: string; orderGroupId: string | null }> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.completeAutoBuySca({ path: { id: attemptId } }, { idempotencyKey }));
      return { status: r.status, orderGroupId: r.order_group_id };
    });
  }

  cancelRule(ruleId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.cancelAutoBuyRule({ path: { id: ruleId } }, { idempotencyKey }));
    });
  }

  cancelAttempt(attemptId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.cancelAutoBuyAttempt({ path: { id: attemptId } }, { idempotencyKey }));
    });
  }

  notifyAtTarget(productId: string, skuId: string, targetPrice: bigint, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.createProductAlert(
        { path: { productId }, body: { type: "price_drop", sku_id: skuId, target_price: toMoney(targetPrice) } },
        { idempotencyKey },
      ));
    });
  }
}

