import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { AddressValidator, ShippingQuoteService, StoreShippingSettingsService } from "../src/index.js";

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly quotes: ShippingQuoteService;
  readonly validator: AddressValidator;
  readonly settings: StoreShippingSettingsService;
  readonly user: string;
  readonly storeA: string;
  readonly storeB: string;
  readonly now: { value: Date };
  readonly intl: { enabled: boolean };
  readonly area: (code: string) => Promise<string>;
  readonly cover: (courier: string, areaCode: string, o?: { sla?: number; cod?: boolean; service?: string; active?: boolean }) => Promise<void>;
  readonly rate: (courier: string, zone: string, bands: readonly [number, number, number][], o?: { from?: string; to?: string | null; version?: number; service?: string; step?: number }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const staffOf = (storeId: string): Principal => ({ kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds: [storeId], roles: ["owner"], scopes: [] });

export const buildWorld = async (): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const app = roleClient(raw, "outlet_app");
  const user = randomUUID();
  await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',now(),now())", [user]);
  const mkStore = async (slug: string): Promise<string> => {
    const sellerId = randomUUID();
    const storeId = randomUUID();
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company','شركة','Company',$2,$3,'CAI','القاهرة','active')`,
      [sellerId, `CR-${slug}`, `TX-${slug}`],
    );
    await raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`, [storeId, sellerId, slug, `متجر ${slug}`]);
    return storeId;
  };
  const storeA = await mkStore("ship-a");
  const storeB = await mkStore("ship-b");
  const now = { value: new Date("2030-06-01T00:00:00.000Z") };
  const intl = { enabled: false };
  const deps = { client: app, marketId: "EG", now: () => now.value, isInternationalEnabled: () => Promise.resolve(intl.enabled) };
  const area = async (code: string): Promise<string> => {
    const r = await raw.query<{ id: string }>("SELECT id FROM geo_areas WHERE market_id = 'EG' AND code = $1", [code]);
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error(`no area ${code}`);
    return id;
  };
  return {
    raw, app, user, storeA, storeB, now, intl, area, close,
    quotes: new ShippingQuoteService(deps),
    validator: new AddressValidator(deps),
    settings: new StoreShippingSettingsService(deps),
    cover: async (courier, areaCode, o = {}) => {
      await raw.query(
        "INSERT INTO courier_coverage (id, market_id, courier, geo_area_id, service_level, sla_days_p80, cod_supported, active) VALUES ($1,'EG',$2,$3,$4,$5,$6,$7)",
        [randomUUID(), courier, await area(areaCode), o.service ?? "standard", o.sla ?? 3, o.cod ?? false, o.active ?? true],
      );
    },
    rate: async (courier, zone, bands, o = {}) => {
      for (const [from, to, price] of bands) {
        await raw.query(
          `INSERT INTO rate_cards (id, market_id, courier, service_level, zone_code, weight_from_g, weight_to_g, weight_step_g, price_minor, currency, version, valid_from, valid_to)
           VALUES ($1,'EG',$2,$3,$4,$5,$6,$7,$8,'EGP',$9,$10,$11)`,
          [randomUUID(), courier, o.service ?? "standard", zone, from, to, o.step ?? 500, price, o.version ?? 1, o.from ?? "2030-01-01T00:00:00Z", o.to ?? null],
        );
      }
    },
  };
};

export const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) {
    if (e instanceof Error && "code" in e && typeof e.code === "string") return e.code;
    throw e;
  }
  return "NO_ERROR";
};

/** TEST ONLY. Counts business statements (context binding excluded). */
export const countStatements = async (client: RoleSqlClient<"outlet_app">, fn: (c: RoleSqlClient<"outlet_app">) => Promise<unknown>): Promise<string[]> => {
  const out: string[] = [];
  const wrap = (q: Queryable): Queryable => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port
    query: <R extends object>(sql: string, params?: readonly unknown[]) => { if (!sql.startsWith("SELECT set_config(")) out.push(sql); return q.query<R>(sql, params); },
  });
  await fn(brandClient<"outlet_app">({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port
    query: <R extends object>(sql: string, params?: readonly unknown[]) => wrap(client).query<R>(sql, params),
    transaction: <U>(f: (tx: Queryable) => Promise<U>) => client.transaction((tx) => f(wrap(tx))),
  }));
  return out;
};
