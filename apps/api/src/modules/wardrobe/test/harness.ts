import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import {
  FakeBudget,
  FakeCandidateSource,
  FakeEmbeddings,
  FakePersonalization,
  InMemoryStylistStore,
  StaticStylistFlags,
  FLAG_ML,
} from "../../stylist";
import { catalog } from "./stylist-fixtures";
import { FakeConsent, FakeVision, FakeWardrobeImages, InMemoryWardrobeStore, StaticWardrobeFlags } from "../adapters/in-memory";
import { FLAG_WARDROBE, FLAG_WARDROBE_VISION, type StylistPorts, type WardrobeConfig } from "../application/shared";
import { WardrobeModule } from "../wardrobe.module";
import type { VisionAttributePort, WardrobeStore } from "../domain/ports";

export const START_MS = 1_800_000_000_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.subjects.set(token, { actor, aud });
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const seller = (id: string, storeId: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "brand", storeId, role: "owner" }], tokenScopes: [] });

export const USERS = { a: U(1), b: U(2) };
export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  aOnSellerAud: "token-shopper-a-on-seller-0000003",
  seller: "token-seller-0000000000000000004",
};

export interface WardrobeHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: WardrobeStore;
  readonly memory: InMemoryWardrobeStore | null;
  readonly images: FakeWardrobeImages;
  readonly vision: FakeVision;
  readonly consent: FakeConsent;
  readonly flags: StaticWardrobeFlags;
  readonly stylist: {
    readonly candidates: FakeCandidateSource;
    readonly outfits: InMemoryStylistStore;
    readonly personalization: FakePersonalization;
    readonly flags: StaticStylistFlags;
  };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createWardrobeHarness(
  over: { config?: WardrobeConfig; store?: WardrobeStore; vision?: VisionAttributePort; images?: FakeWardrobeImages } = {},
): Promise<WardrobeHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, shopper(USERS.a), "buyer_api");
  tokens.add(TOKENS.b, shopper(USERS.b), "buyer_api");
  tokens.add(TOKENS.aOnSellerAud, shopper(USERS.a), "seller_api");
  tokens.add(TOKENS.seller, seller(U(50), U(9001)), "seller_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const candidates = new FakeCandidateSource();
  candidates.items = catalog();
  const stylist = {
    candidates,
    embeddings: new FakeEmbeddings(),
    budget: new FakeBudget(),
    personalization: new FakePersonalization(),
    flags: new StaticStylistFlags(new Set([FLAG_ML])),
    outfits: new InMemoryStylistStore(),
  };
  const consent = new FakeConsent();
  consent.personalization.add(USERS.a).add(USERS.b);
  const flags = new StaticWardrobeFlags(new Set([FLAG_WARDROBE, FLAG_WARDROBE_VISION]));
  const memory = over.store === undefined ? new InMemoryWardrobeStore() : null;
  const store = over.store ?? (memory as InMemoryWardrobeStore);
  const images = over.images ?? new FakeWardrobeImages();
  const vision = new FakeVision();
  const ports: StylistPorts = stylist;

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      WardrobeModule.forRoot(config, {
        store,
        images,
        vision: over.vision ?? vision,
        consent,
        flags,
        stylist: ports,
        ...(over.config === undefined ? {} : { config: over.config }),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, store, memory, images, vision, consent, flags, stylist, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
