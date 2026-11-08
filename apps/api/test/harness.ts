import { randomUUID } from "node:crypto";
import { createAdminAccess } from "@outlet/admin-access";
import { AuditChain, InMemoryAuditStore } from "@outlet/audit-log";
import { SellerOnboardingService, UnconfiguredKycCheck } from "@outlet/seller-accounts";
import { AesGcmFieldCipher, InMemoryRateLimiter, OtpService, SessionService, createAuthDeps, registerDevice } from "@outlet/auth-core";
import type { SmsSender } from "@outlet/auth-core";
import { CartService, pgInventoryAvailability } from "@outlet/cart";
import { CheckoutService, OrderCloseJob, PgStoreCredit, WebhookProcessor, makePromotionsPort } from "@outlet/checkout";
import type { PaymentProviderPort } from "@outlet/checkout";
import {
  FakeAddress, FakeBilling, FakeCipher, FakeCommission, FakeKillSwitches, FakePaymentProvider, FakePrices, FakeRisk, FakeShipping, FakeSubMerchants, FakeTaxCategories, HmacQuoteTokens,
  RecordingRefunds, defaultConfig,
} from "@outlet/checkout/testing";
import { InventoryService, ReservationService } from "@outlet/inventory";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { AddressService } from "@outlet/shipping";
import { FakeCipher as ShippingFakeCipher, FakeCourier } from "@outlet/shipping/testing";
import { InMemoryTaxRateProvider } from "@outlet/tax";
import { DefectService, ListingService, PublicCatalogService, StoreService, VariantService } from "@outlet/catalog";
import type { CatalogDeps } from "@outlet/catalog";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { FlagService, InMemoryFlagStore } from "@outlet/flags";
import { MediaService } from "@outlet/media";
import { FakeAvScanner, HmacSigner, InMemoryStorage } from "@outlet/media/testing";
import { PRICE_WATCH_KILL_SWITCH } from "@outlet/pricing-integrity";
import { IdempotencyStore } from "@outlet/idempotency";
import { createLogger } from "@outlet/logger";
import type { Principal } from "@outlet/policy";
import { SignJWT, generateKeyPair } from "jose";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { createApp } from "../src/app.js";
import type { DeviceAttestationPort } from "../src/modules/auth/index.js";
import { PgChallengeStore, InMemoryPasskeyStore, SessionReader, WebAuthnPasskeys, UnconfiguredOidc } from "../src/modules/auth/index.js";
import { OrderGroupReader, staticWebhookIps } from "../src/modules/checkout/index.js";
import { noSuggestions } from "../src/modules/cart/index.js";
import { AttributeSetReader } from "../src/modules/seller-catalog/index.js";
import { SellerInventoryService } from "../src/modules/seller-inventory/index.js";
import { PgApprovalReader, PgKycAdmin, PgReconciliationReader } from "../src/modules/admin/index.js";
import { PgPaymentKind, SellerOrderService } from "../src/modules/seller-orders/index.js";
import { InMemoryBuyerDelivery } from "./seller-orders-fakes.js";
import { DealsReader } from "../src/modules/catalog-public/deals-reader.js";
import { DiscoveryReader } from "../src/modules/catalog-public/discovery-reader.js";
import type { ApiApp, CreateAppOptions } from "../src/app.js";
import { buildPostOrder } from "./post-order-fakes.js";
import type { PostOrderFakes } from "./post-order-fakes.js";
import { InMemoryStoreMemberships, SessionTokenVerifier } from "../src/platform/auth-ports.js";
import type { SellerRole } from "../src/platform/auth-ports.js";
import { DEFAULT_HTTP_CONFIG } from "../src/platform/deps.js";
import type { ApiDeps, CatalogServices, HttpConfig, IdempotencyPort, KillSwitchPort } from "../src/platform/deps.js";
import { MemoryRateLimiter } from "../src/platform/rate-limit/memory.js";
import type { RateLimiterPort } from "../src/platform/rate-limit/port.js";

// auth-core refuses its local AES cipher unless this is set (no KMS cipher exists); tests only.
process.env.OUTLET_LOCAL_CIPHER = "1";

import { uuidv7 as randomUUIDv7 } from "@outlet/ids";

export const MARKET = "eg";
export const DB_MARKET = "EG";
export const ISSUER = "https://auth.outlex.test";
export const AUDIENCE = "outlet:eg";
export const KID = "test-es256-1";
/** Fixed test time: tokens and Idempotency-Keys are minted against this clock. */
export const T0 = Date.parse("2030-01-01T00:00:00.000Z");

/** Counts business statements on a pool (context binding excluded), like @outlet/catalog/testing countQueries. */
export class QueryCounter {
  statements: string[] = [];
  reset(): void {
    this.statements = [];
  }
  get count(): number {
    return this.statements.length;
  }
  wrap<R extends "outlet_app">(client: RoleSqlClient<R>): RoleSqlClient<R> {
    const record = (q: Queryable): Queryable => ({
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
      query: <Row extends object>(sql: string, params?: readonly unknown[]) => {
        if (!sql.startsWith("SELECT set_config(")) this.statements.push(sql);
        return q.query<Row>(sql, params);
      },
    });
    return brandClient<R>({
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
      query: <Row extends object>(sql: string, params?: readonly unknown[]) => record(client).query<Row>(sql, params),
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) => client.transaction((tx) => fn(record(tx))),
    });
  }
}

export interface Seed {
  readonly storeA: string;
  readonly storeB: string;
  readonly slugA: string;
  readonly slugB: string;
  /** Published listing in store A with a defect card. */
  readonly productA: string;
  readonly passportA: string;
  readonly categoryId: string;
  /** The one sku of the seeded listing (store A), with 5 units in stock. */
  readonly skuA: string;
}

export interface TestApp extends ApiApp {
  readonly raw: SqlClient;
  readonly counter: QueryCounter;
  readonly memberships: InMemoryStoreMemberships;
  readonly flags: InMemoryFlagStore;
  readonly logs: string[];
  readonly seed: Seed;
  readonly sms: FakeSms;
  readonly attestation: FakeDeviceAttestation;
  readonly passkeyStore: InMemoryPasskeyStore;
  /** Fakes behind addresses, returns, tracking and seller onboarding. */
  readonly post: PostOrderFakes;
  readonly fakes: { provider: FakePaymentProvider; shipping: FakeShipping; risk: FakeRisk; kill: FakeKillSwitches; cod: { valid: Set<string> }; courier: FakeCourier; delivery: InMemoryBuyerDelivery };
  /** A real user row (carts and orders reference users) plus a token for it. */
  /** Staff user with live standing grants for `roles` (passkey session unless amr is given); every audited admin write lands in `adminAudit`. */
  admin(roles: readonly string[], amr?: readonly string[]): Promise<{ userId: string; token: string }>;
  readonly adminAudit: InMemoryAuditStore;
  shopper(): Promise<{ userId: string; token: string }>;
  /** A registered device id (what X-Device-Id carries). */
  device(): Promise<string>;
  /** Moves the shared clock (tokens, idempotency, rate limits). */
  readonly clock: { now: number };
  mint(o?: MintOptions): Promise<string>;
  /** A user who is a member of `storeId` with `roles` (passkey session unless amr is given). */
  seller(storeId: string, roles: readonly SellerRole[], amr?: readonly string[]): Promise<{ userId: string; token: string }>;
  inject(o: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export interface MintOptions {
  readonly userId?: string;
  readonly amr?: readonly string[];
  readonly audience?: string;
  readonly kid?: string;
  readonly expiresInS?: number;
  readonly issuer?: string;
}

const CATEGORY = "00000000-0000-4000-8000-0000000c0011";

const insertSellerAndStore = async (raw: SqlClient, sellerId: string, storeId: string, slug: string, n: string): Promise<void> => {
  await raw.query(
    `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
     VALUES ($1,'EG','EG','company',$2,$3,$4,$5,'CAI','القاهرة','active')`,
    [sellerId, `شركة ${n}`, `Company ${n}`, `CR-${n}`, `TX-${n}`],
  );
  await raw.query(
    `INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, display_name_en, kind, ships_from_country, status)
     VALUES ($1,$2,'EG',$3,$4,$5,'local','EG','ACTIVE')`,
    [storeId, sellerId, slug, `متجر ${slug}`, `Store ${slug}`],
  );
};

const owner = (storeId: string): Principal => ({ kind: "seller_staff", userId: randomUUID(), marketId: DB_MARKET, storeIds: [storeId], roles: ["owner"], scopes: [] });

/** Seeds two projected stores and one published graded listing with a passport, through the real catalog services. */
const seedCatalog = async (raw: SqlClient, deps: CatalogDeps): Promise<Seed> => {
  const storeA = randomUUID();
  const storeB = randomUUID();
  await insertSellerAndStore(raw, randomUUID(), storeA, "store-a", "A");
  await insertSellerAndStore(raw, randomUUID(), storeB, "store-b", "B");
  const stores = new StoreService(deps);
  for (const id of [storeA, storeB]) {
    const p = owner(id);
    const s = await stores.getOwn(p, id);
    await stores.update(p, id, s.version, { tagline_ar: "أفضل العروض" });
  }
  const listings = new ListingService(deps);
  const a = owner(storeA);
  let p = await listings.createDraft(a, storeA, { condition_grade_code: "new_with_imperfections", primary_category_id: CATEGORY });
  p = await listings.updateDetails(a, storeA, p.id, p.version, {
    title_ar: "فستان صيفي",
    title_en: "Summer dress",
    description_ar: "فستان قطن مريح",
    primary_category_id: CATEGORY,
    attributes: { colour: "black", material: "cotton", size_run: [{ label: "S", cm: 88 }, { label: "M", cm: 94 }] },
  });
  p = await listings.setConditionAndMedia(a, storeA, p.id, p.version, {
    media: [
      { media_id: randomUUID(), role: "main", position: 0 },
      { media_id: randomUUID(), role: "condition", position: 1 },
    ],
    condition_grade_code: "new_with_imperfections",
  });
  const defects = new DefectService(deps);
  await defects.putDefectCard(a, storeA, p.id, p.version, {
    summary_ar: "بقعة صغيرة على الكم",
    affects_function: false,
    items: [{ defect_type_code: "stain", location_ar: "الكم الأيسر", severity: "minor", affects_function: false, photo_media_id: randomUUID(), size_mm: 12 }],
  });
  await new VariantService(deps).create(a, storeA, p.id, { seller_sku: "SKU-A-1", option_values: { size: "M", colour: "black" }, price: { amount_minor: "129900", currency: "EGP" } });
  const cur = await listings.get(a, storeA, p.id);
  const live = await listings.activate(a, storeA, p.id, cur.version);
  const passport = await defects.issuePassport(a, storeA, { productId: p.id, skuId: live.skus[0]?.id ?? "" });
  const sku = live.skus[0]?.id ?? "";
  await raw.query("INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)", [randomUUID(), storeA]);
  await raw.query("INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) SELECT $1, id, $2, 'EG', 50 FROM inventory_locations WHERE store_id = $2", [sku, storeA]);
  return { storeA, storeB, slugA: "store-a", slugB: "store-b", productA: p.id, passportA: passport.passportCode, categoryId: CATEGORY, skuA: live.skus[0]?.id ?? "" };
};

/** Device attestation fake: accepts everything unless `reject` is set; records what it saw. */
export class FakeDeviceAttestation implements DeviceAttestationPort {
  reject = false;
  readonly seen: { platform: string; installId: string; token: string | undefined }[] = [];
  verify(i: { platform: "web" | "ios" | "android"; installId: string; token: string | undefined }): Promise<boolean> {
    this.seen.push(i);
    return Promise.resolve(!this.reject);
  }
}

export class FakeSms implements SmsSender {
  readonly provider = "fake";
  readonly sent: { phoneE164: string; code: string }[] = [];
  send(m: { phoneE164: string; code: string }): Promise<void> {
    this.sent.push({ phoneE164: m.phoneE164, code: m.code });
    return Promise.resolve();
  }
  last(): string {
    return this.sent[this.sent.length - 1]?.code ?? "";
  }
}

export const RP_ID = "outlet.test";
export const RP_ORIGIN = "https://outlet.test";

export interface TestAppOptions extends CreateAppOptions {
  readonly http?: Partial<HttpConfig>;
  readonly rateLimiter?: RateLimiterPort;
  readonly idempotency?: IdempotencyPort;
  readonly killSwitches?: KillSwitchPort;
  readonly catalog?: (marketId: string) => CatalogServices;
}

/** NestJS + Fastify app on PGlite with the ADR-0011 roles bootstrapped; the API runs as outlet_app. */
export const createTestApp = async (opts: TestAppOptions = {}): Promise<TestApp> => {
  const { client: raw, close: closeDb } = await createTestClient();
  const counter = new QueryCounter();
  const appClient = counter.wrap(roleClient(raw, "outlet_app"));
  const clock = { now: T0 };
  let tick = T0;
  const catalogDeps: CatalogDeps = { client: appClient, marketId: DB_MARKET, now: () => new Date((tick += 1000)) };
  const seed = await seedCatalog(raw, { ...catalogDeps, client: roleClient(raw, "outlet_app") });

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const authClient = roleClient(raw, "outlet_auth");
  const sessions = new SessionService(authClient, { marketId: DB_MARKET, issuer: ISSUER, audience: AUDIENCE, kid: KID, privateKey, publicKey, refreshGraceKey: new Uint8Array(32).fill(3) });
  const tokens = new SessionTokenVerifier(new Map([[DB_MARKET, { audience: AUDIENCE, verifyAccessToken: (jwt: string, now?: Date) => sessions.verifyAccessToken(jwt, now) }]]));
  const memberships = new InMemoryStoreMemberships();
  const flags = new InMemoryFlagStore();
  const flagService = new FlagService({ store: flags, audit: { record: () => Promise.resolve() }, now: () => clock.now });
  const logs: string[] = [];
  const services: CatalogServices = {
    publicCatalog: new PublicCatalogService(catalogDeps),
    defects: new DefectService(catalogDeps),
    listings: new ListingService(catalogDeps),
    variants: new VariantService(catalogDeps),
    attributeSets: new AttributeSetReader({ client: appClient, marketId: DB_MARKET }),
    media: new MediaService({ app: appClient, worker: roleClient(raw, "outlet_worker"), storage: new InMemoryStorage(), scanner: new FakeAvScanner(), signer: new HmacSigner("test"), marketId: DB_MARKET, now: () => new Date(clock.now) }),
    discovery: new DiscoveryReader({ client: appClient, marketId: DB_MARKET }),
    deals: new DealsReader({
      client: appClient,
      marketId: DB_MARKET,
      now: () => new Date(clock.now),
      priceWatchKilled: () => (opts.killSwitches ?? flagService).isKilled(PRICE_WATCH_KILL_SWITCH, { marketId: DB_MARKET }).catch(() => true),
    }),
  };
  const now = (): Date => new Date(clock.now);
  const authDeps = createAuthDeps({ hmacKey: new Uint8Array(32).fill(7), cipherKey: new Uint8Array(32).fill(9), cipher: new AesGcmFieldCipher(new Uint8Array(32).fill(9)) });
  const sms = new FakeSms();
  const attestation = new FakeDeviceAttestation();
  const passkeyStore = new InMemoryPasskeyStore();
  const auth = {
    otp: new OtpService(authClient, authDeps, new InMemoryRateLimiter(), sms),
    sessions,
    sessionReader: new SessionReader(appClient, DB_MARKET),
    devices: { register: (i: { platform: "web" | "ios" | "android"; installId: string; now: Date }) => registerDevice(authClient, authDeps.hasher, { marketId: DB_MARKET, ...i }) },
    oidc: new UnconfiguredOidc(),
    attestation,
    passkeys: new WebAuthnPasskeys({ marketId: DB_MARKET, rpName: "Outlex", rpId: RP_ID, origins: [RP_ORIGIN], challengeTtlMs: 5 * 60_000, now }, passkeyStore, new PgChallengeStore(authClient)),
  };
  const fake = new FakePaymentProvider();
  const paymobShaped: PaymentProviderPort = {
    provider: "paymob",
    supports: (m) => fake.supports(m),
    createIntent: (r, k) => fake.createIntent(r, k),
    voidIntent: (r, k) => fake.voidIntent(r, k),
    verifyWebhook: (i) => fake.verifyWebhook(i),
  };
  const fakes = { provider: fake, shipping: new FakeShipping(), risk: new FakeRisk(), kill: new FakeKillSwitches(), cod: { valid: new Set(["123456"]) }, courier: new FakeCourier(), delivery: new InMemoryBuyerDelivery() };
  const common = {
    marketId: DB_MARKET, now, config: defaultConfig({ provider: "paymob" }), reservations: new ReservationService({ client: appClient, marketId: DB_MARKET, now }), provider: paymobShaped,
    shipping: fakes.shipping, address: new FakeAddress(), risk: fakes.risk, commission: new FakeCommission(), taxCategories: new FakeTaxCategories(),
    taxRates: InMemoryTaxRateProvider.withMarketDefaults(["eg"]), credit: new PgStoreCredit("EGP"), tokens: new HmacQuoteTokens(), prices: new FakePrices(), killSwitches: fakes.kill,
    subMerchants: new FakeSubMerchants(), billing: new FakeBilling(), refunds: new RecordingRefunds(),
    promotions: makePromotionsPort({ client: appClient, marketId: DB_MARKET, kill: { isEnabled: () => Promise.resolve(true) }, now }),
    // The checkout suites address a fake ref (FakeAddress); only a real address-book row is snapshotted, so those suites keep their shape. Real addresses are covered in post-order.test.ts.
    addressSnapshots: {
      snapshotForOrder: async (u: string, so: string, a: string): Promise<void> => {
        const svc = new AddressService({ client: appClient, marketId: DB_MARKET, now }, new ShippingFakeCipher());
        const real = await svc.get(u, a).then(() => true, () => false);
        if (real) await svc.snapshotForOrder(u, so, a);
      },
    },
  };
  const checkoutServices = {
    checkout: new CheckoutService({ ...common, client: appClient }),
    webhooks: new WebhookProcessor({ ...common, client: roleClient(raw, "outlet_worker"), cipher: new FakeCipher() }),
    orders: new OrderGroupReader(appClient, DB_MARKET),
    cod: { verify: (i: { code: string }) => Promise.resolve(fakes.cod.valid.has(i.code)) },
    provider: "paymob" as const,
  };
  const cartServices = { cart: new CartService({ client: appClient, marketId: DB_MARKET, now, availability: pgInventoryAvailability(appClient, DB_MARKET) }), suggestions: noSuggestions };
  const sellerOrderServices = {
    orders: new SellerOrderService({
      client: appClient, marketId: DB_MARKET, now, newId: () => randomUUIDv7(), outbox: new OutboxWriter(pgTransactionalWriter), delivery: fakes.delivery, courier: fakes.courier,
      paymentKinds: new PgPaymentKind(appClient, DB_MARKET), courierCode: "fake", serviceLevel: "standard",
    }),
  };
  const sellerInventoryServices = {
    inventory: new SellerInventoryService({ client: appClient, marketId: DB_MARKET, inventory: new InventoryService({ client: appClient, marketId: DB_MARKET, now }), newId: () => randomUUID(), now }),
  };
  const post = buildPostOrder({
    marketId: DB_MARKET, now, app: appClient, auth: brandClient<"outlet_auth">(authClient), worker: roleClient(raw, "outlet_worker"), cipher: authDeps.cipher, hasher: authDeps.hasher,
    closer: new OrderCloseJob({ ...common, client: roleClient(raw, "outlet_worker"), cipher: new FakeCipher() }), courier: fakes.courier,
  });
  const adminAudit = new InMemoryAuditStore();
  const adminServices = {
    access: createAdminAccess({ db: appClient, audit: new AuditChain(adminAudit, { now }), clock: now, thresholdMinor: 0n }),
    approvals: new PgApprovalReader(appClient),
    kyc: new PgKycAdmin(roleClient(raw, "outlet_worker"), new SellerOnboardingService({ app: appClient, auth: authClient, worker: roleClient(raw, "outlet_worker"), marketId: DB_MARKET, cipher: authDeps.cipher, hasher: authDeps.hasher, now }, new UnconfiguredKycCheck())),
    reconciliation: new PgReconciliationReader(roleClient(raw, "outlet_worker")),
  };
  const deps: ApiDeps = {
    admin: () => adminServices,
    auth: () => auth,
    sellerOrders: () => sellerOrderServices,
    sellerInventory: () => sellerInventoryServices,
    addresses: () => post.services.addresses,
    returns: () => post.services.returns,
    tracking: () => post.services.tracking,
    sellerOnboarding: () => post.services.sellerOnboarding,
    cart: () => cartServices,
    checkout: () => checkoutServices,
    webhookIps: staticWebhookIps({ paymob: ["127.0.0.1"], "courier:fake": ["127.0.0.1"] }),
    http: { ...DEFAULT_HTTP_CONFIG, rateLimitKeySecret: "test-secret", ...opts.http },
    clock: { now: () => new Date(clock.now) },
    logger: createLogger({ level: "debug", write: (l) => logs.push(l), now: () => new Date(clock.now) }),
    appClient,
    tokens,
    memberships,
    rateLimiter: opts.rateLimiter ?? new MemoryRateLimiter(() => clock.now),
    idempotency: opts.idempotency ?? new IdempotencyStore(appClient, () => new Date(clock.now)),
    killSwitches: opts.killSwitches ?? flagService,
    catalog: opts.catalog ?? ((m) => {
      if (m !== DB_MARKET) throw new Error(`no catalog for ${m}`);
      return services;
    }),
    lifecycle: { draining: false },
  };
  const { app, routes } = await createApp(deps, opts);

  const mint = async (o: MintOptions = {}): Promise<string> => {
    const iat = Math.floor(clock.now / 1000);
    return new SignJWT({ amr: [...(o.amr ?? ["otp"])], sid: randomUUID() })
      .setProtectedHeader({ alg: "ES256", kid: o.kid ?? KID })
      .setSubject(o.userId ?? randomUUID())
      .setIssuer(o.issuer ?? ISSUER)
      .setAudience(o.audience ?? AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.expiresInS ?? 600))
      .sign(privateKey);
  };
  const seller = async (storeId: string, roles: readonly SellerRole[], amr: readonly string[] = ["otp", "passkey"]): Promise<{ userId: string; token: string }> => {
    const userId = randomUUID();
    memberships.grant(DB_MARKET, userId, storeId, roles);
    return { userId, token: await mint({ userId, amr }) };
  };
  const admin = async (roles: readonly string[], amr: readonly string[] = ["otp", "passkey"]): Promise<{ userId: string; token: string }> => {
    const { userId } = await shopper();
    for (const role of roles) {
      await raw.query(
        "INSERT INTO staff_role_assignments (id, staff_id, role_code, market_id, granted_by, reason, starts_at, expires_at, created_at) VALUES ($1,$2,$3,'EG',$2,'seed','2020-01-01','2100-01-01','2020-01-01')",
        [randomUUID(), userId, role],
      );
    }
    return { userId, token: await mint({ userId, amr }) };
  };
  const shopper = async (): Promise<{ userId: string; token: string }> => {
    const userId = randomUUID();
    const ts = new Date(clock.now).toISOString();
    await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [userId, ts]);
    return { userId, token: await mint({ userId }) };
  };
  const device = (): Promise<string> => registerDevice(authClient, authDeps.hasher, { marketId: DB_MARKET, platform: "web", installId: randomUUID(), now: new Date(clock.now) });
  return {
    app,
    routes,
    sms,
    passkeyStore,
    attestation,
    fakes,
    post: post.fakes,
    shopper,
    admin,
    adminAudit,
    device,
    raw,
    counter,
    memberships,
    flags,
    logs,
    seed,
    clock,
    mint,
    seller,
    inject: (o) => app.getHttpAdapter().getInstance().inject(o),
    close: async () => {
      await app.close();
      await closeDb();
    },
  };
};

/**
 * A UUIDv7 with the given unix-ms timestamp and random tail. Built by hand on purpose: @outlet/ids uuidv7 is
 * monotonic per process, so one far-future key would push every later key into the future.
 */
export const v7At = (ms: number): string => {
  const t = ms.toString(16).padStart(12, "0");
  const r = randomUUID().replaceAll("-", "");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-${(8 + (parseInt(r.slice(3, 4), 16) % 4)).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
};

/** A fresh UUIDv7 Idempotency-Key minted at the test clock. */
export const idemKey = (t: TestApp, offsetMs = 0): string => v7At(t.clock.now + offsetMs);

export const DEVICE = "0f6f1d2e-3c4b-4a59-8e7f-1a2b3c4d5e6f";

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
