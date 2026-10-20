import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import * as fc from "fast-check";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { FakeWebhookBodySchema } from "../adapters/webhook-body";
import { FORBIDDEN_FIELD_NAMES, containsPan, luhnValid, sanitizeJson, type JsonValue } from "../domain/card-data-guard";
import { AvailabilityQuerySchema, ClientActionSchema, SavedCardSchema, SavedCardViewSchema } from "../domain/schemas";
import { loadFixture } from "../adapters/paymob/fixture-transport";
import { createWorld } from "./world";

const MODULE_DIR = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const SOURCES = walk(MODULE_DIR).filter((f) => f.endsWith(".ts") && !f.includes("/test/"));

/** Every property name that appears anywhere in the JSON Schema of `schema` (zod v4). */
function propertyNames(schema: z.ZodType): string[] {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as unknown;
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n !== null && typeof n === "object") {
      for (const [k, v] of Object.entries(n)) {
        if (k === "properties" && v !== null && typeof v === "object") out.push(...Object.keys(v));
        visit(v);
      }
    }
  };
  visit(js);
  return out;
}

const luhnPan = (digits: number[]): string => {
  const body = digits.map(String);
  for (let check = 0; check < 10; check++) {
    const s = [...body, String(check)].join("");
    if (luhnValid(s)) return s;
  }
  throw new Error("unreachable");
};
const panArb = fc
  .tuple(fc.integer({ min: 2, max: 6 }), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 14, maxLength: 14 }))
  .map(([first, rest]) => luhnPan([first, ...rest]));

describe("SAQ A: no card data fields anywhere", () => {
  it("no schema of this module declares a card-data property", () => {
    const all = [SavedCardSchema, SavedCardViewSchema, ClientActionSchema, FakeWebhookBodySchema, AvailabilityQuerySchema].flatMap(propertyNames);
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((n) => FORBIDDEN_FIELD_NAMES.test(n))).toEqual([]);
  });

  it("a saved card schema rejects a PAN, CVV or holder name even when sent alongside valid fields", () => {
    const good = { psp_token: "tok_aaaaaaaa", brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030, fingerprint: "fp_aaaaaaaa" };
    expect(SavedCardSchema.safeParse(good).success).toBe(true);
    for (const extra of [{ pan: "4242424242424242" }, { cvv: "123" }, { card_holder_name: "A B" }, { number: "4242424242424242" }]) {
      expect(SavedCardSchema.safeParse({ ...good, ...extra }).success).toBe(false);
    }
    expect(SavedCardSchema.safeParse({ ...good, last4: "424242" }).success).toBe(false);
  });

  it("the migration declares no card-data column, in the SQL text or in the live catalog", async () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../../../../packages/db/migrations/0032_payments.sql", import.meta.url)), "utf8");
    const cols = [...sql.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|bigint|integer|smallint|boolean|char\(\d+\)|jsonb|timestamptz)\b/gm)].map((m) => m[1] ?? "");
    expect(cols).toContain("psp_token");
    expect(cols.filter((c) => FORBIDDEN_FIELD_NAMES.test(c))).toEqual([]);
    const db = await createTestDatabaseUpTo(32);
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('payment_intents','payment_events_raw','payment_refunds','payment_methods')`,
    );
    expect(r.rows.length).toBeGreaterThan(30);
    expect(r.rows.map((x) => x.column_name).filter((c) => FORBIDDEN_FIELD_NAMES.test(c))).toEqual([]);
    await db.close();
  }, 60_000);

  it("the database refuses a malformed last4 and a non-token display shape", async () => {
    const db = await createTestDatabaseUpTo(32);
    await db.query(`insert into users (id, status) values ('00000000-0000-4000-8000-000000000001','active')`);
    await expect(
      db.query(
        `insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint)
         values ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','fake_psp','tok_aaaaaaaa','visa','4242424242424242',1,2030,'fp_aaaaaaaa')`,
      ),
    ).rejects.toThrow();
    await db.close();
  }, 60_000);

  it("no recorded fixture contains a PAN and every one passes the sanitizer unchanged", () => {
    const dir = new URL("../adapters/paymob/fixtures/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const { body } = loadFixture(f.replace(/\.json$/, ""));
      const s = sanitizeJson(body as JsonValue);
      expect(s.redacted, f).toBe(false);
      expect(containsPan(JSON.stringify(body)), f).toBe(false);
    }
  });

  it("module source never logs: no console, logger or body printing", () => {
    for (const f of SOURCES) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\bconsole\./);
      expect(text, f).not.toMatch(/\b(?:Logger|logger)\b/);
    }
  });

  it("module source has no network API: nothing here can reach a PSP or any host", () => {
    const banned = /\bfetch\s*\(|node:(?:http|https|net|tls|dgram|dns)|from "(?:http|https|net|tls|axios|undici|got|node-fetch)"|XMLHttpRequest|WebSocket|\.connect\s*\(/;
    for (const f of SOURCES) expect(readFileSync(f, "utf8"), f).not.toMatch(banned);
  });

  it("property: no Luhn-valid PAN survives into a stored webhook body, wherever it appears", async () => {
    await fc.assert(
      fc.asyncProperty(
        panArb,
        fc.constantFrom("note", "memo", "desc", "pan", "card_number", "x"),
        fc.constantFrom("", " ", "-"),
        fc.boolean(),
        async (pan, key, sep, nested) => {
          const shown = sep === "" ? pan : pan.replace(/(\d{4})(?=\d)/g, `$1${sep}`);
          const leaf = { [key]: `paid with ${shown} ok` };
          const body = { type: "payment.authorized", event_id: `e-${pan.slice(-6)}`, ...(nested ? { data: { deep: [leaf] } } : leaf) };
          const w = createWorld();
          const signed = w.primary.signedWebhook(body);
          await w.receive.execute({ provider: "fake_psp", rawBody: signed.rawBody, headers: signed.headers, ip: "203.0.113.5" });
          const stored = JSON.stringify(w.store.allRawEvents().map((r) => r.body));
          expect(stored).not.toContain(pan);
          expect(containsPan(stored)).toBe(false);
          expect(w.store.outbox.some((o) => o.payload.anomaly === "pan_in_webhook")).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("does not mistake UUIDs, zero strings or epoch milliseconds for card numbers", () => {
    fc.assert(
      fc.property(fc.uuid(), (u) => {
        expect(containsPan(u)).toBe(false);
        expect(sanitizeJson({ order_group_id: u, ref: `ref ${u} ${u}` }).redacted).toBe(false);
      }),
      { numRuns: 500 },
    );
    expect(containsPan("0000000000000000")).toBe(false);
    expect(containsPan("1800000000000")).toBe(false);
    expect(containsPan("4242 4242 4242 4242")).toBe(true);
    expect(containsPan("card 5555-5555-5555-4444 ok")).toBe(true);
  });

  it("property: the sanitizer is idempotent and leaves PAN-free documents untouched", () => {
    const leaf = fc.oneof(fc.string({ maxLength: 12 }).filter((s) => !/\d{8,}/.test(s)), fc.integer(), fc.boolean(), fc.constant(null));
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }).filter((k) => !/^(pan|cvv|cvc|number)/i.test(k)), leaf), (doc) => {
        const a = sanitizeJson(doc as JsonValue);
        expect(a.redacted).toBe(false);
        expect(a.value).toEqual(doc);
        expect(sanitizeJson(a.value).value).toEqual(a.value);
      }),
    );
  });

  it("outbox payloads of every event type carry no card-shaped key or PAN", async () => {
    const w = createWorld();
    const c = await w.create.execute({
      orderGroupId: "00000000-0000-4000-8000-0000000000aa",
      userId: "00000000-0000-4000-8000-000000000001",
      method: "card",
      amount: 5_000n,
      currency: "EGP",
      containsDropSku: false,
      payer: { userId: "00000000-0000-4000-8000-000000000001", phoneE164: null, email: null },
    });
    if (c.kind !== "created") throw new Error("unexpected");
    await w.voidPayment.execute(c.intent.id);
    for (const o of w.store.outbox) {
      expect(Object.keys(o.payload).filter((k) => FORBIDDEN_FIELD_NAMES.test(k))).toEqual([]);
      expect(containsPan(JSON.stringify(o.payload))).toBe(false);
    }
    expect(w.store.outbox.length).toBeGreaterThan(0);
  });
});
