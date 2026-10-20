import { afterAll, describe, expect, it, vi } from "vitest";
import { addresses } from "@outlet/domain";
import { seedEntries } from "./in-memory";
import { KyselyAddressStore, type AddressDb } from "./kysely-store";
import { createAddressDatabase, type PgliteLike } from "./test/pglite-db";
import { U, describeAddressContract } from "./test/contract";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const open: AddressDb[] = [];
let shared: Promise<{ pg: PgliteLike; db: AddressDb }> | null = null;
const fresh = async () => {
  shared ??= createAddressDatabase();
  const { pg, db } = await shared;
  if (!open.includes(db)) open.push(db);
  await pg.exec(`delete from gift_address_tokens; delete from saved_addresses; alter table delivery_snapshots disable trigger delivery_snapshots_no_update; delete from delivery_snapshots; alter table delivery_snapshots enable trigger delivery_snapshots_no_update; delete from users;`);
  return {
    pg,
    db,
    store: new KyselyAddressStore(db),
    clock: { ms: 1_800_000_000_000 },
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeAddressContract("kysely/pglite", fresh);

describe("0050_addresses specifics", () => {
  it("the SQL seed equals the TypeScript fixtures", async () => {
    const c = await fresh();
    const entries = await c.store.coverage.entries();
    const key = (e: addresses.CoverageEntry): string => `${e.courier}|${e.governorateCode}|${e.cityCode ?? ""}|${e.covered}|${e.codSupported}`;
    expect(entries.map(key).sort()).toEqual(seedEntries().map(key).sort());
    const n = await c.pg.query<{ g: string; c: string }>(`select (select count(*) from coverage_governorates)::text as g, (select count(*) from coverage_cities)::text as c`);
    expect(n.rows[0]).toEqual({ g: "27", c: String(addresses.GOVERNORATE_FIXTURES.reduce((s, g) => s + g[3].length, 0)) });
  });

  it("the database enforces one default per user and rejects dedupe repeats", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const ins = (id: string, def: boolean, blind: string) =>
      c.pg.query(
        `insert into saved_addresses (id, user_id, recipient_name_enc, phone_enc, phone_blind, governorate_code, city_code, street_enc, building_enc, dedupe_blind, courier_coverage, cod_eligible, quality_score, is_default)
         values ($1, $2, '\\x00', '\\x00', '\\x00', 'EG-C', 'maadi', '\\x00', '\\x00', decode($3, 'hex'), 'covered', false, 10, $4)`,
        [id, U(1), blind, def],
      );
    await ins("00000000-0000-7000-8000-000000000001", true, "01");
    await expect(ins("00000000-0000-7000-8000-000000000002", true, "02")).rejects.toThrow();
    await expect(ins("00000000-0000-7000-8000-000000000003", false, "01")).rejects.toThrow();
    await expect(
      c.pg.query(`insert into saved_addresses (id, user_id, recipient_name_enc, phone_enc, phone_blind, governorate_code, city_code, street_enc, building_enc, dedupe_blind, courier_coverage, cod_eligible, quality_score) values ('00000000-0000-7000-8000-000000000009', $1, '\\x00','\\x00','\\x00','EG-C','atlantis','\\x00','\\x00','\\x09','covered',false,1)`, [U(1)]),
    ).rejects.toThrow();
  });

  it("delivery_snapshots reject UPDATE and DELETE", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    await c.pg.exec(
      `insert into delivery_snapshots (id, user_id, order_ref, recipient_name_enc, phone_enc, governorate_code, city_code, street_enc, building_enc, courier_coverage, cod_eligible)
       values ('00000000-0000-7000-8000-0000000000aa', '${U(1)}', 'o1', '\\x00','\\x00','EG-C','maadi','\\x00','\\x00','covered',false)`,
    );
    await expect(c.pg.exec(`update delivery_snapshots set cod_eligible = true`)).rejects.toThrow(/immutable/);
    await expect(c.pg.exec(`delete from delivery_snapshots`)).rejects.toThrow(/immutable/);
  });

  it("row level security: users see only their own rows; other roles see nothing without a user id; coverage is readable", async () => {
    const c = await fresh();
    for (const n of [1, 2]) {
      await c.ensureUser(U(n));
      await c.pg.query(
        `insert into saved_addresses (id, user_id, recipient_name_enc, phone_enc, phone_blind, governorate_code, city_code, street_enc, building_enc, dedupe_blind, courier_coverage, cod_eligible, quality_score)
         values ($1, $2, '\\x00','\\x00','\\x00','EG-C','maadi','\\x00','\\x00', decode($3,'hex'),'covered',false,1)`,
        [`00000000-0000-7000-8000-00000000000${n}`, U(n), `0${n}`],
      );
    }
    const asUser = async (userId: string | null, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(`set role app_user; select set_config('app.user_id', '${userId ?? ""}', false); select set_config('app.role', 'user', false);`);
      try {
        return await c.pg.query(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    expect((await asUser(U(1), `select user_id from saved_addresses`)).rows).toHaveLength(1);
    expect((await asUser(null, `select user_id from saved_addresses`)).rows).toHaveLength(0);
    expect((await asUser(U(2), `update saved_addresses set label = 'x' where user_id = '${U(1)}' returning id`)).rows).toHaveLength(0);
    expect((await asUser(null, `select code from coverage_governorates`)).rows).toHaveLength(27);
    await expect(asUser(U(1), `insert into coverage_governorates (code, name_ar, name_en, position) values ('EG-ZZ','x','y',99)`)).rejects.toThrow();
  });
});
