import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryDeliveryLog,
  InMemoryFrequencyStore,
  InMemoryInboxRepository,
  InMemoryPreferenceRepository,
  InMemoryPushTokenRepository,
  InMemoryRequestRepository,
  InMemorySuppressionRepository,
  InMemoryTemplateRepository,
} from "../adapters/in-memory";
import {
  KyselyDeliveryLogRepository,
  KyselyFrequencyStore,
  KyselyInboxRepository,
  KyselyPreferenceRepository,
  KyselyPushTokenRepository,
  KyselyRequestRepository,
  KyselySuppressionRepository,
  KyselyTemplateRepository,
  type NotificationsDb,
} from "../adapters/kysely-store";
import type {
  DeliveryLogRepository,
  FrequencyStore,
  InboxRepository,
  PreferenceRepository,
  PushTokenRepository,
  RequestRepository,
  SuppressionRepository,
  TemplateRepository,
} from "../domain/ports";
import { frequencyUsage } from "../domain/policy";
import type { DeliveryLogEntry, InboxMessage, NotificationRequest, NotificationTemplate } from "../domain/types";
import { createNotificationsDatabase } from "./pglite-db";

let seq = 5000;
const uid = (): string => `0192f3a4-5b6c-7d8e-9f01-${String((seq += 1)).padStart(12, "0")}`;
const T0 = Date.parse("2026-10-10T10:00:00Z");
const DAY = 86_400_000;

interface Fixture {
  readonly templates: TemplateRepository;
  readonly requests: RequestRepository;
  readonly log: DeliveryLogRepository;
  readonly frequency: FrequencyStore;
  readonly prefs: PreferenceRepository;
  readonly suppressions: SuppressionRepository;
  readonly inbox: InboxRepository;
  readonly tokens: PushTokenRepository;
  seedUser(): Promise<string>;
}

const template = (over: Partial<NotificationTemplate> = {}): NotificationTemplate => ({
  id: uid(),
  key: `tpl_${seq}`,
  version: 1,
  channel: "push",
  category: "marketing",
  type: "PRICE_DROPS",
  subjectAr: "عنوان",
  subjectEn: null,
  bodyAr: "نص",
  bodyEn: "text",
  providerTemplateId: null,
  approval: "APPROVED",
  active: true,
  alertType: "price_drop",
  validFromMs: T0 - DAY,
  ...over,
});

const request = (userId: string, over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  id: uid(),
  userId,
  templateKey: "price_drop_alert",
  ref: `ref-${seq}`,
  category: "marketing",
  type: "PRICE_DROPS",
  payload: { product: "فستان", price: 1200 },
  templateVersions: { push: 1 },
  status: "ACCEPTED",
  suppressedReason: null,
  pendingChannel: null,
  scheduledForMs: null,
  attempts: 0,
  expiresAtMs: T0 + DAY,
  deepLink: "outlet://p/1",
  locale: "ar",
  createdAtMs: T0,
  ...over,
});

const inboxMsg = (userId: string, requestId: string, over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: uid(),
  userId,
  requestId,
  type: "PRICE_DROPS",
  titleAr: "تخفيض",
  titleEn: null,
  bodyAr: "نزل السعر",
  bodyEn: null,
  deepLink: null,
  readAtMs: null,
  expiresAtMs: T0 + 30 * DAY,
  createdAtMs: T0,
  ...over,
});

function runContract(name: string, make: () => Promise<Fixture>): void {
  describe(`${name} notification repositories`, () => {
    describe("templates", () => {
      it("returns the highest active version per channel that has become valid", async () => {
        const f = await make();
        const key = `t_${uid().slice(-6)}`;
        await f.templates.save(template({ key, version: 1 }));
        const v2 = template({ key, version: 2, bodyAr: "نص جديد" });
        await f.templates.save(v2);
        await f.templates.save(template({ key, version: 1, channel: "email", type: "PRICE_DROPS" }));
        const active = await f.templates.activeFor(key, T0);
        const push = active.find((t) => t.channel === "push");
        expect(push?.version).toBe(2);
        expect(push?.bodyAr).toBe("نص جديد");
        expect(active.find((t) => t.channel === "email")?.version).toBe(1);
        expect(active).toHaveLength(2);
      });

      it("hides a template until its valid_from has passed", async () => {
        const f = await make();
        const key = `t_${uid().slice(-6)}`;
        await f.templates.save(template({ key, validFromMs: T0 + DAY }));
        expect(await f.templates.activeFor(key, T0)).toHaveLength(0);
        expect(await f.templates.activeFor(key, T0 + DAY)).toHaveLength(1);
      });

      it("keeps old versions reachable for queued messages and by id", async () => {
        const f = await make();
        const key = `t_${uid().slice(-6)}`;
        const v1 = template({ key, version: 1 });
        await f.templates.save(v1);
        await f.templates.save(template({ key, version: 2 }));
        expect((await f.templates.version(key, "push", 1))?.id).toBe(v1.id);
        expect(await f.templates.version(key, "push", 9)).toBeNull();
        expect((await f.templates.get(v1.id))?.key).toBe(key);
        expect(await f.templates.get(uid())).toBeNull();
        expect(await f.templates.get("not-a-uuid")).toBeNull();
      });

      it("deactivating a template removes it from activeFor", async () => {
        const f = await make();
        const key = `t_${uid().slice(-6)}`;
        const t = template({ key });
        await f.templates.save(t);
        await f.templates.save({ ...t, active: false });
        expect(await f.templates.activeFor(key, T0)).toHaveLength(0);
      });
    });

    describe("requests and log", () => {
      it("insertIfAbsent is atomic on (user, key, ref)", async () => {
        const f = await make();
        const u = await f.seedUser();
        const r = request(u);
        expect(await f.requests.insertIfAbsent(r)).toBe(true);
        expect(await f.requests.insertIfAbsent({ ...r, id: uid() })).toBe(false);
        const found = await f.requests.find(u, r.templateKey, r.ref);
        expect(found).toEqual(r);
        expect(await f.requests.find(await f.seedUser(), r.templateKey, r.ref)).toBeNull();
      });

      it("concurrent identical inserts create exactly one request", async () => {
        const f = await make();
        const u = await f.seedUser();
        const base = request(u, { ref: "same" });
        const results = await Promise.all(Array.from({ length: 10 }, () => f.requests.insertIfAbsent({ ...base, id: uid() })));
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it("save persists state transitions", async () => {
        const f = await make();
        const u = await f.seedUser();
        const r = request(u);
        await f.requests.insertIfAbsent(r);
        await f.requests.save({ ...r, status: "SUPPRESSED", suppressedReason: "FREQUENCY_CAP", attempts: 1 });
        const got = await f.requests.find(u, r.templateKey, r.ref);
        expect(got?.status).toBe("SUPPRESSED");
        expect(got?.suppressedReason).toBe("FREQUENCY_CAP");
        expect(got?.attempts).toBe(1);
      });

      it("claimDue claims each due request once, oldest first, honoring the limit", async () => {
        const f = await make();
        const u = await f.seedUser();
        const mk = (offset: number): NotificationRequest =>
          request(u, { status: "SCHEDULED", scheduledForMs: T0 + offset, pendingChannel: "push" });
        const late = mk(3000);
        const early = mk(1000);
        const mid = mk(2000);
        const future = mk(10 * DAY);
        for (const r of [late, early, mid, future]) await f.requests.insertIfAbsent(r);
        const first = await f.requests.claimDue(T0 + 5000, 2);
        expect(first.map((r) => r.id)).toEqual([early.id, mid.id]);
        expect(first.every((r) => r.status === "ACCEPTED" && r.scheduledForMs === null)).toBe(true);
        const second = await f.requests.claimDue(T0 + 5000, 10);
        expect(second.map((r) => r.id)).toEqual([late.id]);
        expect(await f.requests.claimDue(T0 + 5000, 10)).toEqual([]);
      });

      it("log keeps append order and records failures", async () => {
        const f = await make();
        const u = await f.seedUser();
        const r = request(u);
        await f.requests.insertIfAbsent(r);
        const entry = (over: Partial<DeliveryLogEntry>): DeliveryLogEntry => ({
          id: uid(),
          requestId: r.id,
          userId: u,
          channel: "push",
          templateKey: r.templateKey,
          templateVersion: 1,
          category: "marketing",
          providerCode: "expo",
          providerRef: "ref-1",
          status: "SENT",
          failureCode: null,
          sentAtMs: T0,
          ...over,
        });
        const a = entry({ sentAtMs: T0 });
        const b = entry({ sentAtMs: T0 + 10, status: "FAILED", failureCode: "provider_timeout", providerRef: null });
        await f.log.append(a);
        await f.log.append(b);
        expect(await f.log.forRequest(r.id)).toEqual([a, b]);
        expect(await f.log.forRequest(uid())).toEqual([]);
      });
    });

    describe("frequency", () => {
      const cap = (n: number) => (times: readonly number[]) => times.length < n;

      it("admits up to the cap and no further", async () => {
        const f = await make();
        const u = await f.seedUser();
        const out: boolean[] = [];
        for (let i = 0; i < 5; i += 1) out.push(await f.frequency.reserve(u, "push", T0, cap(3)));
        expect(out).toEqual([true, true, true, false, false]);
      });

      it("a released slot can be taken again", async () => {
        const f = await make();
        const u = await f.seedUser();
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(true);
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(false);
        await f.frequency.release(u, "push", T0);
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(true);
        await f.frequency.release(u, "push", T0);
        await f.frequency.release(u, "push", T0); // releasing an empty slot never goes negative
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(true);
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(false);
      });

      it("is isolated per user and per channel", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(true);
        expect(await f.frequency.reserve(v, "push", T0, cap(1))).toBe(true);
        expect(await f.frequency.reserve(u, "email", T0, cap(1))).toBe(true);
        expect(await f.frequency.reserve(u, "push", T0, cap(1))).toBe(false);
      });

      it("feeds the real policy: per-day and per-week caps over Cairo days", async () => {
        const f = await make();
        const u = await f.seedUser();
        const policy = (now: number) => (times: readonly number[]) => {
          const x = frequencyUsage(times, now);
          return x.day < 1 && x.week < 3;
        };
        // three different days fill the week, each once
        for (const d of [3, 2, 1]) expect(await f.frequency.reserve(u, "whatsapp", T0 - d * DAY, policy(T0 - d * DAY))).toBe(true);
        expect(await f.frequency.reserve(u, "whatsapp", T0, policy(T0))).toBe(false); // week cap
        expect(await f.frequency.reserve(u, "whatsapp", T0 + 7 * DAY, policy(T0 + 7 * DAY))).toBe(true); // window moved on
      });

      it("record and sentTimes agree on which window a send belongs to", async () => {
        const f = await make();
        const u = await f.seedUser();
        await f.frequency.record(u, "email", T0);
        await f.frequency.record(u, "email", T0 - 10 * DAY);
        expect(await f.frequency.sentTimes(u, "email", T0 - 2 * DAY)).toHaveLength(1);
        expect(await f.frequency.sentTimes(u, "email", T0 - 12 * DAY)).toHaveLength(2);
        expect(await f.frequency.sentTimes(u, "email", T0 + 3 * DAY)).toHaveLength(0);
        expect(await f.frequency.sentTimes(u, "push", T0 - 12 * DAY)).toHaveLength(0);
      });

      it("concurrent reserves never exceed the cap", async () => {
        const f = await make();
        const u = await f.seedUser();
        const results = await Promise.all(Array.from({ length: 40 }, () => f.frequency.reserve(u, "push", T0, cap(3))));
        expect(results.filter(Boolean)).toHaveLength(3);
        expect(await f.frequency.sentTimes(u, "push", T0 - DAY)).toHaveLength(3);
      });

      it("concurrent reserves for different users do not interfere", async () => {
        const f = await make();
        const users = await Promise.all(Array.from({ length: 5 }, () => f.seedUser()));
        const jobs = users.flatMap((u) => Array.from({ length: 6 }, () => f.frequency.reserve(u, "push", T0, cap(2)).then((ok) => ({ u, ok }))));
        const done = await Promise.all(jobs);
        for (const u of users) expect(done.filter((d) => d.u === u && d.ok)).toHaveLength(2);
      });
    });

    describe("preferences and suppressions", () => {
      it("stores type and type.channel keys and overwrites", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        await f.prefs.setMany(u, new Map([["PROMOTIONS", false], ["PRICE_DROPS.push", false]]), T0);
        await f.prefs.setMany(u, new Map([["PROMOTIONS", true]]), T0 + 1000);
        await f.prefs.setMany(u, new Map(), T0);
        expect(await f.prefs.all(u)).toEqual(new Map([["PROMOTIONS", true], ["PRICE_DROPS.push", false]]));
        expect((await f.prefs.all(v)).size).toBe(0);
      });

      it("suppressions are per channel, idempotent and removable", async () => {
        const f = await make();
        const u = await f.seedUser();
        await f.suppressions.add(u, "email", "UNSUBSCRIBED", T0);
        await f.suppressions.add(u, "email", "UNSUBSCRIBED", T0);
        await f.suppressions.add(u, "email", "BOUNCE", T0);
        expect([...(await f.suppressions.active(u, "email"))].sort()).toEqual(["BOUNCE", "UNSUBSCRIBED"]);
        expect((await f.suppressions.active(u, "push")).size).toBe(0);
        await f.suppressions.remove(u, "email", "UNSUBSCRIBED");
        expect([...(await f.suppressions.active(u, "email"))]).toEqual(["BOUNCE"]);
      });
    });

    describe("inbox and push tokens", () => {
      it("lists newest first with a strict cursor, hides expired rows and other users", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        const msgs: InboxMessage[] = [];
        for (let i = 0; i < 4; i += 1) {
          const r = request(u);
          await f.requests.insertIfAbsent(r);
          const m = inboxMsg(u, r.id, { createdAtMs: T0 + i * 1000 });
          msgs.push(m);
          await f.inbox.insert(m);
        }
        const expiredReq = request(u);
        await f.requests.insertIfAbsent(expiredReq);
        await f.inbox.insert(inboxMsg(u, expiredReq.id, { expiresAtMs: T0 - 1 }));
        const otherReq = request(v);
        await f.requests.insertIfAbsent(otherReq);
        await f.inbox.insert(inboxMsg(v, otherReq.id));

        const page1 = await f.inbox.list(u, null, 3, T0);
        expect(page1.map((m) => m.id)).toEqual([msgs[3]?.id, msgs[2]?.id, msgs[1]?.id]);
        const last = page1[page1.length - 1];
        const page2 = await f.inbox.list(u, last === undefined ? null : { createdAtMs: last.createdAtMs, id: last.id }, 3, T0);
        expect(page2.map((m) => m.id)).toEqual([msgs[0]?.id]);
        expect(page1[0]?.titleAr).toBe("تخفيض");
      });

      it("markRead is all or nothing and keeps the first read time", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        const ru = request(u);
        const rv = request(v);
        await f.requests.insertIfAbsent(ru);
        await f.requests.insertIfAbsent(rv);
        const mine = inboxMsg(u, ru.id);
        const theirs = inboxMsg(v, rv.id);
        await f.inbox.insert(mine);
        await f.inbox.insert(theirs);
        expect(await f.inbox.markRead(u, [mine.id, theirs.id], T0 + 5)).toBe(false);
        expect((await f.inbox.list(u, null, 5, T0))[0]?.readAtMs).toBeNull();
        expect(await f.inbox.markRead(u, [mine.id], T0 + 5)).toBe(true);
        expect(await f.inbox.markRead(u, [mine.id], T0 + 99)).toBe(true);
        expect((await f.inbox.list(u, null, 5, T0))[0]?.readAtMs).toBe(T0 + 5);
        expect(await f.inbox.markRead(u, [uid()], T0)).toBe(false);
      });

      it("push tokens are per user and install, and can be deactivated", async () => {
        const f = await make();
        const u = await f.seedUser();
        const v = await f.seedUser();
        const install = uid();
        await f.tokens.upsert(u, { installId: install, platform: "ios", token: "token-aaaaaaaa" }, T0);
        await f.tokens.upsert(u, { installId: install, platform: "ios", token: "token-bbbbbbbb" }, T0 + 1);
        await f.tokens.upsert(v, { installId: install, platform: "android", token: "token-cccccccc" }, T0);
        expect(await f.tokens.active(u)).toEqual([{ installId: install, platform: "ios", token: "token-bbbbbbbb" }]);
        await f.tokens.deactivate(v, "token-bbbbbbbb", T0); // someone else's token: no effect on u
        expect(await f.tokens.active(u)).toHaveLength(1);
        await f.tokens.deactivate(u, "token-bbbbbbbb", T0 + 2);
        expect(await f.tokens.active(u)).toEqual([]);
        expect(await f.tokens.active(v)).toHaveLength(1);
      });
    });
  });
}

runContract("in-memory", async () => ({
  templates: new InMemoryTemplateRepository(),
  requests: new InMemoryRequestRepository(),
  log: new InMemoryDeliveryLog(),
  frequency: new InMemoryFrequencyStore(),
  prefs: new InMemoryPreferenceRepository(),
  suppressions: new InMemorySuppressionRepository(),
  inbox: new InMemoryInboxRepository(),
  tokens: new InMemoryPushTokenRepository(),
  seedUser: async () => uid(),
}));

describe("kysely on PGlite", () => {
  let db: NotificationsDb;
  let pg: Awaited<ReturnType<typeof createNotificationsDatabase>>["pg"];

  beforeAll(async () => {
    ({ db, pg } = await createNotificationsDatabase());
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
  });

  const seedUser = async (): Promise<string> => {
    const id = uid();
    await pg.query(`insert into users (id) values ($1)`, [id]);
    return id;
  };

  runContract("kysely", async () => ({
    templates: new KyselyTemplateRepository(db),
    requests: new KyselyRequestRepository(db),
    log: new KyselyDeliveryLogRepository(db),
    frequency: new KyselyFrequencyStore(db),
    prefs: new KyselyPreferenceRepository(db),
    suppressions: new KyselySuppressionRepository(db),
    inbox: new KyselyInboxRepository(db),
    tokens: new KyselyPushTokenRepository(db),
    seedUser,
  }));

  describe("kysely specifics", () => {
    it("takes the per-user advisory lock before it reads the counters", async () => {
      const store = new KyselyFrequencyStore(db);
      const u = await seedUser();
      let seen = -1;
      await store.reserve(u, "push", T0, (times) => {
        seen = times.length;
        return false;
      });
      expect(seen).toBe(0);
      const r = await pg.query<{ n: number }>(`select count(*)::int as n from notification_frequency_counters where user_id = $1`, [u]);
      expect(r.rows[0]?.n).toBe(0); // a refused reservation leaves no row behind
    });

    it("sms carries no marketing counter", async () => {
      const store = new KyselyFrequencyStore(db);
      const u = await seedUser();
      await store.record(u, "sms", T0);
      expect(await store.sentTimes(u, "sms", T0 - DAY)).toEqual([]);
    });

    it("rejects a second active version of one key and channel at the database level", async () => {
      const key = `uq_${seq}`;
      const a = template({ key, version: 1 });
      const b = template({ key, version: 2, active: false });
      await new KyselyTemplateRepository(db).save(a);
      await new KyselyTemplateRepository(db).save(b);
      await expect(
        pg.query(`update notification_templates set active = true where id = $1`, [b.id]),
      ).rejects.toThrow();
    });
  });
});
