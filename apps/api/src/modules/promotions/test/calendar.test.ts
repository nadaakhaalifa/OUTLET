import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { InMemoryCalendarStore } from "../adapters/calendar-in-memory";
import { KyselyCalendarStore } from "../adapters/calendar-kysely";
import type { PromotionDb } from "../adapters/kysely-store";
import type { CalendarAuditEntry, CalendarEvent, CalendarStore } from "../domain/calendar";
import { ADMIN_SCOPES, adminGrants, createPromotionsHarness, login, uid, type PromotionsHarness } from "./promotions-harness";
import { CALENDAR_MIGRATION_SQL, promotionsDatabase } from "./pglite-db";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const ev = (n: number, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: U(n), kind: "mega_event", titleAr: "الجمعة البيضاء", titleEn: "White Friday", note: null, startsAtMs: T0 + n * 1000, endsAtMs: T0 + n * 1000 + 86_400_000,
  status: "planned", version: 1, createdBy: U(900), updatedBy: U(900), createdAtMs: T0, updatedAtMs: T0, ...over,
});
const audit = (e: CalendarEvent, n: number, before: CalendarEvent | null = null): CalendarAuditEntry => ({
  id: U(5000 + n), eventId: e.id, actorId: U(900), action: before === null ? "created" : "updated", before, after: e, atMs: T0,
});

const open: Kysely<Record<string, never>>[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

function contract(name: string, fresh: () => Promise<CalendarStore>): void {
  describe(`CalendarStore contract: ${name}`, () => {
    it("creates once, refuses a duplicate id, and audits atomically", async () => {
      const s = await fresh();
      expect(await s.save(ev(1), null, audit(ev(1), 1))).toBe("ok");
      expect(await s.save(ev(1), null, audit(ev(1), 2))).toBe("exists");
      expect((await s.auditFor(U(1))).map((a) => a.action)).toEqual(["created"]);
      expect(await s.get(U(1))).toMatchObject({ titleAr: "الجمعة البيضاء", version: 1, startsAtMs: ev(1).startsAtMs });
      expect(await s.get(U(99))).toBeNull();
    });
    it("updates with optimistic version and rejects a stale one without writing audit", async () => {
      const s = await fresh();
      await s.save(ev(1), null, audit(ev(1), 1));
      const v2 = ev(1, { version: 2, titleEn: "Changed" });
      expect(await s.save(v2, 1, audit(v2, 2, ev(1)))).toBe("ok");
      expect(await s.save(ev(1, { version: 2 }), 1, audit(v2, 3, ev(1)))).toBe("conflict");
      expect(await s.save(ev(7, { version: 2 }), 1, audit(ev(7), 4))).toBe("conflict");
      expect(await s.auditFor(U(1))).toHaveLength(2);
      expect((await s.get(U(1)))?.titleEn).toBe("Changed");
    });
    it("lists newest start first with keyset paging and a range filter", async () => {
      const s = await fresh();
      for (const n of [1, 2, 3]) await s.save(ev(n), null, audit(ev(n), n));
      const p1 = await s.list({ fromMs: null, toMs: null, after: null, limit: 2 });
      expect(p1.map((e) => e.id)).toEqual([U(3), U(2)]);
      const p2 = await s.list({ fromMs: null, toMs: null, after: { ms: ev(2).startsAtMs, id: U(2) }, limit: 2 });
      expect(p2.map((e) => e.id)).toEqual([U(1)]);
      const ranged = await s.list({ fromMs: null, toMs: T0 + 1500, after: null, limit: 10 });
      expect(ranged.map((e) => e.id)).toEqual([U(1)]);
    });
  });
}

contract("in-memory", async () => new InMemoryCalendarStore());
contract("kysely/pglite", async () => {
  const raw = await promotionsDatabase();
  const db: PromotionDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return new KyselyCalendarStore(db);
});

it("calendar migration passes the expand-only linter", () => {
  expect(lintMigration(CALENDAR_MIGRATION_SQL)).toEqual([]);
});

describe("GET/PUT /v1/admin/calendar", () => {
  let h: PromotionsHarness;
  let admin: string;
  let noPasskey: string;
  let wrongRole: string;
  let noScope: string;
  let shopperOnAdmin: string;
  let sellerTok: string;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const idem = () => ({ "Idempotency-Key": uid(7) });
  const body = (over: Record<string, unknown> = {}) => ({
    id: U(40), kind: "mega_event", title_ar: "الجمعة البيضاء", title_en: "White Friday",
    starts_at: "2026-11-27T00:00:00Z", ends_at: "2026-11-30T00:00:00Z", ...over,
  });

  beforeAll(async () => {
    h = await createPromotionsHarness();
    const user = await login(h, "+201005599310");
    admin = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: ADMIN_SCOPES, passkey: true });
    noPasskey = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: ADMIN_SCOPES, passkey: false });
    wrongRole = await h.mint(user, { audience: "admin_api", grants: adminGrants("finance"), scopes: ADMIN_SCOPES, passkey: true });
    noScope = await h.mint(user, { audience: "admin_api", grants: adminGrants("marketing"), scopes: [], passkey: true });
    shopperOnAdmin = await h.mint(user, { audience: "admin_api", grants: [{ kind: "shopper" }], scopes: ADMIN_SCOPES, passkey: true });
    sellerTok = await h.mint(user, { audience: "seller_api", grants: [{ kind: "brand", storeId: uid(1), role: "owner" }], scopes: ["seller:read", "seller:write"] });
  }, 30_000);
  afterAll(async () => {
    await h.close();
  });

  const call = (m: "get" | "put", t: string | null, path = "/v1/admin/calendar", b?: unknown) => {
    h.clock.advance(50);
    let r = h.http()[m](path).set(idem());
    if (t !== null) r = r.set(bearer(t));
    return b === undefined ? r : r.send(b as object);
  };

  it("401 without token or wrong audience; 403 for no passkey, wrong role, no scope, shopper", async () => {
    for (const m of ["get", "put"] as const) {
      expect((await call(m, null, undefined, m === "put" ? body() : undefined)).status).toBe(401);
      expect((await call(m, sellerTok, undefined, m === "put" ? body() : undefined)).status).toBe(401);
      for (const t of [noPasskey, wrongRole, noScope, shopperOnAdmin]) {
        expect((await call(m, t, undefined, m === "put" ? body() : undefined)).status, `${m}`).toBe(403);
      }
    }
  });

  it("creates, lists, updates with expected_version, cancels, and rejects bad input", async () => {
    const c = await call("put", admin, undefined, body());
    expect(c.status).toBe(200);
    expect(c.body.created).toBe(true);
    expect(c.body.event.version).toBe(1);
    // create with expected_version is a conflict
    expect((await call("put", admin, undefined, body({ id: U(41), expected_version: 1 }))).status).toBe(409);
    // update without the expected version is a conflict
    expect((await call("put", admin, undefined, body({ title_ar: "x" }))).status).toBe(409);
    const u = await call("put", admin, undefined, body({ title_ar: "تعديل", expected_version: 1 }));
    expect(u.status).toBe(200);
    expect(u.body.event.version).toBe(2);
    expect((await call("put", admin, undefined, body({ expected_version: 1 }))).status).toBe(409);
    const x = await call("put", admin, undefined, body({ status: "cancelled", expected_version: 2 }));
    expect(x.body.event.status).toBe("cancelled");
    expect((await call("put", admin, undefined, body({ ends_at: "2026-11-26T00:00:00Z", expected_version: 3 }))).status).toBe(400);
    expect((await call("put", admin, undefined, body({ kind: "nope" }))).status).toBe(400);
    expect((await call("put", admin, undefined, { ...body(), extra: 1 })).status).toBe(400);
    const l = await call("get", admin);
    expect(l.status).toBe(200);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.items[0].status).toBe("cancelled");
    expect(l.body.items[0].version).toBe(3);
    expect((await call("get", admin, "/v1/admin/calendar?cursor=zzz")).status).toBe(400);
    expect((await call("get", admin, "/v1/admin/calendar?limit=0")).status).toBe(400);
    expect((await call("get", admin, "/v1/admin/calendar?from=2026-12-01T00:00:00Z")).body.items).toHaveLength(0);
  });
});
