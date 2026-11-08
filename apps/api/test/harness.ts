import { randomUUID } from "node:crypto";
import { SessionService } from "@outlet/auth-core";
import { DefectService, ListingService, PublicCatalogService, StoreService, VariantService } from "@outlet/catalog";
import type { CatalogDeps } from "@outlet/catalog";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { FlagService, InMemoryFlagStore } from "@outlet/flags";
import { PRICE_WATCH_KILL_SWITCH } from "@outlet/pricing-integrity";
import { IdempotencyStore } from "@outlet/idempotency";
import { createLogger } from "@outlet/logger";
import type { Principal } from "@outlet/policy";
import { SignJWT, generateKeyPair } from "jose";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { createApp } from "../src/app.js";
import { DealsReader } from "../src/modules/catalog-public/deals-reader.js";
import { DiscoveryReader } from "../src/modules/catalog-public/discovery-reader.js";
import type { ApiApp, CreateAppOptions } from "../src/app.js";
import { InMemoryStoreMemberships, SessionTokenVerifier } from "../src/platform/auth-ports.js";
import type { SellerRole } from "../src/platform/auth-ports.js";
import { DEFAULT_HTTP_CONFIG } from "../src/platform/deps.js";
import type { ApiDeps, CatalogServices, HttpConfig, IdempotencyPort, KillSwitchPort } from "../src/platform/deps.js";
import { MemoryRateLimiter } from "../src/platform/rate-limit/memory.js";
import type { RateLimiterPort } from "../src/platform/rate-limit/port.js";

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
}

export interface TestApp extends ApiApp {
  readonly raw: SqlClient;
  readonly counter: QueryCounter;
  readonly memberships: InMemoryStoreMemberships;
  readonly flags: InMemoryFlagStore;
  readonly logs: string[];
  readonly seed: Seed;
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
  return { storeA, storeB, slugA: "store-a", slugB: "store-b", productA: p.id, passportA: passport.passportCode, categoryId: CATEGORY };
};

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
  const sessions = new SessionService(raw, { marketId: DB_MARKET, issuer: ISSUER, audience: AUDIENCE, kid: KID, privateKey, publicKey });
  const tokens = new SessionTokenVerifier(new Map([[DB_MARKET, { audience: AUDIENCE, verifyAccessToken: (jwt: string, now?: Date) => sessions.verifyAccessToken(jwt, now) }]]));
  const memberships = new InMemoryStoreMemberships();
  const flags = new InMemoryFlagStore();
  const flagService = new FlagService({ store: flags, audit: { record: () => Promise.resolve() }, now: () => clock.now });
  const logs: string[] = [];
  const services: CatalogServices = {
    publicCatalog: new PublicCatalogService(catalogDeps),
    defects: new DefectService(catalogDeps),
    listings: new ListingService(catalogDeps),
    discovery: new DiscoveryReader({ client: appClient, marketId: DB_MARKET }),
    deals: new DealsReader({
      client: appClient,
      marketId: DB_MARKET,
      now: () => new Date(clock.now),
      priceWatchKilled: () => (opts.killSwitches ?? flagService).isKilled(PRICE_WATCH_KILL_SWITCH, { marketId: DB_MARKET }).catch(() => true),
    }),
  };
  const deps: ApiDeps = {
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
  return {
    app,
    routes,
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
