/**
 * Generated-client adapter for BrandPort. Only operations that exist in operations.ts are called; everything
 * else rejects with `unsupported` (never fake data) and is listed in docs/plan/api-client-gap.md.
 */
import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, money, ms, msOrNull, pick, toMoney, type AdapterContext } from "../../services/wire";
import {
  BrandPortError, lowStock, nameMatchFromScore, parseEgp, validateIban,
  type BrandAccount, type BrandOrder, type BrandPort, type BrandProduct, type BrandRole, type Category, type DashboardData, type InspectResult,
  type InviteRole, type NotificationEvent, type OrderStatus, type PayoutAccountResult, type PhotoItem, type ProductDraft, type ProductStatus,
  type RejectReason, type ReturnInspection, type SizeChartOption, type StoreSettings, type TeamMember,
} from "./model";
import type { DashboardSummary, PeriodTotals, SummaryPeriod } from "./summaryModel";
import type { z } from "zod";
import { imageEntries } from "./cutout-link";
import { BankWire, BulkUploadWire, InviteWire, TeamWire, NOTIFICATION_WIRE, PrefsWire, ProfileWire, ShippingWire, UploadWire, type ProfileWire as ProfileShape, type ShippingWire as ShippingShape } from "./wire-shapes";

const unsupported = (): never => { throw new BrandPortError("unsupported"); };

function mapError(e: unknown): never {
  if (e instanceof ApiError) {
    if (e.status === 401) throw new BrandPortError("session_expired");
    // A recent strong factor is required (403 from the guard or 422 from the settings service): same re-auth path.
    if (e.code === "strong_factor_required") throw new BrandPortError("session_expired");
    if (e.status === 403 || e.status === 404) throw new BrandPortError("forbidden");
    // 412 = stale If-Match (someone else saved first), 409 = state conflict; both ask the user to reload.
    if (e.status === 409 || e.status === 412) throw new BrandPortError("conflict");
    // 428 = the precondition header was missing: the app cannot satisfy it, so it is unsupported here.
    if (e.status === 428) throw new BrandPortError("unsupported");
  }
  throw e;
}
async function call<T>(f: () => Promise<T>): Promise<T> {
  try { return await guard(f); } catch (e) { return mapError(e instanceof Error && e.cause !== undefined ? e.cause : e); }
}

const cairoDate = (nowMs: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(nowMs));

function mapOrder(o: schemas.SellerOrderView, lang: "ar" | "en"): BrandOrder {
  return {
    id: o.id,
    status: o.status as OrderStatus,
    lines: o.lines.map((l) => ({ id: l.id, title: pick(l.title, lang), sizeLabel: l.size_label ?? null, qty: l.qty, unitPrice: money(l.unit_price) })),
    subtotal: money(o.subtotal),
    netToSeller: o.net_to_seller === undefined ? null : money(o.net_to_seller),
    buyer: { firstName: o.buyer?.first_name ?? null, governorate: o.buyer?.governorate_code ?? "", phoneRelay: o.buyer?.phone_relay ?? null },
    payment: o.payment_type,
    acceptByMs: ms(o.accept_by),
    createdAtMs: ms(o.created_at),
    awbUrl: null,
  };
}

/** Injected for tests: reading a picked file, the signed PUT, and the confirm back-off. */
export interface BrandApiDeps {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const bigMoney = (m: { readonly amount_minor: string }): bigint => BigInt(m.amount_minor);
function mapPeriod(p: schemas.SellerDashboardSummary["current"], titles: ReadonlyMap<string, { readonly ar: string; readonly en: string }>): PeriodTotals {
  return {
    grossSales: bigMoney(p.gross_sales), netAfterCommission: bigMoney(p.net_after_commission), orders: p.orders, units: p.units,
    averageOrderValue: p.average_order_value === null ? null : bigMoney(p.average_order_value),
    returnRateBp: p.return_rate_bps, repeatRateBp: p.repeat_customer_rate_bps,
    funnel: { views: p.funnel.views, bagAdds: p.funnel.bag_adds, checkouts: p.funnel.checkouts, purchases: p.funnel.purchases },
    topProducts: p.top_products.map((t) => ({ productId: t.product_id, title: titles.get(t.product_id) ?? null, units: t.units, grossSales: bigMoney(t.gross_sales) })),
  };
}
/** Wire summary (already strict-parsed by the generated client) to the view-model shape. Money stays bigint piastres. */
export function mapSummary(s: schemas.SellerDashboardSummary, titles: ReadonlyMap<string, { readonly ar: string; readonly en: string }> = new Map()): DashboardSummary {
  return {
    period: s.period,
    current: mapPeriod(s.current, titles),
    previous: mapPeriod(s.previous, titles),
    growth: {
      grossSales: s.growth.gross_sales.growth_bps, netAfterCommission: s.growth.net_after_commission.growth_bps,
      orders: s.growth.orders.growth_bps, units: s.growth.units.growth_bps,
      averageOrderValue: s.growth.average_order_value === null ? null : s.growth.average_order_value.growth_bps,
    },
    dailySales: s.daily_sales.map((d) => ({ day: d.day, grossSales: bigMoney(d.gross_sales) })),
    unavailable: s.unavailable_metrics,
    definitions: s.definitions,
    asOfMs: msOrNull(s.data_as_of),
    withinSlo: s.freshness.within_slo,
    kMin: s.k_anonymity_min,
  };
}

const piastresText = (p: bigint): string => `${p / 100n}.${(p % 100n).toString().padStart(2, "0")}`;
const photoOf = (id: string): PhotoItem => ({ localId: id, uri: "", uploadId: id, progress: 1, state: "done" });
const jobPhotoOf = (id: string): PhotoItem => ({ localId: id, uri: "", uploadId: null, mediaJobId: id, progress: 1, state: "done" });

function toDraft(p: schemas.SellerProduct): ProductDraft {
  const first = p.skus[0];
  return {
    id: p.id,
    // Job-backed images appear in image_upload_ids as the job id; they come back as media_job_id entries.
    photos: (p.image_upload_ids ?? []).map((id) => ((p.image_media_job_ids ?? []).includes(id) ? jobPhotoOf(id) : photoOf(id))),
    defectPhotos: (p.defect_photo_upload_ids ?? []).map(photoOf),
    titleAr: p.title.ar, titleEn: p.title.en ?? "",
    descAr: p.description?.ar ?? "", descEn: p.description?.en ?? "",
    categoryId: p.category_id, condition: p.condition, department: p.department,
    priceInput: first === undefined ? "" : piastresText(money(first.price)),
    sizes: p.skus.map((s) => ({ label: s.size_label, stock: String(s.on_hand) })),
    sizeChartId: p.size_chart_id ?? null,
    sku: first?.seller_sku ?? "", barcode: first?.barcode_gtin ?? "",
  };
}

/** Job-backed photos go as ordered `images`; otherwise the unchanged image_upload_ids. */
function imageFields(photos: readonly PhotoItem[], photoIds: readonly string[]): { images?: schemas.SellerProductInput["images"]; image_upload_ids?: string[] } {
  const entries = imageEntries(photos);
  if (entries !== null) return entries.length > 0 ? { images: [...entries] } : {};
  return photoIds.length > 0 ? { image_upload_ids: [...photoIds] } : {};
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class ApiBrandPort implements BrandPort {
  private acct: BrandAccount | null = null;
  /** ETag of the last read of each product (PATCH needs it as If-Match). */
  private readonly etags = new Map<string, string>();
  /** Team rows that are pending invites (revoked through the invite route, not the member route). */
  private readonly inviteIds = new Set<string>();
  constructor(private readonly ctx: AdapterContext, private readonly deps: BrandApiDeps = {}) {}

  account(): Promise<BrandAccount> {
    return call(async () => {
      if (this.acct !== null) return this.acct;
      const me = dataOf(await this.ctx.client.sellerMe());
      const m = me.memberships[0];
      if (m === undefined) throw new BrandPortError("forbidden");
      const store = dataOf(await this.ctx.client.getSellerStore());
      this.acct = { storeId: m.store_id, role: m.role as BrandRole, kind: store.kind, name: { ar: store.name.ar, en: store.name.en ?? store.name.ar } };
      return this.acct;
    });
  }

  dashboard(): Promise<DashboardData> {
    return call(async () => {
      const acct = await this.account();
      const today = cairoDate(this.ctx.nowMs());
      const [summary, balance, trust, orders, products] = await Promise.all([
        this.ctx.client.getSellerAnalyticsSummary({ query: { from: today, to: today } }).then(dataOf),
        this.ctx.client.getSellerBalance().then(dataOf),
        this.ctx.client.getSellerPriceTrust().then(dataOf),
        this.ctx.client.listSellerOrders({ query: { limit: 50 } }).then(dataOf),
        this.ctx.client.listSellerProducts({ query: { limit: 50 } }).then(dataOf),
      ]);
      const lang = this.ctx.locale();
      const skus = products.items.flatMap((p) => p.skus.map((s) => ({ skuId: s.id, productTitle: pick(p.title, lang), sizeLabel: s.size_label, available: s.available ?? s.on_hand })));
      void acct;
      return {
        serverNowMs: ms(summary.freshness_at) > this.ctx.nowMs() ? ms(summary.freshness_at) : this.ctx.nowMs(),
        freshnessAtMs: ms(summary.freshness_at),
        salesToday: money(summary.gmv),
        ordersToday: summary.orders,
        awaiting: orders.items.filter((o) => o.status === "PAID" || o.status === "CONFIRMED_COD").map((o) => mapOrder(o, lang)),
        lowStock: lowStock(skus),
        payout: { available: money(balance.available), pendingRelease: money(balance.pending_release), held: money(balance.held), heldReasons: [], nextPayoutAtMs: null },
        trust: {
          score: trust.score, ladder: trust.ladder_state, violations: trust.violations_in_window, windowDays: trust.window_days,
          fixes: trust.active_actions.map((a) => ({ action: a.action, cure: a.cure === undefined ? null : { ar: a.cure.ar, en: a.cure.en ?? a.cure.ar } })),
        },
        health: { score: null, dispatchOnTimeBp: null, cancellationBp: null, returnBp: summary.return_rate_bp ?? null },
      };
    });
  }

  dashboardSummary(period: SummaryPeriod): Promise<DashboardSummary | null> {
    return call(async () => {
      const acct = await this.account();
      let raw: schemas.SellerDashboardSummary;
      try {
        raw = dataOf(await this.ctx.client.getSellerStoreDashboardSummary({ path: { storeId: acct.storeId }, query: { period } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null; // release.seller_analytics.dashboard_summary is blocked: the screen shows the simple dashboard
        throw e;
      }
      // Titles for the top products; a failed lookup only loses the names, never the numbers.
      const titles = new Map<string, { ar: string; en: string }>();
      try {
        for (const p of dataOf(await this.ctx.client.listSellerProducts({ query: { limit: 50 } })).items) titles.set(p.id, { ar: p.title.ar, en: p.title.en ?? p.title.ar });
      } catch { /* names are optional */ }
      return mapSummary(raw, titles);
    });
  }

  categories(): Promise<readonly Category[]> {
    return call(async () => dataOf(await this.ctx.client.listSellerCategories()).items.map((c): Category => (
      { id: c.id, name: { ar: c.name.ar, en: c.name.en ?? c.name.ar }, sized: c.requires_size_chart }
    )));
  }
  async sizeCharts(): Promise<readonly SizeChartOption[]> {
    return call(async () => {
      const r = dataOf(await this.ctx.client.listSellerSizeCharts({ query: { limit: 50 } }));
      return r.items.map((c) => ({ id: c.id, name: `${c.product_type} (${c.unit})`, validated: c.validated }));
    });
  }

  listProducts(): Promise<readonly BrandProduct[]> {
    return call(async () => {
      const r = dataOf(await this.ctx.client.listSellerProducts({ query: { limit: 50 } }));
      return r.items.map((p): BrandProduct => {
        const prices = p.skus.map((s) => money(s.price));
        return {
          id: p.id, status: p.status, titleAr: p.title.ar, titleEn: p.title.en ?? null, coverUri: null,
          priceFrom: prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a)),
          totalStock: p.skus.reduce((n, s) => n + (s.available ?? s.on_hand), 0), sizes: p.skus.length,
          claim: p.price_claim_state ?? "none", updatedAtMs: ms(p.updated_at),
        };
      });
    });
  }
  getProduct(id: string): Promise<ProductDraft> {
    return call(async () => {
      const r = await this.ctx.client.getSellerProduct({ path: { productId: id } });
      const p = dataOf(r);
      if (r.etag !== null) this.etags.set(p.id, r.etag);
      return toDraft(p);
    });
  }

  private doFetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.deps.fetch ?? fetch)(input, init);
  }
  private sleep(n: number): Promise<void> {
    return (this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(n);
  }

  /** Reads the picked file and returns its bytes with a content type the server accepts. */
  private async readFile(uri: string): Promise<{ blob: Blob; contentType: string }> {
    const blob = await (await this.doFetch(uri)).blob();
    const t = blob.type === "image/png" || blob.type === "image/webp" ? blob.type : "image/jpeg";
    return { blob, contentType: t };
  }

  /** PUT the bytes to the signed URL, then confirm (scan may still be pending: a few short retries). */
  private async putAndConfirm(storeId: string, u: z.infer<typeof UploadWire>, blob: Blob): Promise<void> {
    const put = await this.doFetch(u.upload_url, { method: "PUT", headers: u.headers, body: blob });
    if (!put.ok) throw new Error(`signed upload failed: ${put.status}`);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ctx.client.confirmSellerMediaUpload({ path: { storeId, uploadId: u.upload_id } });
        return;
      } catch (e) {
        const pending = e instanceof ApiError && e.status === 409 && e.code === "scan_pending";
        if (!pending || attempt >= 4) throw e;
        await this.sleep(500 * (attempt + 1));
      }
    }
  }

  uploadPhotos(uris: readonly string[], onProgress: (index: number, progress: number) => void): Promise<readonly { uploadId: string }[]> {
    return call(async () => {
      if (uris.length === 0) return [];
      const acct = await this.account();
      const files = await Promise.all(uris.map((u) => this.readFile(u)));
      const issued = BulkUploadWire.parse(dataOf(await this.ctx.client.createSellerProductImageUploads({
        path: { storeId: acct.storeId },
        body: { items: files.map((f) => ({ content_type: f.contentType, byte_size: f.blob.size })) },
      })));
      if (issued.items.length !== files.length) throw new Error("upload count mismatch");
      const out: { uploadId: string }[] = [];
      for (const [i, u] of issued.items.entries()) {
        const f = files[i];
        if (f === undefined) throw new Error("upload count mismatch");
        onProgress(i, 0.1);
        await this.putAndConfirm(acct.storeId, u, f.blob);
        onProgress(i, 1);
        out.push({ uploadId: u.upload_id });
      }
      return out;
    });
  }

  saveProduct(draft: ProductDraft, publish: boolean): Promise<{ id: string; status: ProductStatus }> {
    return call(async () => (draft.id === null ? this.createProduct(draft, publish) : this.updateProduct(draft.id, draft, publish)));
  }

  private async createProduct(d: ProductDraft, publish: boolean): Promise<{ id: string; status: ProductStatus }> {
    const price = parseEgp(d.priceInput);
    const rows = d.sizes.filter((r) => r.label.trim() !== "");
    const photoIds = d.photos.flatMap((p) => (p.uploadId === null ? [] : [p.uploadId]));
    const defectIds = d.defectPhotos.flatMap((p) => (p.uploadId === null ? [] : [p.uploadId]));
    // The server cannot hold an incomplete product: autosave of a partial draft is a (silent) failed save.
    if (d.titleAr.trim() === "" || d.categoryId === null || d.condition === null || !price.ok || rows.length === 0) throw new BrandPortError("failed");
    const body: schemas.SellerProductInput = {
      title: { ar: d.titleAr.trim(), ...(d.titleEn.trim() !== "" ? { en: d.titleEn.trim() } : {}) },
      ...(d.descAr.trim() !== "" ? { description: { ar: d.descAr.trim(), ...(d.descEn.trim() !== "" ? { en: d.descEn.trim() } : {}) } } : {}),
      category_id: d.categoryId,
      condition: d.condition,
      department: d.department,
      ...imageFields(d.photos, photoIds),
      ...(defectIds.length > 0 ? { defect_photo_upload_ids: defectIds } : {}),
      ...(d.sizeChartId !== null ? { size_chart_id: d.sizeChartId } : {}),
      skus: rows.map((r) => ({
        size_label: r.label.trim(),
        price: toMoney(price.piastres),
        initial_stock: r.stock.trim() === "" ? 0 : Number(r.stock),
        ...(d.sku.trim() !== "" ? { seller_sku: rows.length === 1 ? d.sku.trim() : `${d.sku.trim()}-${r.label.trim()}` } : {}),
        ...(d.barcode.trim() !== "" && rows.length === 1 ? { barcode_gtin: d.barcode.trim() } : {}),
      })),
    };
    const r = await this.ctx.client.createSellerProduct({ body });
    const p = dataOf(r);
    if (r.etag !== null) this.etags.set(p.id, r.etag);
    if (!publish) return { id: p.id, status: p.status };
    return this.patch(p.id, { status: "active" });
  }

  private async patch(id: string, body: schemas.SellerProductUpdate): Promise<{ id: string; status: ProductStatus }> {
    let etag = this.etags.get(id);
    if (etag === undefined) {
      const g = await this.ctx.client.getSellerProduct({ path: { productId: id } });
      dataOf(g);
      if (g.etag === null) throw new BrandPortError("unsupported");
      etag = g.etag;
    }
    const r = await this.ctx.client.updateSellerProduct({ path: { productId: id }, headers: { "If-Match": etag }, body });
    const p = dataOf(r);
    if (r.etag !== null) this.etags.set(id, r.etag);
    else this.etags.delete(id);
    return { id: p.id, status: p.status };
  }

  private async updateProduct(id: string, d: ProductDraft, publish: boolean): Promise<{ id: string; status: ProductStatus }> {
    const g = await this.ctx.client.getSellerProduct({ path: { productId: id } });
    const server = dataOf(g);
    if (g.etag !== null) this.etags.set(id, g.etag);
    const rows = d.sizes.filter((r) => r.label.trim() !== "");
    const byLabel = new Map(server.skus.map((s) => [s.size_label.toUpperCase(), s]));
    // Adding a size to a live product has no backend operation: refuse instead of dropping it silently.
    if (rows.some((r) => !byLabel.has(r.label.trim().toUpperCase()))) throw new BrandPortError("unsupported");
    const price = d.priceInput.trim() === "" ? null : parseEgp(d.priceInput);
    let touchedSkus = false;
    for (const r of rows) {
      const sku = byLabel.get(r.label.trim().toUpperCase());
      if (sku === undefined) continue;
      if (price !== null && price.ok && price.piastres !== money(sku.price)) {
        await this.ctx.client.updateSellerSkuPrice({ path: { skuId: sku.id }, body: { price: toMoney(price.piastres) } });
        touchedSkus = true;
      }
      if (r.stock.trim() !== "" && Number(r.stock) !== sku.on_hand) {
        await this.ctx.client.updateSellerSkuStock({ path: { skuId: sku.id }, body: { mode: "set", quantity: Number(r.stock), reason: "recount" } });
        touchedSkus = true;
      }
    }
    if (touchedSkus) this.etags.delete(id); // a SKU write may change the product representation
    const photoIds = d.photos.flatMap((p) => (p.uploadId === null ? [] : [p.uploadId]));
    const body: schemas.SellerProductUpdate = {
      ...(d.titleAr.trim() !== "" ? { title: { ar: d.titleAr.trim(), ...(d.titleEn.trim() !== "" ? { en: d.titleEn.trim() } : {}) } } : {}),
      ...(d.descAr.trim() !== "" ? { description: { ar: d.descAr.trim(), ...(d.descEn.trim() !== "" ? { en: d.descEn.trim() } : {}) } } : {}),
      ...(d.condition !== null ? { condition: d.condition } : {}),
      department: d.department,
      ...(d.sizeChartId !== null ? { size_chart_id: d.sizeChartId } : {}),
      ...imageFields(d.photos, photoIds),
      ...(publish ? { status: "active" as const } : {}),
    };
    return this.patch(id, body);
  }

  listOrders(): Promise<readonly BrandOrder[]> {
    return call(async () => dataOf(await this.ctx.client.listSellerOrders({ query: { limit: 50 } })).items.map((o) => mapOrder(o, this.ctx.locale())));
  }
  private act(f: () => Promise<{ data: schemas.SellerOrderView }>): Promise<BrandOrder> {
    return call(async () => mapOrder((await f()).data, this.ctx.locale()));
  }
  acceptOrder(id: string): Promise<BrandOrder> { return this.act(async () => ({ data: dataOf(await this.ctx.client.acceptSellerOrder({ path: { sellerOrderId: id } })) })); }
  rejectOrder(id: string, reason: RejectReason, note: string): Promise<BrandOrder> {
    return this.act(async () => ({ data: dataOf(await this.ctx.client.rejectSellerOrder({ path: { sellerOrderId: id }, body: { reason, ...(note.trim() !== "" ? { note } : {}) } })) }));
  }
  packOrder(id: string): Promise<BrandOrder> { return this.act(async () => ({ data: dataOf(await this.ctx.client.packSellerOrder({ path: { sellerOrderId: id } })) })); }
  async markReady(): Promise<BrandOrder> { return unsupported(); }
  async listReturns(): Promise<readonly ReturnInspection[]> {
    return call(async () => dataOf(await this.ctx.client.listSellerReturns({ query: { limit: 50 } })).items
      .filter((r) => r.status === "RETURN_RECEIVED")
      .map((r) => ({ id: r.id, orderId: r.seller_order_id, reason: r.reason, receivedAtMs: null })));
  }
  inspectReturn(id: string, result: InspectResult, note: string): Promise<void> {
    return call(async () => {
      const n = note.trim();
      await this.ctx.client.inspectSellerReturn({
        path: { returnId: id },
        body: {
          result: result === "accept" ? "approve" : "reject",
          ...(result === "reject" ? { rejection_reason: "other" as const } : {}),
          ...(n !== "" ? { note: n.slice(0, 500) } : {}),
        },
      });
    });
  }

  /** AWB label as a data URI: the shipment is created for the order (idempotent key), then the PDF is read. */
  labelUri(orderId: string): Promise<string> {
    return call(async () => {
      const ship = dataOf(await this.ctx.client.createSellerShipment({ body: { seller_order_ids: [orderId] } }));
      const pdf = dataOf(await this.ctx.client.getSellerShipmentLabel({ path: { shipmentId: ship.id } }));
      return `data:application/pdf;base64,${base64(pdf)}`;
    });
  }

  private async readStore(): Promise<{ settings: StoreSettings; profile: ProfileShape; shipping: ShippingShape }> {
    const acct = await this.account();
    const path = { storeId: acct.storeId };
    const [base, profileRaw, shippingRaw, bankRaw, prefsRaw] = await Promise.all([
      this.ctx.client.getSellerStore().then(dataOf),
      this.ctx.client.getSellerStoreProfile({ path }).then(dataOf),
      this.ctx.client.getSellerShippingProfile({ path }).then(dataOf),
      this.ctx.client.getSellerPayoutAccount({ path }).then(dataOf),
      this.ctx.client.getSellerNotificationPreferences({ path }).then(dataOf),
    ]);
    const profile = ProfileWire.parse(profileRaw);
    const shipping = ShippingWire.parse(shippingRaw);
    const bank = BankWire.parse(bankRaw);
    const prefs = PrefsWire.parse(prefsRaw).preferences;
    const push = (e: NotificationEvent): boolean => prefs[NOTIFICATION_WIRE[e]]?.["push"] ?? true;
    const settings: StoreSettings = {
      name: { ar: profile.name_ar, en: profile.name_en ?? "" },
      description: { ar: profile.description_ar ?? "", en: profile.description_en ?? "" },
      logoUri: base.logo_url ?? null, coverUri: base.cover_url ?? null,
      social: { instagram: profile.social_links["instagram"] ?? "", website: profile.social_links["website"] ?? "" },
      returnDays: { changeOfMind: profile.return_policy.change_of_mind_days, defect: profile.return_policy.defect_days },
      shipping: shipping.configured
        ? { governorate: shipping.origin.governorate_code, city: shipping.origin.city_code, street: shipping.origin.street, handlingHours: shipping.handling_time_hours }
        : { governorate: "", city: "", street: "", handlingHours: shipping.handling_time_hours },
      vacationEndMs: profile.vacation.enabled ? msOrNull(profile.vacation.until) : null,
      payout: bank.configured
        ? { last4: bank.iban_last4, holder: null, nameMatch: nameMatchFromScore(bank.name_match_score), activatesAtMs: msOrNull(bank.activates_at) }
        : { last4: null, holder: null, nameMatch: null, activatesAtMs: null },
      notifications: { new_order: true, sla_warning: true, low_stock: push("low_stock"), payout: push("payout"), price_trust: push("price_trust") },
      version: profile.version,
    };
    return { settings, profile, shipping };
  }

  store(): Promise<StoreSettings> {
    return call(async () => (await this.readStore()).settings);
  }

  saveStore(next: StoreSettings): Promise<StoreSettings> {
    return call(async () => {
      const acct = await this.account();
      const path = { storeId: acct.storeId };
      const cur = await this.readStore();
      const a = cur.settings;
      const social: Record<string, string> = { ...cur.profile.social_links };
      for (const k of ["instagram", "website"] as const) {
        const v = next.social[k].trim();
        if (v === "") delete social[k]; else social[k] = v;
      }
      const profileChanged =
        next.name.ar !== a.name.ar || next.name.en !== a.name.en || next.description.ar !== a.description.ar || next.description.en !== a.description.en ||
        next.social.instagram !== a.social.instagram || next.social.website !== a.social.website ||
        next.returnDays.changeOfMind !== a.returnDays.changeOfMind || next.returnDays.defect !== a.returnDays.defect;
      if (profileChanged) {
        const en = next.name.en.trim();
        await this.ctx.client.putSellerStoreProfile({
          path,
          body: {
            name_ar: next.name.ar.trim(),
            name_en: en === "" ? null : en,
            description_ar: next.description.ar.trim() === "" ? null : next.description.ar.trim(),
            description_en: next.description.en.trim() === "" ? null : next.description.en.trim(),
            social_links: social,
            return_policy: {
              change_of_mind_days: next.returnDays.changeOfMind,
              defect_days: next.returnDays.defect,
              text_ar: cur.profile.return_policy.text_ar ?? null,
              text_en: cur.profile.return_policy.text_en ?? null,
            },
            free_delivery_threshold: cur.profile.free_delivery_threshold,
          },
        });
      }
      if (next.vacationEndMs !== a.vacationEndMs) {
        await this.ctx.client.putSellerStoreVacation({
          path,
          body: {
            enabled: next.vacationEndMs !== null,
            until: next.vacationEndMs === null ? null : new Date(next.vacationEndMs).toISOString(),
            eta_extra_days: cur.profile.vacation.eta_extra_days,
          },
        });
      }
      const s = next.shipping;
      const shippingChanged = s.governorate !== a.shipping.governorate || s.city !== a.shipping.city || s.street !== a.shipping.street || s.handlingHours !== a.shipping.handlingHours;
      if (shippingChanged) {
        // The wire carries the contact phone masked only; PUT needs the full number, which this form does not collect.
        throw new BrandPortError("unsupported");
      }
      const prefChanges: Record<string, Record<string, boolean>> = {};
      for (const e of ["low_stock", "payout", "price_trust"] as const) {
        if (next.notifications[e] !== a.notifications[e]) prefChanges[NOTIFICATION_WIRE[e]] = { push: next.notifications[e] };
      }
      if (Object.keys(prefChanges).length > 0) await this.ctx.client.putSellerNotificationPreferences({ path, body: { preferences: prefChanges } });
      return (await this.readStore()).settings;
    });
  }

  uploadStoreMedia(slot: "logo" | "cover", uri: string): Promise<string> {
    return call(async () => {
      const acct = await this.account();
      const f = await this.readFile(uri);
      const u = UploadWire.parse(dataOf(await this.ctx.client.createSellerMediaUpload({
        path: { storeId: acct.storeId },
        body: { slot, content_type: f.contentType, byte_size: f.blob.size },
      })));
      await this.putAndConfirm(acct.storeId, u, f.blob);
      return u.upload_id;
    });
  }

  savePayoutAccount(iban: string, holder: string): Promise<PayoutAccountResult> {
    return call(async () => {
      const v = validateIban(iban);
      if (!v.ok) throw new BrandPortError("failed");
      const acct = await this.account();
      try {
        const raw = dataOf(await this.ctx.client.putSellerPayoutAccount({
          path: { storeId: acct.storeId },
          body: { iban: v.normalized, account_holder_name: holder.trim() },
        }));
        const b = BankWire.parse(raw);
        if (!b.configured) throw new BrandPortError("failed");
        return { last4: b.iban_last4, nameMatch: nameMatchFromScore(b.name_match_score), activatesAtMs: msOrNull(b.activates_at) };
      } catch (e) {
        // 422 name_mismatch is a result the screen renders, not a failure.
        if (e instanceof ApiError && e.code === "name_mismatch") {
          const score = (e.problem as Record<string, unknown>)["score"];
          return { last4: v.last4, nameMatch: typeof score === "number" ? nameMatchFromScore(score) : "mismatch", activatesAtMs: null };
        }
        throw e;
      }
    });
  }

  /** No seller operation verifies a strong factor from the app (it is done in the seller-auth flow). */
  async verifyStrongFactor(): Promise<void> { return unsupported(); }

  team(): Promise<readonly TeamMember[]> {
    return call(async () => {
      const acct = await this.account();
      const t = TeamWire.parse(dataOf(await this.ctx.client.getSellerTeam({ path: { storeId: acct.storeId } })));
      this.inviteIds.clear();
      const pending = t.invites.filter((i) => i.status.toUpperCase() === "PENDING");
      for (const i of pending) this.inviteIds.add(i.id);
      const role = (r: string): BrandRole => (r === "fulfilment" ? "warehouse" : (r as BrandRole));
      return [
        ...t.members.map((m) => ({ id: m.user_id, name: m.phone_masked ?? "—", role: role(m.role), status: "active" as const })),
        ...pending.map((i) => ({ id: i.id, name: i.phone_masked ?? "—", role: role(i.role), status: "invited" as const })),
      ];
    });
  }

  invite(phoneE164: string, role: InviteRole): Promise<TeamMember> {
    return call(async () => {
      const acct = await this.account();
      const i = InviteWire.parse(dataOf(await this.ctx.client.createSellerTeamInvite({ path: { storeId: acct.storeId }, body: { phone: phoneE164, role } })));
      this.inviteIds.add(i.id);
      return { id: i.id, name: i.phone_masked ?? "—", role, status: "invited" };
    });
  }

  revoke(id: string): Promise<void> {
    return call(async () => {
      const acct = await this.account();
      if (this.inviteIds.has(id)) {
        await this.ctx.client.revokeSellerTeamInvite({ path: { storeId: acct.storeId, inviteId: id } });
        this.inviteIds.delete(id);
        return;
      }
      await this.ctx.client.deleteSellerStoreTeamMember({ path: { storeId: acct.storeId, userId: id } });
    });
  }
}
