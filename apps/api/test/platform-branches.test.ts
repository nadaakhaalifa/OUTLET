import { createDecipheriv } from "node:crypto";
import { PAYMENT_METHODS } from "@outlet/checkout";
import { KILL_SWITCHES } from "@outlet/flags";
import { money } from "@outlet/money";
import { describe, expect, it } from "vitest";
import { parseEnv, parseWebhookIps, trustProxyList } from "../src/config.js";
import {
  AesRawBodyCipher, FlagKillSwitches, HmacQuoteTokenPort, PlainPrices, StandardTaxCategories, UnconfiguredAddress, UnconfiguredBilling, UnconfiguredCommission, UnconfiguredPaymentProvider,
  UnconfiguredRefunds, UnconfiguredShipping, UnconfiguredSubMerchants, denyAllWebhookIps, productionCheckoutConfig, staticWebhookIps, unconfiguredCodConfirmation,
} from "../src/modules/checkout/index.js";
import { readEcho, toContractMethod, toInternalMethod } from "../src/modules/checkout/quote-wire.js";
import { decodeCursor, encodeCursor } from "../src/platform/cursor.js";
import { ProblemError } from "../src/platform/problem.js";
import { MemoryRateLimiter } from "../src/platform/rate-limit/memory.js";

describe("config parsing", () => {
  it("parseWebhookIps reads provider=ip;ip pairs, trims, and ignores entries without '='", () => {
    expect(parseWebhookIps("")).toEqual({});
    expect(parseWebhookIps(" paymob = 1.1.1.1 ; 2.2.2.2 , fawry=3.3.3.3,junk, =4.4.4.4 ,kashier=")).toEqual({ paymob: ["1.1.1.1", "2.2.2.2"], fawry: ["3.3.3.3"], "": ["4.4.4.4"], kashier: [] });
  });
  it("trustProxyList is false for empty or whitespace-only input and a trimmed list otherwise", () => {
    expect(trustProxyList("")).toBe(false);
    expect(trustProxyList(" , ,")).toBe(false);
    expect(trustProxyList(" 10.0.0.0/8 , 192.168.1.1 ")).toEqual(["10.0.0.0/8", "192.168.1.1"]);
  });
  it("parseEnv error names variables and issue codes but never echoes values", () => {
    const secret = "super-secret-value-that-must-not-leak";
    let msg = "";
    try { parseEnv({ DATABASE_URL_APP: "not a url", RATE_LIMIT_KEY_SECRET: secret.slice(0, 5), JWT_ISSUER: secret }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^invalid environment: /);
    expect(msg).toContain("DATABASE_URL_APP");
    expect(msg).not.toContain(secret);
  });
});

describe("cursor", () => {
  it("round-trips parts and rejects wrong arity, empty parts and garbage with a 400 cursor-invalid problem", () => {
    const c = encodeCursor("2030-01-01T00:00:00.000Z", "id-1");
    expect(decodeCursor(c, 2)).toEqual(["2030-01-01T00:00:00.000Z", "id-1"]);
    for (const [cur, n] of [[c, 3], [c, 1], [encodeCursor("a", ""), 2], ["", 1], ["%%%", 2], [Buffer.from("a|b|c").toString("base64url"), 2]] as const) {
      let err: unknown;
      try { decodeCursor(cur, n); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ProblemError);
      expect(err).toMatchObject({ status: 400, code: "cursor-invalid" });
    }
  });
});

describe("quote wire helpers", () => {
  it("method names map both ways, with the contract's mobile_wallet for the internal wallet", () => {
    expect(toContractMethod("wallet")).toBe("mobile_wallet");
    expect(toInternalMethod("mobile_wallet")).toBe("wallet");
    for (const m of PAYMENT_METHODS) expect(toInternalMethod(toContractMethod(m))).toBe(m);
  });
  it("readEcho refuses anything that is not a full quote (missing fields, bad hash, oversize arrays, wrong types)", () => {
    expect(readEcho(null)).toBeNull();
    expect(readEcho({})).toBeNull();
    expect(readEcho("x")).toBeNull();
    const m = { amountMinor: "1", currency: "EGP" };
    const base = { stores: [], fees: [], itemsSubtotal: m, shipping: m, discount: m, vat: m, total: m, storeCredit: m, payableByMethod: [], verifiedSavings: m, hash: "a".repeat(64) };
    const ok = readEcho(base);
    expect(ok?.hash).toBe("a".repeat(64));
    expect(ok?.payableByMethod).toBeInstanceOf(Map);
    expect(readEcho({ ...base, hash: "A".repeat(64) })).toBeNull();
    expect(readEcho({ ...base, hash: "a".repeat(63) })).toBeNull();
    expect(readEcho({ ...base, stores: Array.from({ length: 51 }, () => ({})) })).toBeNull();
    expect(readEcho({ ...base, payableByMethod: [["cash", m]] })).toBeNull();
    expect(readEcho({ ...base, payableByMethod: Array.from({ length: 21 }, () => ["card", m]) })).toBeNull();
    expect(readEcho({ ...base, total: { amountMinor: "-x", currency: "EGP" } })).toBeNull();
  });
});

describe("production checkout adapters", () => {
  it("fail closed with no provider contract: nothing is supported, charged, verified, quoted or refunded", async () => {
    const psp = new UnconfiguredPaymentProvider();
    expect(psp.provider).toBe("paymob");
    expect(psp.supports()).toBe(false);
    expect(await psp.createIntent()).toEqual({ ok: false, retryable: false, code: "provider_unconfigured" });
    expect(await psp.voidIntent()).toEqual({ outcome: "not_found" });
    expect(psp.verifyWebhook()).toEqual({ ok: false, reason: "bad_signature" });
    expect(await new UnconfiguredShipping().quote()).toEqual({ unavailable: true, reason: "shipping_unconfigured" });
    expect(await new UnconfiguredAddress().resolve()).toBeNull();
    expect(await new UnconfiguredSubMerchants().refFor()).toBeNull();
    expect(await new UnconfiguredRefunds().requestRefund()).toEqual({ accepted: false });
    await expect(new UnconfiguredBilling().billingFor()).rejects.toThrow(/not configured/);
    await expect(new UnconfiguredCommission().rateFor()).rejects.toThrow(/not configured/);
    expect(await unconfiguredCodConfirmation.verify({ userId: "u", orderGroupId: "o", code: "123456" })).toBe(false);
    expect(await new PlainPrices().snapshotForOrderLine()).toEqual({ vrp: null, evidenceIds: [], claimType: "plain" });
  });
  it("webhook IP policy: deny-all by default; the static list matches provider and exact address only", () => {
    expect(denyAllWebhookIps.allowed("paymob", "127.0.0.1")).toBe(false);
    const p = staticWebhookIps({ paymob: ["1.2.3.4"] });
    expect(p.allowed("paymob", "1.2.3.4")).toBe(true);
    expect(p.allowed("paymob", "1.2.3.40")).toBe(false);
    expect(p.allowed("fawry", "1.2.3.4")).toBe(false);
    expect(p.allowed("constructor", "1.2.3.4")).toBe(false);
  });
  it("standard tax category for every sku; production config has zero fees, a 10-minute lock and the COD first-order cap", async () => {
    expect([...(await new StandardTaxCategories().categoriesFor(["a", "b"])).entries()]).toEqual([["a", "standard"], ["b", "standard"]]);
    const c = productionCheckoutConfig();
    expect(c.priceLockSec).toBe(600);
    expect(c.codMaxFirstOrder).toEqual(money(150_000n, "EGP"));
    expect(Object.keys(c.methodFee).sort()).toEqual([...PAYMENT_METHODS].sort());
    expect(Object.values(c.methodFee).every((f) => f.amountMinor === 0n)).toBe(true);
  });
  it("AesRawBodyCipher needs a 32-byte key and produces iv||tag||ct that decrypts only with the same aad", async () => {
    expect(() => new AesRawBodyCipher(new Uint8Array(16))).toThrow(RangeError);
    const key = new Uint8Array(32).fill(5);
    const cipher = new AesRawBodyCipher(key);
    const plain = new TextEncoder().encode("{\"a\":1}");
    const out = Buffer.from(await cipher.encrypt(plain, "evt-1"));
    expect(out.length).toBe(12 + 16 + plain.length);
    const open = (aad: string): string => {
      const d = createDecipheriv("aes-256-gcm", key, out.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(out.subarray(12, 28));
      return Buffer.concat([d.update(out.subarray(28)), d.final()]).toString();
    };
    expect(open("evt-1")).toBe("{\"a\":1}");
    expect(() => open("evt-2")).toThrow();
    expect(Buffer.from(await cipher.encrypt(plain, "evt-1")).equals(out)).toBe(false); // fresh iv each time
  });
});

describe("HmacQuoteTokenPort", () => {
  const secret = "s".repeat(32);
  const payload = { jti: "j1", userId: "u1", marketId: "EG", quoteHash: "h".repeat(8), method: "card" as const, expiresAt: new Date("2030-01-01T00:10:00.000Z") };
  it("round-trips a signed payload and rejects short secrets", () => {
    expect(() => new HmacQuoteTokenPort("short")).toThrow(RangeError);
    const port = new HmacQuoteTokenPort(secret);
    expect(port.verify(port.sign(payload))).toEqual(payload);
  });
  it("rejects a tampered body, a tampered mac, another secret, missing parts, bad JSON and an unknown method", () => {
    const port = new HmacQuoteTokenPort(secret);
    const token = port.sign(payload);
    const [body = "", mac = ""] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: "attacker", expiresAt: payload.expiresAt.toISOString() })).toString("base64url");
    expect(port.verify(`${forged}.${mac}`)).toBeNull();
    expect(port.verify(`${body}.${mac.slice(0, -2)}AA`)).toBeNull();
    expect(port.verify(`${body}.`)).toBeNull();
    expect(port.verify(body)).toBeNull();
    expect(port.verify("")).toBeNull();
    expect(new HmacQuoteTokenPort("t".repeat(32)).verify(token)).toBeNull();
    const signRaw = (raw: string): string => {
      const b = Buffer.from(raw).toString("base64url");
      return `${b}.${(new HmacQuoteTokenPort(secret) as unknown as { mac(x: string): Buffer }).mac(b).toString("base64url")}`;
    };
    expect(port.verify(signRaw("not json"))).toBeNull();
    expect(port.verify(signRaw(JSON.stringify({ ...payload, method: "bitcoin", expiresAt: payload.expiresAt.toISOString() })))).toBeNull();
    expect(port.verify(signRaw(JSON.stringify({ ...payload, extra: 1, expiresAt: payload.expiresAt.toISOString() })))).toBeNull();
  });
});

describe("FlagKillSwitches", () => {
  it("asks the flag service for known kill switches and treats an unknown key as engaged", async () => {
    const asked: string[] = [];
    const ks = new FlagKillSwitches({ isKilled: (name, ctx) => { asked.push(`${name}:${ctx.marketId}`); return Promise.resolve(false); } }, "EG");
    expect(await ks.isEngaged("definitely-not-a-switch")).toBe(true);
    expect(asked).toEqual([]);
    const [known] = Object.keys(KILL_SWITCHES);
    expect(known).toBeDefined();
    expect(await ks.isEngaged(known ?? "")).toBe(false);
    expect(asked).toEqual([`${known ?? ""}:EG`]);
  });
});

describe("MemoryRateLimiter pruning", () => {
  it("at the key cap it forgets recovered keys (and only those) before admitting a new one", async () => {
    let now = 1_000_000;
    const rl = new MemoryRateLimiter(() => now, 3);
    const rule = { limit: 1, periodMs: 1_000 };
    for (const k of ["a", "b", "c"]) expect((await rl.hit(k, rule)).allowed).toBe(true);
    expect(rl.size).toBe(3);
    now += 5_000; // every key has recovered
    expect((await rl.hit("d", rule)).allowed).toBe(true);
    expect(rl.size).toBe(1);
    expect((await rl.hit("d", rule)).allowed).toBe(false); // still limited: pruning did not reset an active key
  });
});
