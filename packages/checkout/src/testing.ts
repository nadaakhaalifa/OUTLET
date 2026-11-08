/**
 * Fakes for every checkout port (README section 11 step 2). TEST AND LOCAL ONLY: nothing here talks to a real PSP, courier or
 * risk vendor. Production adapters stay Unconfigured and fail closed (ADR-0029).
 */
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { money } from "@outlet/money";
import { z } from "zod";
import type { Currency, Money } from "@outlet/money";
import { PAYMENT_METHODS } from "./ports.js";
import type {
  AddressPort, BillingPort, CheckoutConfig, ClientAction, CommissionPort, CreateIntentRequest, CreateIntentResult, ExternalMethod, KillSwitchPort,
  NormalizedPaymentEvent, PaymentMethod, PaymentProviderPort, PriceSnapshotPort, QuoteTokenPort, RawBodyCipher, RefundPort, RiskDecision, RiskPort,
  ShippingQuotePort, SubMerchantPort, TaxCategoryPort, WebhookInput, WebhookVerification,
} from "./ports.js";

const EGP: Currency = "EGP";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const defaultConfig = (over: Partial<CheckoutConfig> = {}): CheckoutConfig => ({
  fundsFlow: "psp_split",
  provider: "fake",
  priceLockSec: 600,
  holdWindowSec: { card: 600, wallet: 1800, fawry: 86_400, cod: 7200 },
  methodWindow: { card: "card", apple_pay: "card", meeza: "card", wallet: "wallet", instapay: "wallet", fawry: "fawry", bnpl: "card", cod: "cod", store_credit: "card" },
  methodFee: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, money(0n, EGP)])) as Record<PaymentMethod, Money>,
  shippingTaxBp: 1400,
  commissionVatBp: 1400,
  sellerAcceptSlaSec: 86_400,
  codMaxFirstOrder: money(150_000n, EGP),
  ...over,
});

export type FakeCreateOutcome = "requires_action" | "captured" | "decline" | "timeout";
export type FakeVoidOutcome = "voided" | "already_captured" | "not_found";

/** Scriptable PSP. Webhooks are signed with HMAC-SHA256 over the raw body (header x-fake-signature), key held here. */
export class FakePaymentProvider implements PaymentProviderPort {
  readonly provider = "fake" as const;
  readonly key = "fake-psp-test-key";
  nextCreate: FakeCreateOutcome = "requires_action";
  nextVoid: FakeVoidOutcome = "voided";
  readonly createCalls: { readonly req: CreateIntentRequest; readonly key: string }[] = [];
  /** Runs after the intent exists at the PSP and before createIntent returns: lets a test deliver the webhook first. */
  onCreated: ((info: { readonly providerRef: string; readonly req: CreateIntentRequest }) => Promise<void>) | null = null;
  readonly voidCalls: { readonly paymentIntentId: string; readonly key: string }[] = [];
  private seq = 0;
  /** A real PSP deduplicates by Idempotency-Key: the same key returns the same intent. */
  private readonly byKey = new Map<string, CreateIntentResult>();

  supports(method: ExternalMethod): boolean {
    return PAYMENT_METHODS.includes(method);
  }

  async createIntent(req: CreateIntentRequest, idempotencyKey: string): Promise<CreateIntentResult> {
    this.createCalls.push({ req, key: idempotencyKey });
    if (this.nextCreate === "timeout") return { ok: false, retryable: true, code: "timeout" };
    if (this.nextCreate === "decline") return { ok: false, retryable: false, code: "declined" };
    const prior = this.byKey.get(idempotencyKey);
    if (prior !== undefined) return prior;
    this.seq += 1;
    const providerRef = `fake_${idempotencyKey}_${String(this.seq)}`;
    const clientAction: ClientAction =
      req.method === "fawry"
        ? { kind: "fawry_reference", reference: `FW${String(this.seq)}`, expiresAt: req.expiresAt.toISOString() }
        : { kind: "redirect", url: `https://pay.fake.test/${providerRef}` };
    if (this.onCreated !== null) await this.onCreated({ providerRef, req });
    const result: CreateIntentResult = { ok: true, providerRef, clientAction, status: this.nextCreate === "captured" ? "captured" : "requires_action" };
    this.byKey.set(idempotencyKey, result);
    return result;
  }

  voidIntent(ref: { readonly paymentIntentId: string; readonly providerRef: string | null }, idempotencyKey: string): Promise<{ readonly outcome: FakeVoidOutcome }> {
    this.voidCalls.push({ paymentIntentId: ref.paymentIntentId, key: idempotencyKey });
    return Promise.resolve({ outcome: this.nextVoid });
  }

  sign(rawBody: Uint8Array): string {
    return createHmac("sha256", this.key).update(rawBody).digest("hex");
  }

  /** Builds a signed webhook for an event (amount in piastres, EGP). `badSignature` tampers the header. */
  webhook(e: { id: string; type: NormalizedPaymentEvent["type"]; merchantReference: string | null; providerRef: string; amountMinor: bigint; failureCode?: string }, opts: { badSignature?: boolean; at?: Date } = {}): WebhookInput {
    const rawBody = textEncoder.encode(JSON.stringify({ id: e.id, type: e.type, merchantReference: e.merchantReference, providerRef: e.providerRef, amountMinor: e.amountMinor.toString(), currency: "EGP", failureCode: e.failureCode ?? null }));
    const sig = this.sign(rawBody);
    return { rawBody, headers: { "x-fake-signature": opts.badSignature === true ? `${sig.slice(0, -2)}00` : sig }, query: {}, receivedAt: opts.at ?? new Date() };
  }

  verifyWebhook(input: WebhookInput): WebhookVerification {
    const given = Buffer.from(input.headers["x-fake-signature"] ?? "", "hex");
    const want = Buffer.from(this.sign(input.rawBody), "hex");
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "bad_signature" };
    try {
      const b = JSON.parse(textDecoder.decode(input.rawBody)) as { id: string; type: NormalizedPaymentEvent["type"]; merchantReference: string | null; providerRef: string; amountMinor: string; currency: Currency; failureCode: string | null };
      return {
        ok: true,
        event: { providerEventId: b.id, type: b.type, merchantReference: b.merchantReference, providerRef: b.providerRef, amount: money(BigInt(b.amountMinor), b.currency), occurredAt: input.receivedAt, failureCode: b.failureCode, threeDs: null },
      };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
}

export class FakeShipping implements ShippingQuotePort {
  /** Fee per store in piastres (VAT-inclusive); default for stores not listed. */
  readonly fees = new Map<string, bigint>();
  defaultFee = 6000n;
  readonly unavailable = new Set<string>();
  calls = 0;
  quote(req: Parameters<ShippingQuotePort["quote"]>[0]): ReturnType<ShippingQuotePort["quote"]> {
    this.calls += 1;
    if (this.unavailable.has(req.storeId)) return Promise.resolve({ unavailable: true, reason: "no_coverage" });
    return Promise.resolve({ quoteRef: `ship_${req.storeId}`, fee: money(this.fees.get(req.storeId) ?? this.defaultFee, EGP), etaDaysMin: 1, etaDaysMax: 3, serviceLevel: "standard" });
  }
}

export class FakeRisk implements RiskPort {
  decision: RiskDecision = "allow";
  calls = 0;
  assessCod(): ReturnType<RiskPort["assessCod"]> {
    this.calls += 1;
    return Promise.resolve({ decision: this.decision, reasonCodes: [] });
  }
}

export class FakeCommission implements CommissionPort {
  readonly bp = new Map<string, number>();
  defaultBp = 1500;
  rateFor(storeId: string): ReturnType<CommissionPort["rateFor"]> {
    return Promise.resolve({ bp: this.bp.get(storeId) ?? this.defaultBp, planId: null });
  }
}

export class FakeAddress implements AddressPort {
  /** address ref -> owning user; any ref not listed resolves for nobody (404). `open` makes every ref resolve. */
  readonly owners = new Map<string, string>();
  open = true;
  resolve(userId: string, addressRef: string): ReturnType<AddressPort["resolve"]> {
    if (this.open || this.owners.get(addressRef) === userId) return Promise.resolve({ geoAreaId: "00000000-0000-4000-8000-0000000000aa", countryCode: "EG" });
    return Promise.resolve(null);
  }
}

export class FakeTaxCategories implements TaxCategoryPort {
  readonly overrides = new Map<string, "standard" | "zero_rated" | "exempt" | "reduced">();
  categoriesFor(skuIds: readonly string[]): ReturnType<TaxCategoryPort["categoriesFor"]> {
    return Promise.resolve(new Map(skuIds.map((s) => [s, this.overrides.get(s) ?? "standard"] as const)));
  }
}

export class FakePrices implements PriceSnapshotPort {
  readonly snapshots = new Map<string, Awaited<ReturnType<PriceSnapshotPort["snapshotForOrderLine"]>>>();
  snapshotForOrderLine(skuId: string): ReturnType<PriceSnapshotPort["snapshotForOrderLine"]> {
    return Promise.resolve(this.snapshots.get(skuId) ?? { vrp: null, evidenceIds: [], claimType: "plain" });
  }
}

export class FakeKillSwitches implements KillSwitchPort {
  readonly engaged = new Set<string>();
  isEngaged(key: string): Promise<boolean> {
    return Promise.resolve(this.engaged.has(key));
  }
}

export class FakeSubMerchants implements SubMerchantPort {
  readonly missing = new Set<string>();
  refFor(storeId: string): Promise<string | null> {
    return Promise.resolve(this.missing.has(storeId) ? null : `sub_${storeId}`);
  }
}

export class FakeBilling implements BillingPort {
  billingFor(): ReturnType<BillingPort["billingFor"]> {
    return Promise.resolve({ firstName: "Test", lastName: "Shopper", phoneE164: "+201000000000", email: null });
  }
}

export class RecordingRefunds implements RefundPort {
  readonly requests: Parameters<RefundPort["requestRefund"]>[0][] = [];
  requestRefund(req: Parameters<RefundPort["requestRefund"]>[0]): ReturnType<RefundPort["requestRefund"]> {
    this.requests.push(req);
    return Promise.resolve({ accepted: true });
  }
}

const b64 = (b: Buffer): string => b.toString("base64url");

const TOKEN_PAYLOAD = z.strictObject({
  kid: z.string().min(1),
  jti: z.string().min(1),
  userId: z.string().min(1),
  marketId: z.string().min(1),
  quoteHash: z.string().min(1),
  method: z.enum(PAYMENT_METHODS),
  expiresAt: z.iso.datetime(),
});

/**
 * HMAC-SHA256 signed token: base64url(JSON payload) + "." + base64url(mac). Dates travel as ISO strings; the payload is Zod-parsed after the
 * MAC check and carries a `kid` so keys can rotate (sign with `current`, verify with any listed key). PRODUCTION NOTE: the real adapter keeps
 * its keys in the secrets manager (never in code or env files), rotates them on a schedule, and keeps the previous kid verifiable for one
 * token lifetime (10 min) so a rotation never invalidates a quote in flight.
 */
export class HmacQuoteTokens implements QuoteTokenPort {
  private readonly keys: ReadonlyMap<string, string>;
  constructor(secret = "fake-quote-token-secret", private readonly current = "k1", extraKeys: Readonly<Record<string, string>> = {}) {
    this.keys = new Map([[current, secret], ...Object.entries(extraKeys)]);
  }
  sign(p: Parameters<QuoteTokenPort["sign"]>[0]): string {
    const secret = this.keys.get(this.current) ?? "";
    const body = b64(Buffer.from(JSON.stringify({ ...p, kid: this.current, expiresAt: p.expiresAt.toISOString() })));
    return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
  }
  verify(token: string): ReturnType<QuoteTokenPort["verify"]> {
    const [body, mac] = token.split(".");
    if (body === undefined || mac === undefined) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const kid = typeof raw === "object" && raw !== null && "kid" in raw && typeof raw.kid === "string" ? raw.kid : null;
    const secret = kid === null ? undefined : this.keys.get(kid);
    if (secret === undefined) return null;
    const want = createHmac("sha256", secret).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const parsed = TOKEN_PAYLOAD.safeParse(raw);
    if (!parsed.success) return null;
    const { jti, userId, marketId, quoteHash, method, expiresAt } = parsed.data;
    return { jti, userId, marketId, quoteHash, method, expiresAt: new Date(expiresAt) };
  }
}

/** AES-256-GCM with a random test key: iv(12) || tag(16) || ciphertext, aad bound. */
export class FakeCipher implements RawBodyCipher {
  private readonly key = randomBytes(32);
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Promise.resolve(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
}
