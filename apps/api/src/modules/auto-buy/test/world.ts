import { CancelAttempt, CancelMandate } from "../application/cancel";
import { CreateMandate, type CreateInput } from "../application/create";
import { HandlePriceChange } from "../application/evaluate";
import { CancelAllForUser, CloseOnPurchase } from "../application/lifecycle";
import { ListMandates } from "../application/queries";
import type { AutoBuyDeps } from "../application/shared";
import { RunAutoBuySweep } from "../application/sweep";
import {
  FakeAutoBuyFlags,
  FakeBudgetGate,
  FakeCardVault,
  FakeCatalogQuote,
  FakeDeliverability,
  FakeInventoryHold,
  FakeMemberEligibility,
  FakeMitCheckout,
  FakeNotices,
  FakeRisk,
  InMemoryAutoBuyStore,
  RecordingOpsAudit,
} from "../adapters/in-memory";
import type { SkuQuote } from "../domain/ports";
import { SKU, T0, U } from "./repository-contract";

export class TestClock {
  constructor(private ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export const MIN = 60_000;
export const TOKEN = "tok_card_0123456789";

export const quote = (over: Partial<SkuQuote> = {}): SkuQuote => ({
  listed: true,
  price: 80_000n,
  priceVerified: true,
  priceAnomaly: false,
  sizeKnown: true,
  sizeInStock: true,
  dropSku: false,
  itemLabelAr: "فستان كتان",
  itemLabelEn: "Linen dress",
  ...over,
});

export function createWorld() {
  const clock = new TestClock();
  let n = 0;
  const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };
  const store = new InMemoryAutoBuyStore();
  const flags = new FakeAutoBuyFlags(true, false);
  const eligibility = new FakeMemberEligibility();
  const catalog = new FakeCatalogQuote();
  const deliverability = new FakeDeliverability();
  const risk = new FakeRisk();
  const budget = new FakeBudgetGate();
  const vault = new FakeCardVault();
  const inventory = new FakeInventoryHold();
  const mit = new FakeMitCheckout();
  const notices = new FakeNotices();
  const opsAudit = new RecordingOpsAudit();
  vault.tokens.set(TOKEN, "valid");
  catalog.skus.set(SKU(1), quote());
  const d: AutoBuyDeps = { store, clock, ids, flags, eligibility, catalog, deliverability, risk, budget, vault, inventory, mit, notices };
  const w = {
    clock,
    store,
    flags,
    eligibility,
    catalog,
    deliverability,
    risk,
    budget,
    vault,
    inventory,
    mit,
    notices,
    opsAudit,
    d,
    create: new CreateMandate(d),
    list: new ListMandates(d),
    cancelRule: new CancelMandate(d),
    cancelAttempt: new CancelAttempt(d),
    handle: new HandlePriceChange(d),
    sweep: new RunAutoBuySweep(d),
    closeOnPurchase: new CloseOnPurchase(d),
    cancelAll: new CancelAllForUser(d),
  };
  return {
    ...w,
    input(over: Partial<CreateInput> = {}): CreateInput {
      return {
        userId: U(1),
        skuId: SKU(1),
        sizeLabel: "M",
        targetPrice: 64_900n,
        maxPrice: 70_000n,
        expiresAtMs: clock.nowMs() + 30 * 86_400_000,
        mode: "notify_confirm",
        pspTokenRef: null,
        locale: "en",
        acceptedTermsVersion: 1,
        deviceId: "device-1",
        ...over,
      };
    },
    /** Creates an unattended rule (target 649.00, max 700.00) and returns its id. */
    async armUnattended(over: Partial<CreateInput> = {}): Promise<string> {
      w.flags.charge = true;
      const r = await w.create.execute({
        userId: U(1),
        skuId: SKU(1),
        sizeLabel: "M",
        targetPrice: 64_900n,
        maxPrice: 70_000n,
        expiresAtMs: clock.nowMs() + 30 * 86_400_000,
        mode: "unattended",
        pspTokenRef: TOKEN,
        locale: "en",
        acceptedTermsVersion: 1,
        deviceId: "device-1",
        ...over,
      });
      if (r.kind !== "created") throw new Error(`arm failed: ${r.kind}`);
      return r.mandate.id;
    },
    priceEvent(id: string, amount: bigint, over: Record<string, unknown> = {}): unknown {
      return {
        event_id: id,
        sku_id: SKU(1),
        price: { amount: amount.toString(), currency: "EGP" },
        verified: true,
        anomaly: false,
        occurred_at: new Date(clock.nowMs()).toISOString(),
        ...over,
      };
    },
    /** The live quote the charge-time recheck will read. */
    setLive(over: Partial<SkuQuote>): void {
      catalog.skus.set(SKU(1), quote(over));
    },
  };
}
export type World = ReturnType<typeof createWorld>;
