import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChartRow } from "../domain/bridge";
import type {
  DemandRepository,
  FeedbackRecord,
  FeedbackRepository,
  ProfileRecord,
  SizeChartRepository,
  SizeProfileRepository,
  StoredChart,
} from "../domain/ports";
import {
  InMemoryDemandRepository,
  InMemoryFeedbackRepository,
  InMemorySizeChartRepository,
  InMemorySizeProfileRepository,
} from "../adapters/in-memory";
import {
  KyselyDemandRepository,
  KyselyFeedbackRepository,
  KyselySizeChartRepository,
  KyselySizeProfileRepository,
  isoWeekToMonday,
  mondayToIsoWeek,
  type SizingDb,
} from "../adapters/kysely-store";
import { createSizingDatabase } from "./pglite-db";

let seq = 1000;
/** Time ordered ids: later calls sort after earlier ones, like UUIDv7. */
const uid = (): string => `0192f3a4-5b6c-7d8e-9f01-${String((seq += 1)).padStart(12, "0")}`;

interface Fixture {
  readonly profiles: SizeProfileRepository;
  readonly charts: SizeChartRepository;
  readonly feedback: FeedbackRepository;
  readonly demand: DemandRepository;
  seedUser(): Promise<string>;
  seedStore(): Promise<string>;
}

const WEEK = "2026-W41";
const ROWS: readonly ChartRow[] = [
  { sizeLabel: "S", measurements: { bust_cm: 86, waist_cm: 68 } },
  { sizeLabel: "M", measurements: { bust_cm: 90, waist_cm: 72 } },
] as unknown as readonly ChartRow[];

const profile = (userId: string, over: Partial<ProfileRecord> = {}): ProfileRecord => ({
  id: uid(),
  userId,
  kind: "me",
  labelEnc: new Uint8Array([1, 2, 3, 4]),
  measurementsEnc: new Uint8Array([9, 8, 7]),
  quickStartEnc: null,
  fitPreference: "regular",
  modestFit: false,
  version: 1,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  ...over,
});

const chart = (storeId: string, version: number, validated = true, productType = "tops"): StoredChart => ({
  id: uid(),
  storeId,
  productType,
  chartVersion: version,
  unitEntered: "cm",
  rows: ROWS,
  validated,
  validationErrors: validated ? [] : [{ sizeLabel: "S", code: "empty_chart" } as never],
  createdAtMs: 1_800_000_000_000,
});

function runContract(name: string, make: () => Promise<Fixture>): void {
  describe(`${name} sizing repositories`, () => {
    describe("profiles", () => {
      it("round trips ciphertext and scopes reads to the owner", async () => {
        const f = await make();
        const a = await f.seedUser();
        const b = await f.seedUser();
        const p = profile(a);
        await f.profiles.insert(p);
        const got = await f.profiles.get(a, p.id);
        expect(got).not.toBeNull();
        expect([...(got?.labelEnc ?? [])]).toEqual([1, 2, 3, 4]);
        expect([...(got?.measurementsEnc ?? [])]).toEqual([9, 8, 7]);
        expect(got?.quickStartEnc).toBeNull();
        expect(got?.fitPreference).toBe("regular");
        expect(got?.kind).toBe("me");
        expect(await f.profiles.get(b, p.id)).toBeNull();
        expect(await f.profiles.countLive(a)).toBe(1);
        expect(await f.profiles.countLive(b)).toBe(0);
      });

      it("paginates by id and rejects foreign or malformed cursors", async () => {
        const f = await make();
        const a = await f.seedUser();
        const b = await f.seedUser();
        const mine = [profile(a), profile(a), profile(a)];
        for (const p of mine) await f.profiles.insert(p);
        const other = profile(b);
        await f.profiles.insert(other);
        const first = await f.profiles.list(a, { cursor: null, limit: 2 });
        if (first === "invalid_cursor") throw new Error("unexpected");
        expect(first.items.map((x) => x.id)).toEqual([mine[0]?.id, mine[1]?.id]);
        expect(first.nextCursor).not.toBeNull();
        const second = await f.profiles.list(a, { cursor: first.nextCursor, limit: 2 });
        if (second === "invalid_cursor") throw new Error("unexpected");
        expect(second.items.map((x) => x.id)).toEqual([mine[2]?.id]);
        expect(second.nextCursor).toBeNull();
        const foreign = Buffer.from(other.id, "utf8").toString("base64url");
        expect(await f.profiles.list(a, { cursor: foreign, limit: 2 })).toBe("invalid_cursor");
        expect(await f.profiles.list(a, { cursor: "!!", limit: 2 })).toBe("invalid_cursor");
      });

      it("update is optimistic: stale version conflicts, other owner is not found", async () => {
        const f = await make();
        const a = await f.seedUser();
        const b = await f.seedUser();
        const p = profile(a);
        await f.profiles.insert(p);
        const next = { ...p, version: 2, modestFit: true, fitPreference: "loose" as const };
        expect(await f.profiles.update(next, 1)).toBe("updated");
        expect((await f.profiles.get(a, p.id))?.modestFit).toBe(true);
        expect((await f.profiles.get(a, p.id))?.fitPreference).toBe("loose");
        expect(await f.profiles.update({ ...next, version: 3 }, 1)).toBe("conflict");
        expect(await f.profiles.update({ ...next, userId: b, version: 3 }, 2)).toBe("not_found");
        expect(await f.profiles.update({ ...next, id: uid(), version: 3 }, 2)).toBe("not_found");
      });

      it("delete is owner scoped, hides the profile and is not repeatable", async () => {
        const f = await make();
        const a = await f.seedUser();
        const b = await f.seedUser();
        const p = profile(a);
        await f.profiles.insert(p);
        expect(await f.profiles.delete(b, p.id)).toBe(false);
        expect(await f.profiles.delete(a, p.id)).toBe(true);
        expect(await f.profiles.get(a, p.id)).toBeNull();
        expect(await f.profiles.countLive(a)).toBe(0);
        expect(await f.profiles.delete(a, p.id)).toBe(false);
      });
    });

    describe("charts", () => {
      it("versions per store and product type and returns the highest validated", async () => {
        const f = await make();
        const s = await f.seedStore();
        const t = await f.seedStore();
        expect(await f.charts.nextVersion(s, "tops")).toBe(1);
        await f.charts.insert(chart(s, 1));
        await f.charts.insert(chart(s, 2, false));
        expect(await f.charts.nextVersion(s, "tops")).toBe(3);
        expect(await f.charts.nextVersion(s, "dresses")).toBe(1);
        expect(await f.charts.nextVersion(t, "tops")).toBe(1);
        expect((await f.charts.latestValidated(s, "tops"))?.chartVersion).toBe(1);
        expect(await f.charts.latestValidated(t, "tops")).toBeNull();
        const got = await f.charts.latestValidated(s, "tops");
        expect(got?.rows).toEqual(ROWS);
        expect(got?.unitEntered).toBe("cm");
      });

      it("lists one tenant only, with cursors", async () => {
        const f = await make();
        const s = await f.seedStore();
        const t = await f.seedStore();
        const c1 = chart(s, 1);
        const c2 = chart(s, 2);
        const c3 = chart(s, 3);
        for (const c of [c1, c2, c3, chart(t, 1)]) await f.charts.insert(c);
        const first = await f.charts.listForStore(s, { cursor: null, limit: 2 });
        if (first === "invalid_cursor") throw new Error("unexpected");
        expect(first.items.map((x) => x.id)).toEqual([c1.id, c2.id]);
        const second = await f.charts.listForStore(s, { cursor: first.nextCursor, limit: 2 });
        if (second === "invalid_cursor") throw new Error("unexpected");
        expect(second.items.map((x) => x.id)).toEqual([c3.id]);
        expect(await f.charts.listForStore(t, { cursor: first.nextCursor, limit: 2 })).toBe("invalid_cursor");
      });

      it("a failed validation keeps its errors", async () => {
        const f = await make();
        const s = await f.seedStore();
        const bad = chart(s, 1, false);
        await f.charts.insert(bad);
        const r = await f.charts.listForStore(s, { cursor: null, limit: 5 });
        if (r === "invalid_cursor") throw new Error("unexpected");
        expect(r.items[0]?.validated).toBe(false);
        expect(r.items[0]?.validationErrors).toHaveLength(1);
      });
    });

    describe("feedback", () => {
      const fb = (userId: string, over: Partial<FeedbackRecord>): FeedbackRecord => ({
        id: uid(),
        orderLineId: uid(),
        userId,
        profileId: null,
        productId: uid(),
        brandId: uid(),
        productType: "tops",
        sizeChartId: null,
        sizeLabel: "M",
        rating: "ok",
        area: null,
        submittedAtMs: 1_800_000_000_000,
        ...over,
      });

      it("is unique per order line", async () => {
        const f = await make();
        const u = await f.seedUser();
        const r = fb(u, {});
        expect(await f.feedback.insert(r)).toBe("created");
        expect(await f.feedback.insert({ ...r, id: uid(), rating: "too_small" })).toBe("duplicate");
      });

      it("counts the user's own brand history only", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        const brand = uid();
        await f.feedback.insert(fb(u, { brandId: brand, rating: "too_small", area: "chest" }));
        await f.feedback.insert(fb(u, { brandId: brand, rating: "too_small" }));
        await f.feedback.insert(fb(u, { brandId: brand, rating: "too_large" }));
        await f.feedback.insert(fb(u, { brandId: brand, rating: "ok" }));
        await f.feedback.insert(fb(u, { brandId: uid(), rating: "too_small" }));
        await f.feedback.insert(fb(v, { brandId: brand, rating: "too_small" }));
        expect(await f.feedback.historyFor(u, brand)).toEqual({ tooSmall: 2, tooLarge: 1 });
        expect(await f.feedback.historyFor(v, brand)).toEqual({ tooSmall: 1, tooLarge: 0 });
      });

      it("aggregates item counters across users for one chart", async () => {
        const f = await make();
        const s = await f.seedStore();
        const c = chart(s, 1);
        await f.charts.insert(c);
        const other = chart(s, 2);
        await f.charts.insert(other);
        const product = uid();
        for (const rating of ["too_small", "too_small", "ok", "too_large"] as const) {
          await f.feedback.insert(fb(await f.seedUser(), { productId: product, sizeChartId: c.id, rating }));
        }
        await f.feedback.insert(fb(await f.seedUser(), { productId: product, sizeChartId: other.id, rating: "ok" }));
        expect(await f.feedback.itemCounts(product, c.id)).toEqual({ nSmall: 2, nOk: 1, nLarge: 1 });
        expect(await f.feedback.itemCounts(product, other.id)).toEqual({ nSmall: 0, nOk: 1, nLarge: 0 });
      });

      it("detaching a profile keeps the aggregate", async () => {
        const f = await make();
        const u = await f.seedUser();
        const p = profile(u);
        await f.profiles.insert(p);
        const brand = uid();
        await f.feedback.insert(fb(u, { brandId: brand, profileId: p.id, rating: "too_small" }));
        await f.feedback.detachProfile(u, p.id);
        expect(await f.feedback.historyFor(u, brand)).toEqual({ tooSmall: 1, tooLarge: 0 });
      });
    });

    describe("demand", () => {
      it("counts DISTINCT shoppers: repeats never raise the count", async () => {
        const f = await make();
        const s = await f.seedStore();
        for (let i = 0; i < 5; i += 1) await f.demand.record(s, "tops", "M", WEEK, "shopper-1");
        await f.demand.record(s, "tops", "M", WEEK, "shopper-2");
        await f.demand.record(s, "tops", "S", WEEK, "shopper-1");
        const cells = await f.demand.cellsForStore(s);
        const m = cells.find((c) => c.sizeLabel === "M");
        expect(m).toEqual({ productType: "tops", sizeLabel: "M", week: WEEK, demandCount: 2 });
        expect(cells.find((c) => c.sizeLabel === "S")?.demandCount).toBe(1);
      });

      it("is tenant scoped and keeps weeks apart", async () => {
        const f = await make();
        const s = await f.seedStore();
        const t = await f.seedStore();
        await f.demand.record(s, "tops", "M", WEEK, "x");
        await f.demand.record(s, "tops", "M", "2026-W42", "x");
        await f.demand.record(t, "tops", "M", WEEK, "x");
        expect((await f.demand.cellsForStore(s)).map((c) => c.week).sort()).toEqual([WEEK, "2026-W42"]);
        expect(await f.demand.cellsForStore(t)).toHaveLength(1);
      });
    });
  });
}

describe("ISO week helpers", () => {
  it("round trips across a year boundary", () => {
    expect(isoWeekToMonday("2026-W41")).toBe("2026-10-05");
    expect(mondayToIsoWeek("2026-10-05")).toBe("2026-W41");
    expect(isoWeekToMonday("2026-W01")).toBe("2025-12-29");
    expect(mondayToIsoWeek("2025-12-29")).toBe("2026-W01");
    expect(() => isoWeekToMonday("2026-41")).toThrow();
  });
});

runContract("in-memory", async () => ({
  profiles: new InMemorySizeProfileRepository(),
  charts: new InMemorySizeChartRepository(),
  feedback: new InMemoryFeedbackRepository(),
  demand: new InMemoryDemandRepository(),
  seedUser: async () => uid(),
  seedStore: async () => uid(),
}));

describe("kysely on PGlite", () => {
  let db: SizingDb;
  let pg: Awaited<ReturnType<typeof createSizingDatabase>>["pg"];
  const key = new Uint8Array(32).fill(7);
  let storeN = 0;

  beforeAll(async () => {
    ({ db, pg } = await createSizingDatabase());
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
  });

  const seedUser = async (): Promise<string> => {
    const id = uid();
    await pg.query(`insert into users (id) values ($1)`, [id]);
    return id;
  };
  const seedStore = async (): Promise<string> => {
    const id = uid();
    storeN += 1;
    await pg.query(
      `insert into stores (id, seller_id, kind, slug, name_ar, status, seller_kyc_state)
       values ($1, $2, 'local', $3, 'متجر', 'ACTIVE', 'APPROVED')`,
      [id, uid(), `store-${storeN}`],
    );
    return id;
  };
  const kysely = async (): Promise<Fixture> => ({
    profiles: new KyselySizeProfileRepository(db),
    charts: new KyselySizeChartRepository(db),
    feedback: new KyselyFeedbackRepository(db),
    demand: new KyselyDemandRepository(db, key),
    seedUser,
    seedStore,
  });

  // Registered lazily: the factory closes over `db`, which beforeAll fills in.
  runContract("kysely", kysely);

  describe("kysely specifics", () => {
    it("erases the ciphertext of a deleted profile", async () => {
      const repo = new KyselySizeProfileRepository(db);
      const u = await seedUser();
      const p = profile(u);
      await repo.insert(p);
      expect(await repo.delete(u, p.id)).toBe(true);
      const r = await pg.query<{ label_len: number; m: unknown; deleted: boolean }>(
        `select octet_length(label) as label_len, measurements as m, deleted_at is not null as deleted from size_profiles where id = $1`,
        [p.id],
      );
      expect(r.rows[0]).toEqual({ label_len: 0, m: null, deleted: true });
    });

    it("refuses a seventh live profile (database cap)", async () => {
      const repo = new KyselySizeProfileRepository(db);
      const u = await seedUser();
      for (let i = 0; i < 6; i += 1) await repo.insert(profile(u));
      await expect(repo.insert(profile(u))).rejects.toThrow();
      expect(await repo.countLive(u)).toBe(6);
    });

    it("rolls up only cells with at least 50 distinct shoppers", async () => {
      const demand = new KyselyDemandRepository(db, key);
      const s = await seedStore();
      for (let i = 0; i < 50; i += 1) await demand.record(s, "tops", "M", "2026-W30", `shopper-${i}`);
      for (let i = 0; i < 49; i += 1) await demand.record(s, "tops", "S", "2026-W30", `shopper-${i}`);
      // 200 requests by one shopper must not make a cell publishable.
      for (let i = 0; i < 200; i += 1) await demand.record(s, "tops", "L", "2026-W30", "single");
      expect(await demand.materializeAggregates("2026-W30")).toBeGreaterThanOrEqual(1);
      const r = await pg.query<{ size_label: string; demand_count: number }>(
        `select size_label, demand_count from seller_size_demand_agg where store_id = $1`,
        [s],
      );
      expect(r.rows).toEqual([{ size_label: "M", demand_count: 50 }]);
      await expect(demand.materializeAggregates("2026-W30", 10)).rejects.toThrow(RangeError);
    });

    it("never stores the plain shopper id", async () => {
      const demand = new KyselyDemandRepository(db, key);
      const s = await seedStore();
      await demand.record(s, "tops", "M", WEEK, "plain-shopper-id");
      const r = await pg.query<{ shopper_hash: string }>(`select shopper_hash from size_demand_events where store_id = $1`, [s]);
      expect(r.rows[0]?.shopper_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.rows[0]?.shopper_hash).not.toContain("plain");
    });
  });
});
