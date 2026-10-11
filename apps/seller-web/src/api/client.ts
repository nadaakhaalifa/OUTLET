import type { z } from "zod";
import { err, ok, type Result } from "../lib/result";
import type { SessionPort } from "../session/port";
import * as S from "./schemas";
import * as P from "./schemas-phase2";
import { NetworkError, type Transport, type TransportRequest } from "./transport";

export type ApiErrorKind =
  | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "validation" | "conflict"
  | "offline" | "server" | "contract" | "not_configured";

export interface ApiError {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly violations?: readonly { readonly pointer: string; readonly code: string }[];
}

export interface ApiOk<T> {
  readonly data: T;
  /** Server clock from the HTTP Date header, for countdowns (never the device clock). */
  readonly serverNowMs: number | null;
}
export type ApiResult<T> = Result<ApiOk<T>, ApiError>;

export interface ClientDeps {
  readonly transport: Transport;
  readonly session: SessionPort;
  readonly newIdempotencyKey: () => string;
}

export interface AdCampaignInput {
  readonly store_id: string;
  readonly name: string;
  readonly daily_budget: { readonly amount: string; readonly currency: "EGP" };
  readonly max_cpc: { readonly amount: string; readonly currency: "EGP" };
  readonly starts_at: string;
  readonly ends_at?: string | null;
  readonly keywords?: readonly string[];
  readonly bids: readonly { readonly product_id: string; readonly bid: { readonly amount: string; readonly currency: "EGP" } }[];
}
export interface DropInput {
  readonly store_id?: string;
  readonly type: P.DropType;
  readonly title: string;
  readonly starts_at: string;
  readonly early_access_at?: string | null;
  readonly ends_at: string;
  readonly items: readonly { readonly sku_id: string; readonly stock_cap: number; readonly price: string }[];
  readonly limits: { readonly per_user: number; readonly per_device: number };
  readonly ladder?: readonly { readonly at: string; readonly price: string }[];
  readonly mystery?: { readonly min_value: string; readonly max_value: string; readonly guaranteed_min: string } | null;
}

export interface DateRange { readonly from?: string; readonly to?: string }

const kindFor = (status: number): ApiErrorKind => {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation";
  return "server";
};

const parseDate = (h: string | undefined): number | null => {
  if (h === undefined) return null;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : t;
};

export function createSellerApi(deps: ClientDeps) {
  async function exec(req: TransportRequest, write: boolean, key?: string, retried = false): Promise<
    Result<{ status: number; json?: unknown; bytes?: ArrayBuffer; serverNowMs: number | null }, ApiError>
  > {
    const state = await deps.session.current();
    if (state === null) return err({ kind: "unauthorized", status: 401 });
    const headers: Record<string, string> = { ...req.headers, authorization: `Bearer ${state.accessToken}` };
    if (write) headers["idempotency-key"] = key ?? deps.newIdempotencyKey();
    let res;
    try {
      res = await deps.transport.send({ ...req, headers });
    } catch (e) {
      if (e instanceof NetworkError) return err({ kind: "offline" });
      throw e;
    }
    if (res.status === 401 && !retried) {
      const r = await deps.session.refresh();
      if (r.ok) return exec(req, write, headers["idempotency-key"], true);
      return err({ kind: "unauthorized", status: 401 });
    }
    if (res.status >= 200 && res.status < 300) {
      return ok({
        status: res.status,
        ...(res.json === undefined ? {} : { json: res.json }),
        ...(res.bytes === undefined ? {} : { bytes: res.bytes }),
        serverNowMs: parseDate(res.headers.date),
      });
    }
    const p = S.problemSchema.safeParse(res.json);
    const base: ApiError = { kind: kindFor(res.status), status: res.status };
    if (!p.success) return err(base);
    return err({
      ...base,
      ...(p.data.code === undefined ? {} : { code: p.data.code }),
      ...(p.data.request_id === undefined ? {} : { requestId: p.data.request_id }),
      ...(p.data.errors === undefined ? {} : { violations: p.data.errors.map((v) => ({ pointer: v.pointer, code: v.code })) }),
    });
  }

  async function call<T extends z.ZodType>(schema: T, req: TransportRequest, write = false): Promise<ApiResult<z.output<T>>> {
    const r = await exec(req, write);
    if (!r.ok) return r;
    const parsed = schema.safeParse(r.value.json);
    if (!parsed.success) return err({ kind: "contract", status: r.value.status });
    return ok({ data: parsed.data as z.output<T>, serverNowMs: r.value.serverNowMs });
  }

  async function noContent(req: TransportRequest): Promise<ApiResult<null>> {
    const r = await exec(req, true);
    if (!r.ok) return r;
    return ok({ data: null, serverNowMs: r.value.serverNowMs });
  }

  const enc = encodeURIComponent;
  const sid = (id: string): string => enc(id);
  const q = (cursor?: string, limit = 25, extra: Record<string, string | undefined> = {}) => ({ cursor, limit, ...extra });

  const reportSchemas = {
    sales: S.salesReport, funnel: S.funnelReport, traffic: S.trafficReport, geography: S.geographyReport, aging: S.agingReport,
  } as const;

  return {
    store: () => call(S.sellerStore, { method: "GET", path: "/v1/seller/store" }),
    updateStore: (body: { free_delivery_threshold?: { amount: string; currency: "EGP" }; vacation_mode?: boolean }) =>
      call(S.sellerStore, { method: "PATCH", path: "/v1/seller/store", body }, true),

    salesReport: (storeId: string, range: DateRange) =>
      call(reportSchemas.sales, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/sales`, query: { ...range } }),
    funnelReport: (storeId: string, range: DateRange) =>
      call(reportSchemas.funnel, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/funnel`, query: { ...range } }),
    trafficReport: (storeId: string, range: DateRange) =>
      call(reportSchemas.traffic, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/traffic`, query: { ...range } }),
    geographyReport: (storeId: string, range: DateRange) =>
      call(reportSchemas.geography, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/geography`, query: { ...range } }),
    agingReport: (storeId: string, range: DateRange) =>
      call(reportSchemas.aging, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/aging`, query: { ...range } }),

    listProducts: (cursor?: string) => call(S.sellerProductPage, { method: "GET", path: "/v1/seller/products", query: q(cursor) }),
    getProduct: (id: string) => call(S.sellerProduct, { method: "GET", path: `/v1/seller/products/${sid(id)}` }),
    createProduct: (body: S.SellerProductInputWire) => call(S.sellerProduct, { method: "POST", path: "/v1/seller/products", body }, true),
    setProductStatus: (id: string, status: "active" | "paused") =>
      call(S.sellerProduct, { method: "PATCH", path: `/v1/seller/products/${sid(id)}`, body: { status } }, true),

    listSizeCharts: (cursor?: string) => call(S.sizeChartPage, { method: "GET", path: "/v1/seller/size-charts", query: q(cursor) }),
    createSizeChart: (body: { product_type: string; unit: "cm" | "in"; rows: { size_label: string; measurements: Record<string, number> }[] }) =>
      call(S.sizeChart, { method: "POST", path: "/v1/seller/size-charts", body }, true),

    createCatalogImport: (uploadId: string, dryRun: boolean) =>
      call(S.catalogImport, { method: "POST", path: "/v1/seller/catalog/imports", body: { upload_id: uploadId, dry_run: dryRun } }, true),
    getCatalogImport: (id: string) => call(S.catalogImport, { method: "GET", path: `/v1/seller/catalog/imports/${sid(id)}` }),

    listOrders: (cursor?: string, status?: S.SellerOrderStatus) =>
      call(S.sellerOrderPage, { method: "GET", path: "/v1/seller/orders", query: q(cursor, 25, { status }) }),
    getOrder: (id: string) => call(S.sellerOrderView, { method: "GET", path: `/v1/seller/orders/${sid(id)}` }),
    acceptOrder: (id: string) =>
      call(S.sellerOrderView, { method: "POST", path: `/v1/seller/orders/${sid(id)}/accept`, body: {} }, true),
    rejectOrder: (id: string, reason: S.RejectReason, note?: string) =>
      call(S.sellerOrderView, { method: "POST", path: `/v1/seller/orders/${sid(id)}/reject`, body: { reason, ...(note === undefined ? {} : { note }) } }, true),
    packOrder: (id: string) => call(S.sellerOrderView, { method: "POST", path: `/v1/seller/orders/${sid(id)}/pack`, body: {} }, true),
    createShipment: (orderIds: readonly string[]) =>
      call(S.shipment, { method: "POST", path: "/v1/seller/shipments", body: { seller_order_ids: orderIds } }, true),
    shipmentLabel: async (shipmentId: string): Promise<Result<ApiOk<ArrayBuffer>, ApiError>> => {
      const r = await exec({ method: "GET", path: `/v1/seller/shipments/${sid(shipmentId)}/label`, responseType: "binary" }, false);
      if (!r.ok) return r;
      if (r.value.bytes === undefined) return err({ kind: "contract", status: r.value.status });
      return ok({ data: r.value.bytes, serverNowMs: r.value.serverNowMs });
    },

    listReturns: (cursor?: string) => call(S.returnPage, { method: "GET", path: "/v1/seller/returns", query: q(cursor) }),
    inspectReturn: (id: string, body: { result: "approve" } | { result: "reject"; rejection_reason: S.RejectionReason; photo_upload_ids: readonly string[]; note?: string }) =>
      call(S.inspectionDueReturn, { method: "POST", path: `/v1/seller/returns/${sid(id)}/inspect`, body }, true),

    balance: () => call(S.sellerBalance, { method: "GET", path: "/v1/seller/balance" }),
    payouts: (cursor?: string) => call(S.payoutPage, { method: "GET", path: "/v1/seller/payouts", query: q(cursor) }),
    statements: (cursor?: string) => call(S.statementPage, { method: "GET", path: "/v1/seller/statements", query: q(cursor) }),
    invoices: (cursor?: string) => call(S.taxInvoicePage, { method: "GET", path: "/v1/seller/invoices", query: q(cursor) }),

    promotions: (cursor?: string) => call(S.promotionPage, { method: "GET", path: "/v1/seller/promotions", query: q(cursor) }),
    setPromotionStatus: (id: string, status: "paused" | "active") =>
      call(S.promotion, { method: "PATCH", path: `/v1/seller/promotions/${sid(id)}`, body: { status } }, true),

    team: (cursor?: string) => call(S.teamPage, { method: "GET", path: "/v1/seller/team", query: q(cursor) }),
    inviteMember: (body: { email: string; role: Exclude<S.TeamRole, "owner"> }) =>
      call(S.teamMember, { method: "POST", path: "/v1/seller/team", body }, true),
    removeMember: (id: string) => noContent({ method: "DELETE", path: `/v1/seller/team/${sid(id)}` }),

    priceTrust: () => call(S.priceTrust, { method: "GET", path: "/v1/seller/price-trust" }),
    priceClaims: (cursor?: string) => call(S.priceClaimPage, { method: "GET", path: "/v1/seller/price-claims", query: q(cursor) }),
    appealClaim: (id: string, evidenceUploadIds: readonly string[], note?: string) =>
      noContent({
        method: "POST",
        path: `/v1/seller/price-claims/${sid(id)}/appeal`,
        body: { evidence_upload_ids: evidenceUploadIds, ...(note === undefined ? {} : { note }) },
      }),

    /* ---- Phase 2 ---- */
    adCampaigns: (storeId: string) => call(P.adCampaignList, { method: "GET", path: "/v1/seller/ads/campaigns", query: { store_id: storeId, limit: 50 } }),
    createAdCampaign: (body: AdCampaignInput) => call(P.adCampaign, { method: "POST", path: "/v1/seller/ads/campaigns", body }, true),
    pauseAdCampaign: (id: string) => call(P.adCampaign, { method: "POST", path: `/v1/seller/ads/campaigns/${sid(id)}/pause`, body: {} }, true),
    resumeAdCampaign: (id: string) => call(P.adCampaign, { method: "POST", path: `/v1/seller/ads/campaigns/${sid(id)}/resume`, body: {} }, true),
    adBalance: (storeId: string) => call(P.adBalance, { method: "GET", path: "/v1/seller/ads/balance", query: { store_id: storeId } }),
    adReport: (storeId: string, range: DateRange) =>
      call(P.adReport, { method: "GET", path: "/v1/seller/ads/reports", query: { store_id: storeId, ...range } }),
    topUpAds: (storeId: string, amountMinor: string) =>
      call(P.adTopUp, { method: "POST", path: "/v1/seller/ads/topup", body: { store_id: storeId, amount: { amount: amountMinor, currency: "EGP" } } }, true),

    listDrops: (cursor?: string) => call(P.sellerDropPage, { method: "GET", path: "/v1/seller/drops", query: q(cursor) }),
    createDrop: (body: DropInput) => call(P.sellerDrop, { method: "POST", path: "/v1/seller/drops", body }, true),
    scheduleDrop: (id: string) => call(P.sellerDrop, { method: "POST", path: `/v1/seller/drops/${sid(id)}/schedule`, body: {} }, true),
    increaseDropStock: (id: string, version: number, items: readonly { sku_id: string; stock_cap: number; price: string }[]) =>
      call(P.sellerDrop, { method: "PATCH", path: `/v1/seller/drops/${sid(id)}`, body: { items, version } }, true),

    resaleListings: (storeId: string) => call(P.resaleListingList, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/resale/listings` }),
    withdrawResale: (storeId: string, id: string) =>
      call(P.resaleWithdrawn, { method: "POST", path: `/v1/seller/stores/${sid(storeId)}/resale/listings/${sid(id)}/withdraw`, body: {} }, true),

    sizeCurve: (storeId: string, range: DateRange) =>
      call(P.sizeCurveReport, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/analytics/size-curve`, query: { ...range } }),

    channels: (cursor?: string) => call(P.channelConnectionPage, { method: "GET", path: "/v1/seller/channels", query: q(cursor) }),
    connectChannel: (body: { type: P.ChannelType; shop_domain: string; return_url?: string }) =>
      call(P.channelConnection, { method: "POST", path: "/v1/seller/channels", body }, true),
    crawlTargets: (storeId: string) => call(P.crawlTargetList, { method: "GET", path: `/v1/seller/stores/${sid(storeId)}/crawl-targets` }),

    hubTracking: (orderGroupId: string) => call(P.hubTracking, { method: "GET", path: `/v1/me/orders/${sid(orderGroupId)}/tracking` }),
  };
}

export type SellerApi = ReturnType<typeof createSellerApi>;
