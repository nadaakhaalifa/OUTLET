import { beforeEach, describe, expect, it } from "vitest";
import { BrowseResale, ListReturnedUnit, RecordResaleSale, WithdrawListing } from "./application/resale";
import { DAY, HUB_1, HUB_2, STORE_A, STORE_B, U, createFixture, returnFacts, type Fixture } from "./test/fixtures";

let f: Fixture;
let list: ListReturnedUnit;
beforeEach(() => {
  f = createFixture();
  list = new ListReturnedUnit(f.deps);
  f.returns.byId.set(returnFacts(1).returnId, returnFacts(1));
  f.consent.sellers.add(STORE_A);
});
const input = (over: Record<string, unknown> = {}) => ({
  returnId: returnFacts(1).returnId,
  operatorId: U(11),
  operatorHubIds: [HUB_1],
  grade: "B",
  photoIds: ["p1"],
  defectNote: null,
  price: 80_000n,
  ...over,
});

describe("listing a returned unit", () => {
  it("lists an inspected, opted-in standard unit as Open-box returned", async () => {
    const r = await list.execute(input());
    if (r.kind !== "listed") throw new Error(r.kind);
    expect(r.listing).toMatchObject({ grade: "B", status: "LISTED", ownership: "seller", price: 80_000n });
    expect(f.store.outbox.map((e) => e.type)).toEqual(["resale.listed"]);
    expect(f.catalog.created.size).toBe(1);
  });
  it("refuses without seller consent, after failed inspection, for hygiene and personalized units", async () => {
    f.consent.sellers.clear();
    expect(await list.execute(input())).toEqual({ kind: "refused", reason: "seller_declined" });
    f.consent.sellers.add(STORE_A);
    f.returns.byId.set(returnFacts(1).returnId, returnFacts(1, { inspectionPassed: false }));
    expect(await list.execute(input())).toEqual({ kind: "refused", reason: "inspection_not_passed" });
    for (const c of ["hygiene", "personalized"] as const) {
      f.returns.byId.set(returnFacts(1).returnId, returnFacts(1, { returnClass: c }));
      expect(await list.execute(input())).toEqual({ kind: "refused", reason: "hygiene_or_personalized" });
    }
    expect(f.store.listings.size).toBe(0);
  });
  it("hub-owned units need signed RTV terms", async () => {
    f.returns.byId.set(returnFacts(1).returnId, returnFacts(1, { ownership: "platform_rtv" }));
    expect(await list.execute(input())).toEqual({ kind: "refused", reason: "rtv_terms_missing" });
    f.consent.rtvUnits.add(returnFacts(1).unitRef);
    expect((await list.execute(input())).kind).toBe("listed");
  });
  it("a unit loops through resale once", async () => {
    expect((await list.execute(input())).kind).toBe("listed");
    expect((await list.execute(input())).kind).toBe("already_listed");
    expect(f.store.listings.size).toBe(1);
  });
  it("another hub's operator gets not_found; kill switch stops listing", async () => {
    expect(await list.execute(input({ operatorHubIds: [HUB_2] }))).toEqual({ kind: "not_found" });
    expect(await list.execute(input({ returnId: U(99_999) }))).toEqual({ kind: "not_found" });
    f.flags.enabled = false;
    expect(await list.execute(input())).toEqual({ kind: "disabled" });
  });
  it("validates grade, photos, defect note and price", async () => {
    expect(await list.execute(input({ grade: "Z" }))).toMatchObject({ kind: "invalid" });
    expect(await list.execute(input({ photoIds: [] }))).toMatchObject({ kind: "invalid" });
    expect(await list.execute(input({ grade: "C", photoIds: ["a", "b"] }))).toMatchObject({ kind: "invalid", issues: ["defect_note_required"] });
    expect(await list.execute(input({ price: 0n }))).toMatchObject({ kind: "invalid" });
    expect((await list.execute(input({ grade: "C", photoIds: ["a", "b"], defectNote: "  small stain on cuff " }))).kind).toBe("listed");
  });
});

describe("browsing never claims a discount", () => {
  it("shows a launch price for 30 days then a plain price, with no reference price", async () => {
    const r = await list.execute(input());
    if (r.kind !== "listed") throw new Error(r.kind);
    const browse = new BrowseResale(f.deps);
    const v1 = await browse.one(r.listing.id);
    expect(v1).toMatchObject({ priceLabel: "launch_price", price: 80_000n });
    f.clock.advance(31 * DAY);
    expect(await browse.one(r.listing.id)).toMatchObject({ priceLabel: "plain_price" });
    expect(Object.keys(v1 ?? {})).not.toEqual(expect.arrayContaining(["originalPrice", "vrp", "percentOff", "strikeThroughPrice"]));
    expect((await browse.live(10, null)).length).toBe(1);
  });
});

describe("sale and proceeds", () => {
  const sell = async (over: Record<string, unknown> = {}) => {
    const r = await list.execute(input(over));
    if (r.kind !== "listed") throw new Error(r.kind);
    return r.listing;
  };
  it("allocates integer parts that sum to the gross and posts one balanced entry", async () => {
    f.terms.commissionBps = 1_333;
    const l = await sell({ price: 99_999n });
    const sale = new RecordResaleSale(f.deps);
    const r = await sale.execute(l.id);
    if (r.kind !== "sold") throw new Error(r.kind);
    expect(r.proceeds.gross).toBe(99_999n);
    expect(r.proceeds.sellerPayable + r.proceeds.platformRetained).toBe(99_999n);
    const entry = f.ledger.entries.get(`resale-sale:${l.id}`);
    expect(entry?.reduce((s, x) => s + x.amount, 0n)).toBe(0n);
    expect(entry?.map((x) => x.account)).toEqual(["resale_clearing", `seller_payable:${STORE_A}`, "platform_commission"]);
    expect(f.store.outbox.map((e) => e.type)).toEqual(["resale.listed", "resale.sold"]);
  });
  it("is idempotent: a replay returns the same proceeds and does not double post", async () => {
    const l = await sell();
    const sale = new RecordResaleSale(f.deps);
    const a = await sale.execute(l.id);
    const b = await sale.execute(l.id);
    expect(a.kind).toBe("sold");
    expect(b.kind).toBe("already_sold");
    expect(f.ledger.entries.size).toBe(1);
    expect(f.store.outbox.filter((e) => e.type === "resale.sold")).toHaveLength(1);
  });
  it("hub-owned stock splits by the vendor share and books margin, not commission", async () => {
    f.returns.byId.set(returnFacts(1).returnId, returnFacts(1, { ownership: "platform_rtv" }));
    f.consent.rtvUnits.add(returnFacts(1).unitRef);
    f.terms.vendorShareBps = 6_000;
    const l = await sell({ price: 100_000n });
    const r = await new RecordResaleSale(f.deps).execute(l.id);
    expect(r).toMatchObject({ kind: "sold", proceeds: { sellerPayable: 60_000n, platformRetained: 40_000n } });
    expect(f.ledger.entries.get(`resale-sale:${l.id}`)?.map((x) => x.account)).toContain("resale_margin_revenue");
  });
  it("a withdrawn or unknown listing cannot be sold; only the owning store can withdraw", async () => {
    const l = await sell();
    const w = new WithdrawListing(f.deps);
    expect(await w.execute(STORE_B, l.id)).toEqual({ kind: "not_found" });
    expect(await w.execute(STORE_A, l.id)).toEqual({ kind: "withdrawn" });
    expect(await w.execute(STORE_A, l.id)).toEqual({ kind: "not_listed" });
    const sale = new RecordResaleSale(f.deps);
    expect(await sale.execute(l.id)).toEqual({ kind: "not_sellable" });
    expect(await sale.execute(U(99_999))).toEqual({ kind: "not_found" });
    expect(f.ledger.entries.size).toBe(0);
  });
});
