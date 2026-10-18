import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { storeCredit } from "@outlet/domain";

const { collectStrings, violatesWording } = storeCredit;
import { money } from "../domain/bridge";
import { FakeRefundFacts, InMemoryRefundStore, IntakeRefundIntent, ProcessRefund, RefundsModule } from "../index";
import { FakeCreditRestore, FakePayoutDetails, FakeRefundExecutor, InMemoryRefundLedger, SeqJitter } from "../index";
import { GRANT_CREDIT, StoreCreditModule, type GrantCredit } from "../../store-credit/index";
import { ORDER_GROUP_1, SELLER_ORDER_1, SHOPPER_A, SHOPPER_B, SeqIds, TestClock, U, facts, intent, tender } from "./fixtures";

class Tokens implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.subjects.set(token, { actor, aud });
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test",
      sub: s.actor.id,
      aud: s.aud,
      iat,
      exp: iat + 600,
      jti: `jti-${bearer}`,
      sid: `sid-${bearer}`,
      amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const TA = "token-shopper-a-0000000001";
const TB = "token-shopper-b-0000000001";
const TSELLER = "token-seller-aud-0000000001";

let app: INestApplication;
let refundA = "";
let refundB = "";

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new Tokens();
  tokens.add(TA, shopper(SHOPPER_A), "buyer_api");
  tokens.add(TB, shopper(SHOPPER_B), "buyer_api");
  tokens.add(TSELLER, shopper(SHOPPER_A), "seller_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryRefundStore();
  const factsPort = new FakeRefundFacts();
  const refundIds = new SeqIds(0x30000);
  factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
  const intake = new IntakeRefundIntent(store, factsPort, refundIds, clock);
  const a = await intake.execute(intent(1));
  if (a.kind !== "created") throw new Error("seed failed");
  refundA = a.refundId;
  factsPort.seed(U(0x502), facts([tender("t2", "card", 5_000n)], { userId: SHOPPER_B }));
  const b = await intake.execute(intent(2, { net: 5_000n, userId: SHOPPER_B, sellerOrderId: U(0x502) }));
  if (b.kind !== "created") throw new Error("seed failed");
  refundB = b.refundId;
  const ledger = new InMemoryRefundLedger();
  ledger.recognise(ORDER_GROUP_1);
  await new ProcessRefund(store, ledger, new FakeCreditRestore(), new FakeRefundExecutor(), new FakePayoutDetails(), clock, new SeqJitter(0)).execute(refundA);

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      StoreCreditModule.forRoot(config),
      RefundsModule.forRoot(config, { store, facts: factsPort }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const grant = app.get<GrantCredit>(GRANT_CREDIT, { strict: false });
  await grant.promo({ userId: SHOPPER_A, sub: { kind: "goodwill" }, amount: money(2_500n), key: "g-a" });
  await grant.promo({ userId: SHOPPER_B, sub: { kind: "cashback_coins" }, amount: money(900n), key: "g-b" });
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());

describe("GET /v1/me/wallet", () => {
  it("requires a buyer-audience token", async () => {
    expect((await http().get("/v1/me/wallet")).status).toBe(401);
    expect((await http().get("/v1/me/wallet").set(bearer(TSELLER))).status).toBe(401);
  });

  it("returns the caller's balances only, as decimal strings", async () => {
    const a = await http().get("/v1/me/wallet").set(bearer(TA));
    expect(a.status).toBe(200);
    expect(a.body.total).toEqual({ amount: "2500", currency: "EGP" });
    expect(a.body.sub_balances.map((b: { kind: string }) => b.kind)).toEqual(["goodwill"]);
    const b = await http().get("/v1/me/wallet").set(bearer(TB));
    expect(b.body.total).toEqual({ amount: "900", currency: "EGP" });
  });

  it("never says cash or money in any string on the wire", async () => {
    for (const path of ["/v1/me/wallet", "/v1/me/wallet/transactions"]) {
      const res = await http().get(path).set(bearer(TA));
      expect(res.status).toBe(200);
      const strings = collectStrings(res.body);
      expect(strings.length).toBeGreaterThan(0);
      for (const s of strings) expect(violatesWording(s), s).toBe(false);
    }
  });

  it("lists transactions with a cursor and rejects a forged one", async () => {
    const res = await http().get("/v1/me/wallet/transactions?limit=1").set(bearer(TA));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ kind: "goodwill_in", sub_balance: "goodwill" });
    expect((await http().get("/v1/me/wallet/transactions?cursor=%25%25").set(bearer(TA))).status).toBe(400);
  });
});

describe("no way to put value in or take value out (ADR-0003)", () => {
  const paths = ["/v1/me/wallet", "/v1/me/wallet/topup", "/v1/me/wallet/top-up", "/v1/me/wallet/withdraw", "/v1/me/wallet/transfer", "/v1/me/wallet/deposit", "/v1/wallet/withdraw", "/v1/wallet/transfer"];
  it("only GET exists on the wallet, and no top-up, withdraw or transfer route exists at all", async () => {
    for (const p of paths) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const res = await http()[method](p).set(bearer(TA)).send({ amount: "100" });
        expect([404, 405], `${method} ${p} -> ${res.status}`).toContain(res.status);
      }
    }
    for (const p of paths.slice(1)) {
      expect((await http().get(p).set(bearer(TA))).status, p).toBe(404);
    }
  });
});

describe("refund reads", () => {
  it("shows the owner their refund, without provider or ledger internals", async () => {
    const res = await http().get(`/v1/refunds/${refundA}`).set(bearer(TA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: refundA, status: "COMPLETED", amount: { amount: "10000", currency: "EGP" }, slo: "on_track" });
    expect(JSON.stringify(res.body)).not.toMatch(/provider_ref|ledger|fake-/);
  });

  it("another shopper's refund is 404, the same as a missing one", async () => {
    expect((await http().get(`/v1/refunds/${refundA}`).set(bearer(TB))).status).toBe(404);
    expect((await http().get(`/v1/refunds/${U(0xdead)}`).set(bearer(TB))).status).toBe(404);
    expect((await http().get(`/v1/refunds/${refundB}`).set(bearer(TB))).status).toBe(200);
  });

  it("rejects a non-uuid id, and anonymous or wrong-audience callers", async () => {
    expect((await http().get("/v1/refunds/not-a-uuid").set(bearer(TA))).status).toBe(400);
    expect((await http().get(`/v1/refunds/${refundA}`)).status).toBe(401);
    expect((await http().get(`/v1/refunds/${refundA}`).set(bearer(TSELLER))).status).toBe(401);
  });

  it("lists only the caller's refunds, and there is no HTTP write for refunds", async () => {
    const res = await http().get("/v1/me/refunds").set(bearer(TB));
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([refundB]);
    for (const [method, path] of [["post", "/v1/refunds"], ["post", "/v1/me/refunds"], ["patch", `/v1/refunds/${refundB}`], ["delete", `/v1/refunds/${refundB}`]] as const) {
      const r = await http()[method](path).set(bearer(TB)).send({});
      expect([404, 405], `${method} ${path}`).toContain(r.status);
    }
  });
});
