import { describe, expect, it } from "vitest";
import { GuardRejectedError, InvalidTransitionError } from "@outlet/domain";
import { InMemoryStoreRepository } from "./adapters/in-memory";
import { ApplySellerKycEvent, ChangeStoreStatus, SellerStoresNotFoundError } from "./application/seller-lifecycle";
import { isShopperVisible, StoreRuleError } from "./domain/store";
import { makeStore, uuid } from "./test/fixtures";

const OK = { documentsValid: true, sanctionsClear: true, signatoryAdult21: true };
const SELLER = uuid(7000);

function setup() {
  const repo = new InMemoryStoreRepository([
    makeStore(1, { sellerId: SELLER, sellerKycState: "DRAFT", status: "DRAFT" }),
    makeStore(2, { sellerId: SELLER, sellerKycState: "DRAFT", status: "DRAFT" }),
    makeStore(3, { sellerKycState: "APPROVED" }),
  ]);
  return { repo, kyc: new ApplySellerKycEvent(repo), status: new ChangeStoreStatus(repo) };
}

describe("ApplySellerKycEvent", () => {
  it("walks the shared machine and caches the state on every store of the seller only", async () => {
    const { repo, kyc } = setup();
    for (const ev of ["SUBMIT", "START_CHECKS"] as const) await kyc.execute(SELLER, ev, OK);
    const res = await kyc.execute(SELLER, "APPROVE", OK);
    expect(res).toMatchObject({ from: "AUTO_CHECKS", to: "APPROVED" });
    expect([...res.affectedStoreIds].sort()).toEqual([uuid(1), uuid(2)]);
    expect((await repo.findById(uuid(1)))?.sellerKycState).toBe("APPROVED");
    expect((await repo.findById(uuid(2)))?.sellerKycState).toBe("APPROVED");
    expect((await repo.findById(uuid(3)))?.sellerKycState).toBe("APPROVED");
  });

  it("leaves state untouched on an invalid transition or a failed guard", async () => {
    const { repo, kyc } = setup();
    await expect(kyc.execute(SELLER, "APPROVE", OK)).rejects.toBeInstanceOf(InvalidTransitionError);
    await kyc.execute(SELLER, "SUBMIT", OK);
    await kyc.execute(SELLER, "START_CHECKS", OK);
    await expect(kyc.execute(SELLER, "APPROVE", { ...OK, signatoryAdult21: false })).rejects.toBeInstanceOf(GuardRejectedError);
    expect((await repo.findById(uuid(1)))?.sellerKycState).toBe("AUTO_CHECKS");
  });

  it("suspension hides the seller's stores and reinstatement restores them", async () => {
    const { repo, kyc, status } = setup();
    for (const ev of ["SUBMIT", "START_CHECKS", "APPROVE"] as const) await kyc.execute(SELLER, ev, OK);
    await status.execute(uuid(1), "ACTIVATE");
    expect(isShopperVisible((await repo.findById(uuid(1))) ?? makeStore(0, { status: "DRAFT" }))).toBe(true);
    await kyc.execute(SELLER, "SUSPEND", OK);
    expect(isShopperVisible((await repo.findById(uuid(1))) ?? makeStore(0))).toBe(false);
    await kyc.execute(SELLER, "REINSTATE", OK);
    expect(isShopperVisible((await repo.findById(uuid(1))) ?? makeStore(0, { status: "DRAFT" }))).toBe(true);
  });

  it("fails for an unknown seller", async () => {
    const { kyc } = setup();
    await expect(kyc.execute(uuid(1), "SUBMIT", OK)).rejects.toBeInstanceOf(SellerStoresNotFoundError);
  });
});

describe("ChangeStoreStatus", () => {
  it("returns null for a missing store and refuses activation for an unapproved seller", async () => {
    const { status } = setup();
    expect(await status.execute(uuid(99), "ACTIVATE")).toBeNull();
    await expect(status.execute(uuid(1), "ACTIVATE")).rejects.toBeInstanceOf(StoreRuleError);
  });

  it("applies a valid transition and reports from and to", async () => {
    const { repo, status } = setup();
    await repo.save(makeStore(3, { status: "ACTIVE" }));
    expect(await status.execute(uuid(3), "PAUSE")).toEqual({ storeId: uuid(3), from: "ACTIVE", to: "PAUSED" });
    await expect(status.execute(uuid(3), "REINSTATE")).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});
