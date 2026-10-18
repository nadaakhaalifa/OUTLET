import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  AdmissionVerifier,
  FakeAttestation,
  FakeBotScore,
  FakeEntitlements,
  FakeSecrets,
  FakeSwitches as FakeRoomSwitches,
  InMemoryAdmissionStore,
  InMemoryQueue,
  WaitingRoomModule,
  WaitingRoomOpsCounters,
  ADMIT_FROM_QUEUE,
  type AdmitFromQueue,
  jwtAdmissionCodec,
} from "../../waiting-room";
import {
  ADVANCE_DROPS,
  CLAIM_DROP_UNITS,
  DropGate,
  DropsModule,
  FakeDropSwitches,
  FakeSocialSignals,
  InMemoryDropInventory,
  InMemoryDropStore,
  InMemorySoldOutFlags,
  RELEASE_DROP_UNITS,
  RESERVE_DROP_UNITS,
  DEFAULT_DROPS_CONFIG,
  type AdvanceDrops,
  type ClaimDropUnits,
  type ReleaseDropUnits,
  type ReserveDropUnits,
} from "../index";

export const START_MS = 1_800_000_000_000;
export const HOUR = 3_600_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}

export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, subject: Subject): string {
    this.subjects.set(token, subject);
    return token;
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

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = U(9001);
export const STORE_B = U(9002);
export const SKU_1 = U(7001);
export const SKU_2 = U(7002);

export const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
export const seller = (id: string, storeId: string, role: BrandRole): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: ["seller:read", "seller:write"],
});
export const admin = (id: string, role: AdminRole): Actor => ({
  id,
  status: "active",
  assurance: "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const USERS = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8)] as const;
export const TOKENS = {
  shoppers: USERS.map((_, i) => `token-shopper-${i + 1}-00000000000${i + 1}`),
  ownerA: "token-seller-owner-a-0000011",
  catalogA: "token-seller-catalog-a-00012",
  supportA: "token-seller-support-a-00013",
  ownerB: "token-seller-owner-b-0000014",
  shopperOnSellerAud: "token-shopper-on-seller-aud-15",
  moderator: "token-admin-trust-safety-00017",
  adminSupport: "token-admin-support-0000018",
  shopperOnAdminAud: "token-shopper-on-admin-aud-19",
};

export interface DropsHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryDropStore;
  readonly inventory: InMemoryDropInventory;
  readonly queue: InMemoryQueue;
  readonly room: InMemoryAdmissionStore;
  readonly secrets: FakeSecrets;
  readonly entitlements: FakeEntitlements;
  readonly bot: FakeBotScore;
  readonly attest: FakeAttestation;
  readonly roomSwitches: FakeRoomSwitches;
  readonly dropSwitches: FakeDropSwitches;
  readonly signals: FakeSocialSignals;
  readonly flags: InMemorySoldOutFlags;
  readonly advance: AdvanceDrops;
  readonly admit: AdmitFromQueue;
  readonly reserve: ReserveDropUnits;
  readonly release: ReleaseDropUnits;
  readonly claim: ClaimDropUnits;
  readonly verifier: AdmissionVerifier;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createDropsHarness(): Promise<DropsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  TOKENS.shoppers.forEach((t, i) => tokens.add(t, { actor: shopper(USERS[i] ?? U(0)), aud: "buyer_api" }));
  tokens.add(TOKENS.ownerA, { actor: seller(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: seller(U(12), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: seller(U(13), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: seller(U(14), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.shopperOnSellerAud, { actor: shopper(USERS[0]), aud: "seller_api" });
  tokens.add(TOKENS.moderator, { actor: admin(U(21), "trust_safety"), aud: "admin_api" });
  tokens.add(TOKENS.adminSupport, { actor: admin(U(22), "support"), aud: "admin_api" });
  tokens.add(TOKENS.shopperOnAdminAud, { actor: shopper(USERS[0]), aud: "admin_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryDropStore();
  const inventory = new InMemoryDropInventory();
  const flags = new InMemorySoldOutFlags(() => clock.nowMs());
  const signals = new FakeSocialSignals();
  const dropSwitches = new FakeDropSwitches();
  const queue = new InMemoryQueue();
  const room = new InMemoryAdmissionStore();
  const secrets = new FakeSecrets();
  const entitlements = new FakeEntitlements();
  const bot = new FakeBotScore();
  const attest = new FakeAttestation();
  const roomSwitches = new FakeRoomSwitches();
  const verifier = new AdmissionVerifier(secrets, room, clock, jwtAdmissionCodec);
  const gate = new DropGate(store, flags, clock, DEFAULT_DROPS_CONFIG.preQueueMs);

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      WaitingRoomModule.forRoot(config, { queue, store: room, gate, secrets, bot, attest, entitlements, switches: roomSwitches }),
      DropsModule.forRoot(config, { store, inventory, flags, signals, switches: dropSwitches, verifier, ops: new WaitingRoomOpsCounters(queue, room, clock) }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const get = <X>(token: symbol): X => app.get<X>(token, { strict: false });
  return {
    app,
    clock,
    store,
    inventory,
    queue,
    room,
    secrets,
    entitlements,
    bot,
    attest,
    roomSwitches,
    dropSwitches,
    signals,
    flags,
    advance: get(ADVANCE_DROPS),
    admit: get(ADMIT_FROM_QUEUE),
    reserve: get(RESERVE_DROP_UNITS),
    release: get(RELEASE_DROP_UNITS),
    claim: get(CLAIM_DROP_UNITS),
    verifier,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
