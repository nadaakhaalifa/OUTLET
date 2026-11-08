/**
 * Rate-limit budgets (BUILD-PROMPT §4 starting budgets; docs/api/README.md defaults where §4 is silent).
 * Tune by measurement (k6). Keys: prefer user, device and store; IP and ASN never stand alone (Egyptian mobile
 * networks put many users behind one IP, CGNAT) and get a multiplier.
 */
export type RateKey = "user" | "device" | "store" | "ip" | "asn";
export const RATE_KEYS: readonly RateKey[] = ["user", "device", "store", "ip", "asn"];

export interface RateBudget {
  readonly name: string;
  readonly limit: number;
  readonly periodMs: number;
  readonly keys: readonly RateKey[];
  /** What happens when the limiter itself fails: reads stay open, writes and abuse-prone flows fail closed. */
  readonly failMode: "open" | "closed";
  /** Where the number comes from (x-rate-limit source in the contract). */
  readonly source: "build-prompt" | "default";
}

/** One IP stands for many users behind CGNAT; one ASN for a whole carrier. */
export const KEY_MULTIPLIER: Readonly<Record<RateKey, number>> = { user: 1, device: 1, store: 1, ip: 10, asn: 100 };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const b = (name: string, limit: number, periodMs: number, keys: readonly RateKey[], failMode: "open" | "closed", source: RateBudget["source"]): RateBudget =>
  Object.freeze({ name, limit, periodMs, keys, failMode, source });

export const RATE_BUDGETS = {
  // BUILD-PROMPT §4 table. OTP phone limits (3 / 15 min) and per-code verify attempts (5) live in @outlet/auth-core,
  // which sees the phone blind index; the HTTP layer adds the device budget.
  otpRequestDevice: b("otp_request_device", 10, DAY, ["device"], "closed", "build-prompt"),
  search: b("search", 30, 10 * SECOND, ["user", "device"], "open", "build-prompt"),
  checkout: b("checkout", 5, MINUTE, ["user", "device"], "closed", "build-prompt"),
  /** §4 says 5 failures per hour; until failure-only counting exists every attempt counts (stricter). */
  giftCardRedeem: b("gift_card_redeem", 5, HOUR, ["user"], "closed", "build-prompt"),
  priceCheck: b("price_check", 60, MINUTE, ["store"], "closed", "build-prompt"),
  sharedWishlist: b("shared_wishlist", 20, MINUTE, ["device", "ip"], "open", "build-prompt"),
  // docs/api/README.md defaults (source: default).
  publicRead: b("public_read", 120, MINUTE, ["device", "ip"], "open", "default"),
  passportRead: b("passport_read", 60, MINUTE, ["device", "ip"], "open", "default"),
  shopperRead: b("shopper_read", 120, MINUTE, ["user"], "open", "default"),
  shopperWrite: b("shopper_write", 30, MINUTE, ["user"], "closed", "default"),
  sellerRead: b("seller_read", 300, MINUTE, ["store"], "open", "default"),
  sellerWrite: b("seller_write", 120, MINUTE, ["store"], "closed", "default"),
} as const satisfies Record<string, RateBudget>;
