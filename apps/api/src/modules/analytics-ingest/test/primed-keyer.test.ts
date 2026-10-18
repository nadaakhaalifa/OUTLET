import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { PrimedShopperKeyer } from "../adapters/primed-keyer";
import { HmacShopperKeyer } from "../adapters/hmac-keyer";
import { AnalyticsIngestModule } from "../analytics-ingest.module";
import { AUTHENTICATOR, ID_GENERATOR } from "../../../platform";
import { CLOCK } from "../../../platform/tokens";
import { loadConfig } from "../../../config/env";

@Global()
@Module({ providers: [{ provide: CLOCK, useValue: { nowMs: () => 0 } }, { provide: AUTHENTICATOR, useValue: {} }, { provide: ID_GENERATOR, useValue: {} }], exports: [CLOCK, AUTHENTICATOR, ID_GENERATOR] })
class ClockModule {}
const b64 = (n: number) => Buffer.alloc(32, n).toString("base64");
const ver = (kid: string, n: number) => ({ kid, shopperKey: b64(n), termKey: b64(n + 1) });
const secret = (o: object) => JSON.stringify(o);
class NotCfg extends Error {
  override name = "NotCfg";
}
const mk = (load: () => Promise<string | null>) => new PrimedShopperKeyer(load, () => new NotCfg("x"));
const hm = (n: number) => new HmacShopperKeyer(new Uint8Array(Buffer.alloc(32, n)), new Uint8Array(Buffer.alloc(32, n + 1)));

describe("PrimedShopperKeyer", () => {
  it("fails closed before priming, works after", async () => {
    const k = mk(async () => secret({ current: ver("k2", 2) }));
    expect(() => k.shopperKey("u")).toThrow(NotCfg);
    await k.prime();
    expect(k.shopperKey("u")).toBe(hm(2).shopperKey("u"));
    expect(k.termHash("t")).toBe(hm(2).termHash("t"));
  });

  it("rotation: previous-key pseudonym is still produced for erasure matching", async () => {
    const before = mk(async () => secret({ current: ver("k1", 1) }));
    await before.prime();
    const oldKey = before.shopperKey("u");
    const after = mk(async () => secret({ current: ver("k2", 2), previous: ver("k1", 1) }));
    await after.prime();
    expect(after.shopperKey("u")).not.toBe(oldKey);
    expect(after.shopperKeys("u")).toEqual([after.shopperKey("u"), oldKey]);
  });

  it.each([
    ["missing", async () => null],
    ["unreadable", async () => { throw new Error("SECRETVALUE boom"); }],
    ["not json", async () => "SECRETVALUE"],
    ["short key", async () => secret({ current: { kid: "k", shopperKey: Buffer.alloc(8).toString("base64"), termKey: b64(1) } })],
  ])("%s secret throws the typed error and nothing leaks", async (_n, load) => {
    const k = mk(load);
    const e = await k.prime().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotCfg);
    expect(String((e as Error).message) + String((e as Error).stack)).not.toContain("SECRETVALUE");
    expect(() => k.shopperKey("u")).toThrow(NotCfg);
  });

  it("key bytes never appear in thrown errors or logs", async () => {
    const logs: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => (logs.push(String(c)), true)) as typeof process.stdout.write;
    try {
      const k = mk(async () => secret({ current: ver("k", 9) }));
      await k.prime();
    } finally {
      process.stdout.write = orig;
    }
    expect(logs.join("")).not.toContain(b64(9));
  });

  it("module init primes before traffic; a failed prime still boots (fail closed)", async () => {
    const config = loadConfig({ NODE_ENV: "test", DEV_FIXTURES: "true" });
    const ok = mk(async () => secret({ current: ver("k", 3) }));
    const bad = mk(async () => null);
    for (const k of [ok, bad]) {
      const m = await Test.createTestingModule({ imports: [ClockModule, AnalyticsIngestModule.forRoot(config, { keyer: k })] }).compile();
      await m.init();
      await m.close();
    }
    expect(ok.primed).toBe(true);
    expect(bad.primed).toBe(false);
    expect(() => bad.shopperKey("u")).toThrow(NotCfg);
  });
});
