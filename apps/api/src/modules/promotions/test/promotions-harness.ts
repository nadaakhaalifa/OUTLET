import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { buildAccessClaims } from "@outlet/auth-core";
import type { Actor, AdminRole, BrandRole, Grant } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  AuthModule,
  DEV_OTP_MAILBOX,
  type AgeGate,
  type DevOtpMailbox,
  type InMemoryAgeGateStore,
  type InMemoryAuthEventPublisher,
} from "../../auth";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type InMemoryAuditSink,
} from "../../../platform";
import { FakeClock, login, type Harness, type LoggedIn } from "../../../test/harness";
import type { Principal } from "../../../platform/http-types";
import { InMemoryPromotionEventPublisher, InMemoryPromotionRepository, StaticServiceTokenAuthenticator } from "../adapters/in-memory";
import { PromotionsModule } from "../promotions.module";

export const SERVICE_TOKEN = "svc-token-0123456789-abcdefghij";

export interface PromotionsHarness extends Harness {
  readonly repo: InMemoryPromotionRepository;
  readonly promoEvents: InMemoryPromotionEventPublisher;
  /** Mints a token for another audience and rewrites the actor behind it (grants, scopes, status). */
  mint(base: LoggedIn, spec: ActorSpec): Promise<string>;
}

export interface ActorSpec {
  readonly audience: "buyer_api" | "seller_api" | "admin_api";
  readonly grants: readonly Grant[];
  readonly scopes?: readonly string[];
  readonly passkey?: boolean;
  readonly status?: Actor["status"];
}

export async function createPromotionsHarness(): Promise<PromotionsHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const repo = new InMemoryPromotionRepository();
  const promoEvents = new InMemoryPromotionEventPublisher();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      AuthModule.forRoot(config),
      PromotionsModule.forRoot(config, {
        repository: repo,
        events: promoEvents,
        serviceAuth: new StaticServiceTokenAuthenticator(SERVICE_TOKEN),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const ageGate = app.get<AgeGate>(AGE_GATE, { strict: false });
  const ageGateStore = app.get<InMemoryAgeGateStore>(AGE_GATE_STORE, { strict: false });
  const grantAgeGate = (key: string): void =>
    ageGateStore.grantPassForTest(ageGate.passKeyFor(key), clock.nowMs() + 365 * 86_400_000);
  grantAgeGate("key-device-1");

  const authn = app.get<Authenticator>(AUTHENTICATOR, { strict: false });
  const overrides = new Map<string, Partial<Actor>>();
  const original = authn.authenticate.bind(authn);
  const minted = new Map<string, { readonly userId: string; readonly claims: Principal["claims"] }>();
  authn.authenticate = async (token, nowMs) => {
    const p = await original(token, nowMs);
    const o = overrides.get(token);
    if (o === undefined) return p;
    if (p !== null) return { ...p, actor: { ...p.actor, ...o } };
    // seller_api tokens only authenticate against a real seller session; a minted test token carries its actor here.
    const m = minted.get(token);
    if (m === undefined) return null;
    const actor: Actor = { id: m.userId, status: "active", assurance: "basic", grants: [], tokenScopes: [], ...o };
    return { actor, claims: m.claims };
  };
  let n = 0;
  const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };

  return {
    app,
    clock,
    config,
    events: app.get<InMemoryAuthEventPublisher>(AUTH_EVENTS, { strict: false }),
    ageGateStore,
    grantAgeGate,
    mailbox: app.get<DevOtpMailbox>(DEV_OTP_MAILBOX, { strict: false }),
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
    repo,
    promoEvents,
    async mint(base, spec) {
      n += 1;
      const token = await issuer.issue(
        buildAccessClaims({
          issuer: config.tokenIssuer,
          userId: base.userId,
          audience: spec.audience,
          sessionId: base.sessionId,
          jti: `jti-promo-${n}`,
          amr: ["otp_sms"],
          nowMs: clock.nowMs(),
        }),
      );
      const claims = buildAccessClaims({
        issuer: config.tokenIssuer,
        userId: base.userId,
        audience: spec.audience,
        sessionId: base.sessionId,
        jti: `jti-promo-${n}`,
        amr: ["otp_sms"],
        nowMs: clock.nowMs(),
      });
      minted.set(token, { userId: base.userId, claims: claims as Principal["claims"] });
      overrides.set(token, {
        grants: spec.grants,
        tokenScopes: spec.scopes ?? [],
        assurance: spec.passkey === true ? "passkey" : "basic",
        ...(spec.status !== undefined ? { status: spec.status } : {}),
      });
      return token;
    },
  };
}

export { login };

let seq = 0;
/** Valid UUIDv7-shaped id, unique per call. */
export function uid(prefix = 0): string {
  seq += 1;
  return `0192f3a4-5b6c-7d8e-9f01-${String(prefix * 1_000_000 + seq).padStart(12, "0")}`;
}

export const EGP = (pounds: bigint) => ({ amount: (pounds * 100n).toString(), currency: "EGP" as const });

export const adminGrants = (role: AdminRole = "marketing"): Grant[] => [{ kind: "admin", role }];
export const brandGrants = (storeId: string, role: BrandRole = "owner"): Grant[] => [{ kind: "brand", storeId, role }];
export const ADMIN_SCOPES = ["admin:access"] as const;
export const SELLER_SCOPES = ["seller:read", "seller:write"] as const;
