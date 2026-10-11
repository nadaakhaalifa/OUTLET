import {
  allocateResaleProceeds,
  checkResaleEligibility,
  isGrade,
  moveListing,
  resalePriceDisplay,
  validateListing,
  type ListingIssue,
  type ResaleRefusal,
} from "../domain/bridge";
import type {
  ListingCursor,
  ListingRecord,
  ProceedsRecord,
  ResaleCatalogPort,
  ResaleConsentPort,
  ResaleFlagsPort,
  ResaleLedgerPort,
  ResaleMetrics,
  ResaleStore,
  ResaleTermsPort,
  ReturnFactsPort,
} from "../domain/ports";

export interface ResaleDeps {
  readonly store: ResaleStore;
  readonly returns: ReturnFactsPort;
  readonly consent: ResaleConsentPort;
  readonly terms: ResaleTermsPort;
  readonly catalog: ResaleCatalogPort;
  readonly flags: ResaleFlagsPort;
  readonly ledger: ResaleLedgerPort;
  readonly metrics: ResaleMetrics;
  readonly clock: { nowMs(): number };
  readonly ids: { uuidV7(): string };
}

export type ListUnitResult =
  | { readonly kind: "listed"; readonly listing: ListingRecord }
  | { readonly kind: "disabled" | "not_found" | "already_listed" }
  | { readonly kind: "refused"; readonly reason: ResaleRefusal }
  | { readonly kind: "invalid"; readonly issues: readonly ListingIssue[] };

export class ListReturnedUnit {
  constructor(private readonly d: ResaleDeps) {}
  async execute(i: {
    readonly returnId: string;
    readonly operatorId: string;
    readonly operatorHubIds: readonly string[];
    readonly grade: string;
    readonly photoIds: readonly string[];
    readonly defectNote: string | null;
    readonly price: bigint;
  }): Promise<ListUnitResult> {
    if (!(await this.d.flags.listingEnabled())) return { kind: "disabled" };
    const f = await this.d.returns.facts(i.returnId);
    // A unit inspected at another hub is indistinguishable from a missing one.
    if (f === null || !i.operatorHubIds.includes(f.hubId)) return { kind: "not_found" };
    const issues = validateListing({ grade: i.grade, photoCount: i.photoIds.length, defectNote: i.defectNote, price: i.price });
    if (issues.length > 0 || !isGrade(i.grade)) return { kind: "invalid", issues };
    const prior = await this.d.store.countForUnit(f.unitRef);
    const elig = checkResaleEligibility({
      inspectionPassed: f.inspectionPassed,
      returnClass: f.returnClass,
      priorListingsForUnit: prior,
      ownership: f.ownership,
      sellerOptedIn: f.ownership === "seller" ? await this.d.consent.sellerOptedIn(f.storeId) : false,
      rtvTermsAccepted: f.ownership === "platform_rtv" ? await this.d.consent.rtvTermsAccepted(f.unitRef) : false,
    });
    if (!elig.ok) {
      this.d.metrics.increment("resale_refused", { reason: elig.reason });
      return elig.reason === "already_resold" ? { kind: "already_listed" } : { kind: "refused", reason: elig.reason };
    }
    const id = this.d.ids.uuidV7();
    const resaleSkuId = await this.d.catalog.createResaleSku({ listingId: id, sourceSkuId: f.sourceSkuId, storeId: f.storeId });
    const listing: ListingRecord = {
      id,
      returnId: f.returnId,
      unitRef: f.unitRef,
      storeId: f.storeId,
      sourceSkuId: f.sourceSkuId,
      resaleSkuId,
      grade: i.grade,
      photoIds: i.photoIds,
      defectNote: i.defectNote === null || i.defectNote.trim() === "" ? null : i.defectNote.trim(),
      price: i.price,
      ownership: f.ownership,
      status: "LISTED",
      listedAtMs: this.d.clock.nowMs(),
      soldAtMs: null,
      createdBy: i.operatorId,
    };
    const r = await this.d.store.insertListing(listing, [{ type: "resale.listed", listingId: id, storeId: f.storeId, grade: i.grade }]);
    if (r !== "created") return { kind: "already_listed" };
    this.d.metrics.increment("resale_listed", { grade: i.grade });
    return { kind: "listed", listing };
  }
}

export type SaleResult =
  | { readonly kind: "sold" | "already_sold"; readonly proceeds: ProceedsRecord }
  | { readonly kind: "not_found" | "not_sellable" };

/** Called by the order-paid consumer (no HTTP). The gross is the listing price, never a caller value. */
export class RecordResaleSale {
  constructor(private readonly d: ResaleDeps) {}
  async execute(listingId: string): Promise<SaleResult> {
    const l = await this.d.store.getListing(listingId);
    if (l === null) return { kind: "not_found" };
    if (l.status === "WITHDRAWN") return { kind: "not_sellable" };
    if (l.status === "SOLD") {
      const p = await this.d.store.getProceeds(listingId);
      if (p === null) return { kind: "not_sellable" };
      await this.postLedger(l, p);
      return { kind: "already_sold", proceeds: p };
    }
    moveListing(l.status, "SOLD");
    const terms = await this.d.terms.termsFor(l.storeId, l.ownership);
    const split = allocateResaleProceeds(l.price, terms);
    const proceeds: ProceedsRecord = {
      listingId,
      gross: split.gross,
      sellerPayable: split.sellerPayable,
      platformRetained: split.platformRetained,
      ledgerEntryId: null,
      recordedAtMs: this.d.clock.nowMs(),
    };
    const r = await this.d.store.markSold({
      listingId,
      nowMs: proceeds.recordedAtMs,
      proceeds,
      events: [{ type: "resale.sold", listingId, storeId: l.storeId }],
    });
    if (r === "not_found") return { kind: "not_found" };
    if (r === "not_listed") {
      const p = await this.d.store.getProceeds(listingId);
      return p === null ? { kind: "not_sellable" } : { kind: "already_sold", proceeds: p };
    }
    await this.postLedger(l, proceeds);
    this.d.metrics.increment("resale_sold");
    return { kind: "sold", proceeds };
  }

  private async postLedger(l: ListingRecord, p: ProceedsRecord): Promise<void> {
    const platformAccount = l.ownership === "seller" ? "platform_commission" : "resale_margin_revenue";
    await this.d.ledger.post({
      idempotencyKey: `resale-sale:${l.id}`,
      lines: [
        { account: "resale_clearing", amount: p.gross },
        { account: `seller_payable:${l.storeId}`, amount: -p.sellerPayable },
        { account: platformAccount, amount: -p.platformRetained },
      ].filter((x) => x.amount !== 0n),
    });
  }
}

export type WithdrawResult = { readonly kind: "withdrawn" | "not_found" | "not_listed" };

export class WithdrawListing {
  constructor(private readonly d: ResaleDeps) {}
  async execute(storeId: string, listingId: string): Promise<WithdrawResult> {
    const l = await this.d.store.getListing(listingId);
    if (l === null || l.storeId !== storeId) return { kind: "not_found" };
    if (l.status !== "LISTED") return { kind: "not_listed" };
    const r = await this.d.store.withdraw({ listingId, events: [{ type: "resale.withdrawn", listingId, storeId }] });
    return r === "ok" ? { kind: "withdrawn" } : r === "not_found" ? { kind: "not_found" } : { kind: "not_listed" };
  }
}

export interface ListingView {
  readonly id: string;
  readonly resaleSkuId: string;
  readonly grade: ListingRecord["grade"];
  readonly price: bigint;
  readonly priceLabel: "launch_price" | "plain_price";
  readonly photoCount: number;
  readonly defectNote: string | null;
  readonly listedAtMs: number;
}

export class BrowseResale {
  constructor(private readonly d: ResaleDeps) {}
  private view(l: ListingRecord): ListingView {
    const disp = resalePriceDisplay(l.price, l.listedAtMs, this.d.clock.nowMs());
    return { id: l.id, resaleSkuId: l.resaleSkuId, grade: l.grade, price: disp.price, priceLabel: disp.label, photoCount: l.photoIds.length, defectNote: l.defectNote, listedAtMs: l.listedAtMs };
  }
  async live(limit: number, after: ListingCursor | null): Promise<readonly ListingView[]> {
    return (await this.d.store.listLive(Math.min(Math.max(limit, 1), 50), after)).map((l) => this.view(l));
  }
  async one(id: string): Promise<ListingView | null> {
    const l = await this.d.store.getListing(id);
    return l === null || l.status !== "LISTED" ? null : this.view(l);
  }
}
