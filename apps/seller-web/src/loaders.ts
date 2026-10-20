/**
 * Screen loaders: API result -> plain, serialisable view models (strings only, no bigint) -> ScreenState.
 * No React and no Next imports, so they run under vitest with a fake Transport.
 */
import type { SellerApi } from "./api/client";
import type { SellerPermissions } from "./api/schemas-access";
import type { SellerRole } from "./api/schemas-onboarding";
import type { Locale, MessageKey } from "./i18n";
import { formatDateTime, formatInt, formatMoney } from "./lib/format";
import {
  defaultRange, freshnessKey, freshnessLevel, funnelRows, geographyRows, isEmptyReport, salesTiles, trafficRows,
  type BreakdownRow, type FreshnessLevel, type FunnelRow, type Tile,
} from "./view-models/analytics";
import { acceptDeadline, availableActions, governorateLabel, type OrderAction } from "./view-models/orders";
import { stateFromError, stateFromResult, type ScreenState } from "./view-models/screen-state";

export interface Ctx {
  readonly api: SellerApi | null;
  readonly locale: Locale;
  /** Server-decided role label for display only; never used to grant anything. */
  readonly role: SellerRole | null;
  /** Server permissions for the active store; absent or null = not enforced. */
  readonly permissions?: SellerPermissions | null;
  readonly nowMs: number;
}

const notConfigured: ScreenState<never> = { kind: "not_configured" };

/* ---------------- dashboard ---------------- */
export interface DashboardVM {
  readonly storeId: string;
  readonly tiles: readonly Tile[];
  readonly freshness: { readonly level: FreshnessLevel; readonly key: MessageKey; readonly asOf: string | null; readonly sloMinutes: number };
  readonly kMin: number;
  readonly funnel: readonly FunnelRow[] | null;
  readonly traffic: { readonly rows: readonly BreakdownRow[]; readonly suppressed: number } | null;
  readonly geography: { readonly rows: readonly (BreakdownRow & { readonly orders: string })[]; readonly suppressed: number } | null;
  readonly aging:
    | readonly {
        readonly skuId: string; readonly size: string; readonly severity: string; readonly ageDays: string; readonly onHand: string;
        readonly price: string; readonly suggested: string | null; readonly notice: string;
      }[]
    | null;
}

export async function loadDashboard(c: Ctx): Promise<ScreenState<DashboardVM>> {
  if (c.api === null) return notConfigured;
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const storeId = store.value.data.id;
  const range = defaultRange(c.nowMs);
  const [sales, funnel, traffic, geo, aging] = await Promise.all([
    c.api.salesReport(storeId, range), c.api.funnelReport(storeId, range), c.api.trafficReport(storeId, range),
    c.api.geographyReport(storeId, range), c.api.agingReport(storeId, range),
  ]);
  if (!sales.ok) return stateFromError(sales.error);
  const s = sales.value.data;
  if (isEmptyReport(s)) return { kind: "empty" };
  const level = freshnessLevel(s.meta);
  const vm: DashboardVM = {
    storeId,
    tiles: salesTiles(s, c.locale),
    freshness: {
      level,
      key: freshnessKey(level),
      asOf: s.meta.freshness.as_of === null ? null : formatDateTime(s.meta.freshness.as_of, c.locale),
      sloMinutes: Math.round(s.meta.freshness.slo_ms / 60_000),
    },
    kMin: s.meta.k_anonymity_min,
    funnel: funnel.ok ? funnelRows(funnel.value.data, c.locale) : null,
    traffic: traffic.ok ? { rows: trafficRows(traffic.value.data, c.locale), suppressed: traffic.value.data.by_source.suppressed_cells } : null,
    geography: geo.ok ? { rows: geographyRows(geo.value.data, c.locale), suppressed: geo.value.data.suppressed_governorates } : null,
    aging: aging.ok
      ? aging.value.data.alerts.map((a) => ({
          skuId: a.sku_id, size: a.size, severity: a.severity, ageDays: formatInt(a.age_days, c.locale), onHand: formatInt(a.on_hand, c.locale),
          price: formatMoney(a.price.minor, c.locale),
          suggested: a.markdown_recommendation.suggested_price === null ? null : formatMoney(a.markdown_recommendation.suggested_price.minor, c.locale),
          notice: c.locale === "ar" ? a.markdown_recommendation.notice.ar : a.markdown_recommendation.notice.en,
        }))
      : null,
  };
  return { kind: "ready", data: vm, serverNowMs: sales.value.serverNowMs };
}

/* ---------------- orders ---------------- */
export interface OrderRowVM {
  readonly id: string;
  readonly statusKey: MessageKey;
  readonly createdAt: string;
  readonly lines: readonly { readonly title: string; readonly qty: string; readonly size: string | null }[];
  readonly subtotal: string;
  readonly net: string | null;
  readonly paymentKey: MessageKey;
  readonly governorate: string | null;
  readonly deadlineIso: string | null;
  readonly actions: readonly OrderAction[];
}
export interface OrdersVM {
  readonly rows: readonly OrderRowVM[];
  readonly nextCursor: string | null;
}

export async function loadOrders(c: Ctx, cursor?: string): Promise<ScreenState<OrdersVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.listOrders(cursor);
  return stateFromResult(
    r,
    (page): OrdersVM => ({
      nextCursor: page.page.has_more ? (page.page.next_cursor ?? null) : null,
      rows: page.items.map((o) => ({
        id: o.id,
        statusKey: `orders.status.${o.status}` as MessageKey,
        createdAt: formatDateTime(o.created_at, c.locale),
        lines: o.lines.map((l) => ({
          title: c.locale === "ar" ? l.title.ar : (l.title.en ?? l.title.ar),
          qty: formatInt(l.qty, c.locale),
          size: l.size_label ?? null,
        })),
        subtotal: formatMoney(o.subtotal.minor, c.locale),
        net: o.net_to_seller === undefined ? null : formatMoney(o.net_to_seller.minor, c.locale),
        paymentKey: o.payment_type === "cod" ? "orders.payment.cod" : "orders.payment.prepaid",
        governorate: governorateLabel(o.buyer?.governorate_code),
        deadlineIso: acceptDeadline(o),
        actions: availableActions(o.status, c.permissions ?? null),
      })),
    }),
    (v) => v.rows.length === 0,
  );
}

/* ---------------- catalog ---------------- */
export interface CatalogRowVM {
  readonly id: string;
  readonly title: string;
  readonly statusKey: MessageKey;
  readonly claimKey: MessageKey;
  readonly departmentKey: MessageKey;
  readonly price: string;
  readonly stock: string;
}
export interface CatalogVM {
  readonly rows: readonly CatalogRowVM[];
  readonly nextCursor: string | null;
}

export async function loadCatalog(c: Ctx, cursor?: string): Promise<ScreenState<CatalogVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.listProducts(cursor);
  return stateFromResult(
    r,
    (page): CatalogVM => ({
      nextCursor: page.page.has_more ? (page.page.next_cursor ?? null) : null,
      rows: page.items.map((p) => {
        const prices = p.skus.map((s) => s.price.minor).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const lo = prices[0];
        const hi = prices[prices.length - 1];
        const price =
          lo === undefined || hi === undefined ? "" : lo === hi ? formatMoney(lo, c.locale) : `${formatMoney(lo, c.locale)} - ${formatMoney(hi, c.locale)}`;
        return {
          id: p.id,
          title: c.locale === "ar" ? p.title.ar : (p.title.en ?? p.title.ar),
          statusKey: `catalog.status.${p.status}` as MessageKey,
          claimKey: `catalog.claim.${p.price_claim_state ?? "none"}` as MessageKey,
          departmentKey: `editor.department.${p.department ?? "unisex"}` as MessageKey,
          price,
          stock: formatInt(p.skus.reduce((n, s) => n + s.on_hand, 0), c.locale),
        };
      }),
    }),
    (v) => v.rows.length === 0,
  );
}

/* ---------------- returns ---------------- */
export interface ReturnsVM {
  readonly rows: readonly {
    readonly id: string; readonly reasonKey: MessageKey; readonly resolution: string; readonly dueIso: string | null; readonly due: string | null;
    readonly status: string; readonly inspectable: boolean;
  }[];
  readonly nextCursor: string | null;
}

export async function loadReturns(c: Ctx, cursor?: string): Promise<ScreenState<ReturnsVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.listReturns(cursor);
  return stateFromResult(
    r,
    (page): ReturnsVM => ({
      nextCursor: page.page.has_more ? (page.page.next_cursor ?? null) : null,
      rows: page.items.map((x) => ({
        id: x.id,
        reasonKey: `returns.reason.${x.reason}` as MessageKey,
        resolution: x.resolution,
        dueIso: x.inspection_due_at ?? null,
        due: x.inspection_due_at === null || x.inspection_due_at === undefined ? null : formatDateTime(x.inspection_due_at, c.locale),
        status: x.status,
        inspectable: x.status === "RETURN_RECEIVED",
      })),
    }),
    (v) => v.rows.length === 0,
  );
}

/* ---------------- finance ---------------- */
export interface FinanceVM {
  /** Null while the store-scoped balance route is blocked (404) or unavailable: payouts and invoices still render. */
  readonly balance: {
    readonly available: string; readonly pending: string; readonly held: string; readonly inTransit: string | null; readonly negativeCarry: string | null; readonly asOf: string;
  } | null;
  readonly payouts: readonly { readonly id: string; readonly period: string; readonly amount: string; readonly statusKey: MessageKey }[];
  readonly invoices: readonly { readonly id: string; readonly amount: string; readonly vat: string; readonly statusKey: MessageKey; readonly etaUuid: string | null; readonly createdAt: string }[];
}

export async function loadFinance(c: Ctx): Promise<ScreenState<FinanceVM>> {
  if (c.api === null) return notConfigured;
  // The unscoped /v1/seller/balance is deprecated (ADR-0050): the store-scoped route needs the caller's store id.
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const [bal, payouts, invoices] = await Promise.all([c.api.balance(store.value.data.id), c.api.payouts(), c.api.invoices()]);
  // A blocked flag answers 404 and a down ledger 503: show payouts and invoices without the balance tiles.
  // Auth, rate-limit and offline failures still replace the whole screen.
  const balanceMissing = !bal.ok && (bal.error.kind === "not_found" || (bal.error.kind === "server" && bal.error.status === 503));
  if (!bal.ok && !balanceMissing) return stateFromError(bal.error);
  if (!payouts.ok) return stateFromError(payouts.error);
  if (!invoices.ok) return stateFromError(invoices.error);
  const b = bal.ok ? bal.value.data : null;
  const period = (a: string, z: string): string => `${formatDateTime(a, c.locale)} - ${formatDateTime(z, c.locale)}`;
  const vm: FinanceVM = {
    balance: b === null ? null : {
      available: formatMoney(b.available.minor, c.locale),
      pending: formatMoney(b.pending_release.minor, c.locale),
      held: formatMoney(b.held.minor, c.locale),
      inTransit: b.in_transit === undefined ? null : formatMoney(b.in_transit.minor, c.locale),
      negativeCarry: b.negative_carry === undefined || b.negative_carry.minor === 0n ? null : formatMoney(b.negative_carry.minor, c.locale),
      asOf: formatDateTime(b.as_of, c.locale),
    },
    payouts: payouts.value.data.items.map((p) => ({
      id: p.id, period: period(p.period_start, p.period_end), amount: formatMoney(p.amount.minor, c.locale),
      statusKey: `finance.payout.${p.status}` as MessageKey,
    })),
    invoices: invoices.value.data.items.map((i) => ({
      id: i.id, amount: formatMoney(i.amount.minor, c.locale), vat: formatMoney(i.vat.minor, c.locale),
      statusKey: `finance.invoice.${i.status}` as MessageKey, etaUuid: i.eta_uuid ?? null, createdAt: formatDateTime(i.created_at, c.locale),
    })),
  };
  return { kind: "ready", data: vm, serverNowMs: payouts.value.serverNowMs };
}

/* ---------------- marketing ---------------- */
export interface MarketingVM {
  readonly rows: readonly {
    readonly id: string; readonly title: string; readonly code: string | null; readonly statusKey: MessageKey; readonly sellerPct: string;
    readonly platformPct: string; readonly period: string; readonly canPause: boolean; readonly canResume: boolean;
  }[];
}

export async function loadMarketing(c: Ctx): Promise<ScreenState<MarketingVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.promotions();
  return stateFromResult(
    r,
    (page): MarketingVM => ({
      rows: page.items.map((p) => ({
        id: p.id,
        title: c.locale === "ar" ? p.title.ar : (p.title.en ?? p.title.ar),
        code: p.code ?? null,
        statusKey: `marketing.status.${p.status}` as MessageKey,
        sellerPct: formatInt(p.funding.seller_pct, c.locale),
        platformPct: formatInt(p.funding.platform_pct, c.locale),
        period: `${formatDateTime(p.starts_at, c.locale)} - ${formatDateTime(p.ends_at, c.locale)}`,
        canPause: p.status === "active" || p.status === "scheduled",
        canResume: p.status === "paused",
      })),
    }),
    (v) => v.rows.length === 0,
  );
}

/* ---------------- price trust ---------------- */
export interface PriceTrustVM {
  readonly score: string;
  readonly violations: string;
  readonly windowDays: number;
  readonly ladderKey: MessageKey;
  readonly actions: readonly { readonly id: string; readonly action: string; readonly reason: string | null; readonly cure: string | null; readonly appliedAt: string }[];
  readonly claims: readonly { readonly id: string; readonly decisionKey: MessageKey; readonly reasons: readonly string[]; readonly hints: readonly string[]; readonly evaluatedAt: string; readonly appealable: boolean }[];
}

export async function loadPriceTrust(c: Ctx): Promise<ScreenState<PriceTrustVM>> {
  if (c.api === null) return notConfigured;
  const [trust, claims] = await Promise.all([c.api.priceTrust(), c.api.priceClaims()]);
  if (!trust.ok) return stateFromError(trust.error);
  if (!claims.ok) return stateFromError(claims.error);
  const t = trust.value.data;
  const text = (l: { ar: string; en?: string | undefined }): string => (c.locale === "ar" ? l.ar : (l.en ?? l.ar));
  return {
    kind: "ready",
    serverNowMs: trust.value.serverNowMs,
    data: {
      score: formatInt(Math.round(t.score), c.locale),
      violations: formatInt(t.violations_in_window, c.locale),
      windowDays: t.window_days,
      ladderKey: `trust.ladder.${t.ladder_state}` as MessageKey,
      actions: t.active_actions.map((a) => ({
        id: a.id, action: a.action, reason: a.reason_code ?? null, cure: a.cure === undefined ? null : text(a.cure),
        appliedAt: formatDateTime(a.applied_at, c.locale),
      })),
      claims: claims.value.data.items.map((x) => ({
        id: x.id,
        decisionKey: `trust.claim.${x.decision}` as MessageKey,
        reasons: x.reason_codes,
        hints: (x.unlock_hints ?? []).map(text),
        evaluatedAt: formatDateTime(x.evaluated_at, c.locale),
        appealable: x.decision === "withheld" || x.decision === "plain",
      })),
    },
  };
}

/* ---------------- settings ---------------- */
export interface SettingsVM {
  readonly name: string;
  readonly kycKey: MessageKey;
  readonly legal: { readonly name: string; readonly register: string | null; readonly tax: string | null; readonly governorate: string | null };
  readonly threshold: string | null;
  readonly acceptHours: string | null;
  readonly dispatchHours: string | null;
  readonly vacation: boolean;
  readonly health: string | null;
}

export async function loadSettings(c: Ctx): Promise<ScreenState<SettingsVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.store();
  return stateFromResult(r, (s): SettingsVM => ({
    name: c.locale === "ar" ? s.name.ar : (s.name.en ?? s.name.ar),
    kycKey: `settings.kyc.${s.kyc_status}` as MessageKey,
    legal: {
      name: s.legal_identity.legal_name,
      register: s.legal_identity.commercial_register_no ?? null,
      tax: s.legal_identity.tax_id ?? null,
      governorate: s.legal_identity.governorate ?? null,
    },
    threshold: s.free_delivery_threshold === undefined ? null : formatMoney(s.free_delivery_threshold.minor, c.locale),
    acceptHours: s.accept_sla_hours === undefined ? null : formatInt(s.accept_sla_hours, c.locale),
    dispatchHours: s.dispatch_sla_hours === undefined ? null : formatInt(s.dispatch_sla_hours, c.locale),
    vacation: s.status === "vacation",
    health: s.health_score === undefined ? null : formatInt(Math.round(s.health_score), c.locale),
  }));
}
