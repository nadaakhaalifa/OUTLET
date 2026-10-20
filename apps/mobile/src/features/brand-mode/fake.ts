/** In-memory BrandPort (dev default and tests). Fixture data, clearly not real: the screens show the dev banner. */
import {
  BrandPortError, EMPTY_DRAFT, STRONG_FACTOR_WINDOW_MS, nameMatchFromScore, normalizeIban, payoutHoldUntil, validateIban,
  type BrandAccount, type BrandOrder, type BrandPort, type BrandProduct, type Category, type DashboardData, type InspectResult,
  type InviteRole, type PayoutAccountResult, type ProductDraft, type ProductStatus, type RejectReason, type ReturnInspection,
  type SizeChartOption, type StoreSettings, type TeamMember,
} from "./model";
import type { DashboardSummary, SummaryPeriod } from "./summaryModel";

const H = 3_600_000;

export const FAKE_ACCOUNT: BrandAccount = {
  storeId: "00000000-0000-4000-8000-000000000001",
  name: { ar: "نايل أتيليه", en: "Nile Atelier" },
  role: "owner",
  kind: "local",
};

const CATEGORIES: readonly Category[] = [
  { id: "c-dress", name: { ar: "فساتين", en: "Dresses" }, sized: true },
  { id: "c-top", name: { ar: "قمصان وبلوزات", en: "Shirts and tops" }, sized: true },
  { id: "c-shoes", name: { ar: "أحذية", en: "Shoes" }, sized: true },
  { id: "c-bag", name: { ar: "حقائب", en: "Bags" }, sized: false },
];

/** Optional replacement data (the dev-only demo brand). Absent: the original small fixture. */
export interface BrandSeed {
  readonly account: BrandAccount;
  readonly orders: readonly BrandOrder[];
  readonly products: readonly BrandProduct[];
  readonly settings: StoreSettings;
  readonly dashboard: (orders: readonly BrandOrder[], now: number) => DashboardData;
  /** Optional period overview (the dev demo brand only). Absent: the summary reads as flagged off (null). */
  readonly summary?: ((period: SummaryPeriod, now: number) => DashboardSummary) | undefined;
}

export class InMemoryBrandPort implements BrandPort {
  private orders: BrandOrder[];
  private products: BrandProduct[];
  private drafts = new Map<string, ProductDraft>();
  private settings: StoreSettings;
  private members: TeamMember[];
  private strongAtMs: number | null = null;
  private seq = 100;

  constructor(private readonly now: () => number = Date.now, private readonly role: BrandAccount["role"] = "owner", private readonly seed?: BrandSeed) {
    const t = this.now();
    const line = (id: string, title: string, size: string, qty: number, price: bigint) => ({ id, title, sizeLabel: size, qty, unitPrice: price });
    this.orders = [
      { id: "o-1001", status: "PAID", lines: [line("l1", "فستان كتان أبيض", "M", 1, 129_000n)], subtotal: 129_000n, netToSeller: 112_000n, buyer: { firstName: "Mona", governorate: "Cairo", phoneRelay: "+20 10 5550 0101" }, payment: "prepaid", acceptByMs: t + 19 * H, createdAtMs: t - 5 * H, awbUrl: null },
      { id: "o-1002", status: "CONFIRMED_COD", lines: [line("l2", "قميص قطن", "L", 2, 45_000n)], subtotal: 90_000n, netToSeller: 78_000n, buyer: { firstName: "Karim", governorate: "Giza", phoneRelay: "+20 11 5550 0102" }, payment: "cod", acceptByMs: t + 2 * H + 20 * 60_000, createdAtMs: t - 21 * H, awbUrl: null },
      { id: "o-1003", status: "ACCEPTED", lines: [line("l3", "حقيبة جلد", "—", 1, 210_000n)], subtotal: 210_000n, netToSeller: 183_000n, buyer: { firstName: "Salma", governorate: "Alexandria", phoneRelay: "+20 12 5550 0103" }, payment: "prepaid", acceptByMs: t - 4 * H, createdAtMs: t - 28 * H, awbUrl: null },
      { id: "o-1004", status: "PACKED", lines: [line("l4", "حذاء جلد", "40", 1, 175_000n)], subtotal: 175_000n, netToSeller: 152_000n, buyer: { firstName: "Omar", governorate: "Cairo", phoneRelay: "+20 10 5550 0104" }, payment: "prepaid", acceptByMs: t - 30 * H, createdAtMs: t - 52 * H, awbUrl: "https://example.invalid/awb/o-1004.pdf" },
      { id: "o-1005", status: "RETURN_RECEIVED", lines: [line("l5", "فستان حرير", "S", 1, 260_000n)], subtotal: 260_000n, netToSeller: null, buyer: { firstName: "Heba", governorate: "Mansoura", phoneRelay: null }, payment: "prepaid", acceptByMs: t - 200 * H, createdAtMs: t - 250 * H, awbUrl: null },
    ];
    this.products = [
      { id: "p-1", status: "active", titleAr: "فستان كتان أبيض", titleEn: "White linen dress", coverUri: null, priceFrom: 129_000n, totalStock: 14, sizes: 4, claim: "verified_discount", updatedAtMs: t - 2 * 86_400_000 },
      { id: "p-2", status: "active", titleAr: "قميص قطن", titleEn: null, coverUri: null, priceFrom: 45_000n, totalStock: 2, sizes: 3, claim: "none", updatedAtMs: t - 86_400_000 },
      { id: "p-3", status: "draft", titleAr: "حقيبة جلد", titleEn: "Leather bag", coverUri: null, priceFrom: null, totalStock: 0, sizes: 1, claim: "none", updatedAtMs: t - 3 * H },
      { id: "p-4", status: "paused", titleAr: "حذاء جلد", titleEn: "Leather shoe", coverUri: null, priceFrom: 175_000n, totalStock: 9, sizes: 5, claim: "launch_price", updatedAtMs: t - 7 * 86_400_000 },
    ];
    this.settings = {
      name: FAKE_ACCOUNT.name,
      description: { ar: "ملابس وإكسسوارات مصرية من فائض الموسم.", en: "Egyptian clothing and accessories from end-of-season stock." },
      logoUri: null, coverUri: null,
      social: { instagram: "", website: "" },
      returnDays: { changeOfMind: 14, defect: 30 },
      shipping: { governorate: "Cairo", city: "Nasr City", street: "12 Abbas El Akkad", handlingHours: 48 },
      vacationEndMs: null,
      payout: { last4: null, holder: null, nameMatch: null, activatesAtMs: null },
      notifications: { new_order: true, sla_warning: true, low_stock: true, payout: true, price_trust: false },
      version: 1,
    };
    this.members = [{ id: "m-1", name: "Member One", role: "owner", status: "active" }];
    if (seed !== undefined) {
      this.orders = [...seed.orders];
      this.products = [...seed.products];
      this.settings = seed.settings;
    }
  }

  private async lag(): Promise<void> { await Promise.resolve(); }
  private guardRole(ok: boolean): void { if (!ok) throw new BrandPortError("forbidden"); }

  async account(): Promise<BrandAccount> { return { ...(this.seed?.account ?? FAKE_ACCOUNT), role: this.role }; }

  async dashboardSummary(period: SummaryPeriod): Promise<DashboardSummary | null> {
    await this.lag();
    return this.seed?.summary?.(period, this.now()) ?? null;
  }

  async dashboard(): Promise<DashboardData> {
    await this.lag();
    const t = this.now();
    if (this.seed !== undefined) return this.seed.dashboard(this.orders, t);
    return {
      serverNowMs: t,
      freshnessAtMs: t - 4 * 60_000,
      salesToday: 258_000n,
      ordersToday: 3,
      awaiting: this.orders.filter((o) => o.status === "PAID" || o.status === "CONFIRMED_COD"),
      lowStock: [{ skuId: "s-1", productTitle: "قميص قطن", sizeLabel: "L", available: 1 }, { skuId: "s-2", productTitle: "فستان كتان أبيض", sizeLabel: "S", available: 2 }],
      payout: { available: 412_500n, pendingRelease: 129_000n, held: 0n, heldReasons: [], nextPayoutAtMs: t + 3 * 86_400_000 },
      trust: { score: 82, ladder: "good_standing", violations: 0, windowDays: 90, fixes: [] },
      health: { score: 91, dispatchOnTimeBp: 9600, cancellationBp: 120, returnBp: 640 },
    };
  }

  async categories(): Promise<readonly Category[]> { return CATEGORIES; }
  async sizeCharts(): Promise<readonly SizeChartOption[]> {
    return [{ id: "sc-1", name: "Women tops and dresses (cm)", validated: true }, { id: "sc-2", name: "Shoes EU", validated: true }];
  }
  async listProducts(): Promise<readonly BrandProduct[]> { await this.lag(); return this.products; }
  async getProduct(id: string): Promise<ProductDraft> {
    const d = this.drafts.get(id);
    if (d !== undefined) return d;
    const p = this.products.find((x) => x.id === id);
    if (p === undefined) throw new BrandPortError("failed");
    return { ...EMPTY_DRAFT, id, titleAr: p.titleAr, titleEn: p.titleEn ?? "", priceInput: p.priceFrom === null ? "" : (Number(p.priceFrom) / 100).toString(), sizes: [{ label: "M", stock: String(p.totalStock) }] };
  }
  async uploadPhotos(uris: readonly string[], onProgress: (i: number, p: number) => void): Promise<readonly { uploadId: string }[]> {
    uris.forEach((_u, i) => { onProgress(i, 1); });
    return uris.map(() => ({ uploadId: `up-${++this.seq}` }));
  }
  async saveProduct(draft: ProductDraft, publish: boolean): Promise<{ id: string; status: ProductStatus }> {
    this.guardRole(this.role === "owner" || this.role === "manager" || this.role === "catalog");
    const id = draft.id ?? `p-${++this.seq}`;
    const status: ProductStatus = publish ? "active" : "draft";
    this.drafts.set(id, { ...draft, id });
    const next: BrandProduct = {
      id, status, titleAr: draft.titleAr || "—", titleEn: draft.titleEn || null, coverUri: draft.photos[0]?.uri ?? null,
      priceFrom: null, totalStock: draft.sizes.reduce((n, r) => n + (Number(r.stock) || 0), 0), sizes: draft.sizes.length, claim: "none", updatedAtMs: this.now(),
    };
    this.products = [next, ...this.products.filter((p) => p.id !== id)];
    return { id, status };
  }

  async listOrders(): Promise<readonly BrandOrder[]> { await this.lag(); return this.orders; }
  private patch(id: string, f: (o: BrandOrder) => BrandOrder): BrandOrder {
    const o = this.orders.find((x) => x.id === id);
    if (o === undefined) throw new BrandPortError("failed");
    const n = f(o);
    this.orders = this.orders.map((x) => (x.id === id ? n : x));
    return n;
  }
  async acceptOrder(id: string): Promise<BrandOrder> { this.guardRole(this.role !== "support"); return this.patch(id, (o) => ({ ...o, status: "ACCEPTED" })); }
  async rejectOrder(id: string, _r: RejectReason, _n: string): Promise<BrandOrder> { return this.patch(id, (o) => ({ ...o, status: "REJECTED_BY_SELLER" })); }
  async packOrder(id: string): Promise<BrandOrder> { return this.patch(id, (o) => ({ ...o, status: "PACKED", awbUrl: `https://example.invalid/awb/${id}.pdf` })); }
  async labelUri(orderId: string): Promise<string> { return `https://example.invalid/awb/${orderId}.pdf`; }
  async markReady(id: string): Promise<BrandOrder> { return this.patch(id, (o) => ({ ...o, status: "SHIPPED" })); }
  async listReturns(): Promise<readonly ReturnInspection[]> {
    return this.orders.filter((o) => o.status === "RETURN_RECEIVED").map((o) => ({ id: `r-${o.id}`, orderId: o.id, reason: "too_small", receivedAtMs: this.now() - 5 * H }));
  }
  async inspectReturn(id: string, result: InspectResult, _note: string): Promise<void> {
    this.patch(id.replace(/^r-/, ""), (o) => ({ ...o, status: result === "accept" ? "REFUNDED" : "RETURN_REJECTED" }));
  }

  async store(): Promise<StoreSettings> { return this.settings; }
  async saveStore(s: StoreSettings): Promise<StoreSettings> {
    this.guardRole(this.role === "owner" || this.role === "manager");
    if (s.version !== this.settings.version) throw new BrandPortError("conflict");
    this.settings = { ...s, version: s.version + 1 };
    return this.settings;
  }
  async uploadStoreMedia(slot: "logo" | "cover", uri: string): Promise<string> {
    this.settings = { ...this.settings, ...(slot === "logo" ? { logoUri: uri } : { coverUri: uri }) };
    return uri;
  }
  async verifyStrongFactor(code: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) throw new BrandPortError("forbidden");
    this.strongAtMs = this.now();
  }
  async savePayoutAccount(iban: string, holder: string): Promise<PayoutAccountResult> {
    this.guardRole(this.role === "owner" || this.role === "finance");
    if (this.strongAtMs === null || this.now() - this.strongAtMs > STRONG_FACTOR_WINDOW_MS) throw new BrandPortError("session_expired");
    const v = validateIban(iban);
    if (!v.ok) throw new BrandPortError("failed");
    const same = holder.trim().toLowerCase().includes("atelier") ? 96 : 40;
    const nameMatch = nameMatchFromScore(same);
    const hadActive = this.settings.payout.last4 !== null;
    const activatesAtMs = payoutHoldUntil(this.now(), hadActive);
    this.settings = { ...this.settings, payout: { last4: normalizeIban(iban).slice(-4), holder: holder.trim(), nameMatch, activatesAtMs } };
    return { last4: v.last4, nameMatch, activatesAtMs };
  }

  async team(): Promise<readonly TeamMember[]> { return this.members; }
  async invite(_phone: string, role: InviteRole): Promise<TeamMember> {
    this.guardRole(this.role === "owner");
    const m: TeamMember = { id: `m-${++this.seq}`, name: _phone.slice(0, 6) + "•••••" + _phone.slice(-2), role, status: "invited" };
    this.members = [...this.members, m];
    return m;
  }
  async revoke(id: string): Promise<void> {
    this.guardRole(this.role === "owner");
    const m = this.members.find((x) => x.id === id);
    if (m?.role === "owner") throw new BrandPortError("forbidden");
    this.members = this.members.filter((x) => x.id !== id);
  }
}
