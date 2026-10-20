import type { AgePolicyPort } from "../modules/subscriptions";
import type {
  BudgetGatePort,
  CatalogQuotePort,
  DeliverabilityPort,
  MemberEligibilityPort,
  SkuQuote,
} from "../modules/auto-buy";
import type { SkuLookupReader } from "../modules/catalog";
import type { CheckoutCapPort } from "../modules/budget";

/**
 * Cross-module bindings for the auto-buy ports (ADR-0036). Each adapter is thin and reads through
 * the owning module's public surface. Anything an adapter cannot establish THROWS (or answers the
 * restrictive value): the sweep and the creation use case treat a dependency error as a refusal,
 * never as a charge.
 */

/** Plus entitlement (subscriptions) and the Plus age policy. Both must hold. */
export class PlusMemberEligibility implements MemberEligibilityPort {
  constructor(
    private readonly entitlements: { forUser(userId: string): Promise<{ readonly entitled: boolean }> },
    private readonly ages: Pick<AgePolicyPort, "plusMinAge" | "ageYears">,
  ) {}

  async eligibility(userId: string): Promise<{ readonly plusActive: boolean; readonly ageOk: boolean }> {
    const [view, min, age] = await Promise.all([this.entitlements.forUser(userId), this.ages.plusMinAge(), this.ages.ageYears(userId)]);
    // No verified date of birth means the age gate is not met (never assumed).
    return { plusActive: view.entitled, ageOk: age !== null && age >= min };
  }
}

/**
 * The shopper's DEFAULT address must be covered by a courier. `unknown` coverage is not deliverable.
 * Coverage is address level, so the SKU does not change the answer (seller dispatch location is not a courier input).
 */
export class AddressBookDeliverability implements DeliverabilityPort {
  constructor(
    private readonly addresses: {
      list(userId: string, after: null, limit: number): Promise<readonly { readonly isDefault: boolean; readonly courierCoverage: "covered" | "not_covered" | "unknown" }[]>;
    },
  ) {}

  async deliverable(userId: string, _skuId: string): Promise<boolean> {
    const rows = await this.addresses.list(userId, null, 50);
    const d = rows.find((a) => a.isDefault);
    return d !== undefined && d.courierCoverage === "covered";
  }
}

/**
 * Budget gate through the budget module's checkout cap port: the cap rule is evaluated exactly once,
 * in the budget module, and only a three-valued decision leaves it (never the budget, the remaining
 * amount or the cycle). `authorize` records a provisional spend under a throwaway key which is
 * released in `finally`. A budget store outage (`service_unavailable`, which checkout deliberately
 * lets through) is an ERROR here: an unattended charge must not run on a guess.
 */
export class CheckoutCapBudgetGate implements BudgetGatePort {
  constructor(
    private readonly cap: CheckoutCapPort,
    private readonly newKey: () => string,
  ) {}

  async evaluate(userId: string, amount: bigint): Promise<"within" | "soft_cap_exceeded" | "hard_cap_exceeded"> {
    const orderKey = `auto_buy_gate:${this.newKey()}`;
    try {
      const d = await this.cap.authorize({ userId, orderKey, orderTotal: amount, softHeldSinceMs: null });
      if (d.kind === "blocked") return "hard_cap_exceeded";
      if (d.kind === "soft_hold") return "soft_cap_exceeded";
      if (d.reason === "service_unavailable") throw new Error("budget_unavailable");
      return "within";
    } finally {
      try {
        await this.cap.release(userId, orderKey);
      } catch {
        // The key is single use and `placed:` rows are refreshed by the cycle roll; nothing else reads it.
      }
    }
  }
}

export interface QuoteSources {
  readonly skus: Pick<SkuLookupReader, "skuFacts">;
  /** price-integrity `snapshotFor`: current evidence-based claim for the SKU, null without history. */
  readonly prices: { snapshotFor(skuId: string): Promise<{ readonly priceAmount: bigint | null; readonly claimType: string } | null> };
  /** inventory standard pool level. */
  readonly stock: { levels(skuIds: readonly string[]): Promise<ReadonlyMap<string, { readonly available: number }>> };
  /** inventory SKU directory. */
  readonly directory: { lookup(skuId: string): Promise<{ readonly dropId: string | null } | null> };
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Live quote of one SKU at one size. Price comes from the catalog row (the primary), verification
 * from the price-integrity engine. `priceVerified` needs a `verified_discount` claim whose price equals
 * the listed price; a ledger price that differs from the listing is flagged as an anomaly. The engine
 * exposes no per-SKU enforcement flag, so ping-pong and spike detection are covered only through the
 * verified-discount rule (an increase inside the window resets the reference).
 */
export class LiveSkuQuote implements CatalogQuotePort {
  constructor(private readonly s: QuoteSources) {}

  async quote(skuId: string, sizeLabel: string): Promise<SkuQuote | null> {
    const f = await this.s.skus.skuFacts(skuId);
    if (f === null) return null;
    const [snap, levels, loc] = await Promise.all([this.s.prices.snapshotFor(skuId), this.s.stock.levels([skuId]), this.s.directory.lookup(skuId)]);
    const matches = snap !== null && snap.priceAmount === f.priceAmount;
    const sizeKnown = sizeLabel.trim().length > 0 && norm(f.sizeLabel) === norm(sizeLabel);
    return {
      listed: f.skuStatus === "active" && f.productStatus === "active",
      price: f.priceAmount,
      priceVerified: matches && snap.claimType === "verified_discount",
      priceAnomaly: snap !== null && snap.priceAmount !== null && snap.priceAmount !== f.priceAmount,
      sizeKnown,
      sizeInStock: sizeKnown && (levels.get(skuId)?.available ?? 0) >= 1,
      // A SKU the inventory does not know is treated as a drop SKU: excluded, never bought automatically.
      dropSku: loc === null || loc.dropId !== null,
      itemLabelAr: f.titleAr,
      itemLabelEn: f.titleEn ?? f.titleAr,
    };
  }
}
