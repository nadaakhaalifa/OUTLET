import { createHmac, timingSafeEqual } from "node:crypto";
import { PAYMENT_METHODS } from "@outlet/checkout";
import type { CheckoutConfig, CommissionPort, KillSwitchPort, PaymentMethod, QuoteTokenPort, TaxCategoryPort } from "@outlet/checkout";
import { isKillSwitchName } from "@outlet/flags";
import type { KillSwitchName } from "@outlet/flags";
import { money } from "@outlet/money";
import type { Money } from "@outlet/money";
import { z } from "zod";

/** Starting configuration (master prompt sections 7, 20.7). Every value is admin-editable config later; nothing here is a provider setting. */
export const productionCheckoutConfig = (): CheckoutConfig => ({
  fundsFlow: "psp_split",
  provider: "paymob",
  priceLockSec: 600,
  holdWindowSec: { card: 600, wallet: 1800, fawry: 86_400, cod: 7200 },
  methodWindow: { card: "card", apple_pay: "card", meeza: "card", wallet: "wallet", instapay: "wallet", fawry: "fawry", bnpl: "card", cod: "cod", store_credit: "card" },
  methodFee: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, money(0n, "EGP")])) as Record<PaymentMethod, Money>,
  shippingTaxBp: 1400,
  commissionVatBp: 1400,
  sellerAcceptSlaSec: 86_400,
  codMaxFirstOrder: money(150_000n, "EGP"),
});

const Payload = z.strictObject({
  jti: z.string().min(1), userId: z.string().min(1), marketId: z.string().min(1), quoteHash: z.string().min(1),
  method: z.enum(PAYMENT_METHODS), expiresAt: z.iso.datetime(),
});

/** HMAC-SHA256 quote token: base64url(JSON) "." base64url(mac). The secret comes from the secrets manager. */
export class HmacQuoteTokenPort implements QuoteTokenPort {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new RangeError("quote token secret must be at least 32 characters");
  }
  private mac(body: string): Buffer {
    return createHmac("sha256", this.secret).update(body).digest();
  }
  sign(p: Parameters<QuoteTokenPort["sign"]>[0]): string {
    const body = Buffer.from(JSON.stringify({ ...p, expiresAt: p.expiresAt.toISOString() })).toString("base64url");
    return `${body}.${this.mac(body).toString("base64url")}`;
  }
  verify(token: string): ReturnType<QuoteTokenPort["verify"]> {
    const [body, mac] = token.split(".");
    if (body === undefined || mac === undefined) return null;
    const got = Buffer.from(mac, "base64url");
    const want = this.mac(body);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const r = Payload.safeParse(raw);
    return r.success ? { ...r.data, expiresAt: new Date(r.data.expiresAt) } : null;
  }
}

/** Money kill switches live in @outlet/flags and fail closed; an unknown key counts as engaged. */
export class FlagKillSwitches implements KillSwitchPort {
  constructor(private readonly flags: { isKilled(name: KillSwitchName, ctx: { marketId: string }): Promise<boolean> }, private readonly marketId: string) {}
  isEngaged(key: string): Promise<boolean> {
    return isKillSwitchName(key) ? this.flags.isKilled(key, { marketId: this.marketId }) : Promise.resolve(true);
  }
}

/** The catalog has no tax column yet: every sku is standard-rated (the port's documented default). */
export class StandardTaxCategories implements TaxCategoryPort {
  categoriesFor(skuIds: readonly string[]): ReturnType<TaxCategoryPort["categoriesFor"]> {
    return Promise.resolve(new Map(skuIds.map((s) => [s, "standard" as const])));
  }
}

/** Commission comes from the seller plan (owner decision D1 open): without it no order can be priced for payout, so placement fails closed. */
export class UnconfiguredCommission implements CommissionPort {
  rateFor(): Promise<never> {
    return Promise.reject(new Error("commission plans are not configured"));
  }
}
