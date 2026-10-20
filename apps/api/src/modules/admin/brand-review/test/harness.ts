import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../../../../app.setup";
import { loadConfig } from "../../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../../platform";
import { InMemoryAdminAudit, InMemoryAdminStore } from "../../adapters/in-memory";
import type { ElevationRecord } from "../../domain/bridge";
import { FakeClock, PRINCIPALS } from "../../test/harness";
import { BrandReviewModule } from "../brand-review.module";
import type { BrandApplicationRecord, ProvisioningRetryOutcome } from "../domain";
import { InMemoryBrandApplicationsAdmin, InMemoryBrandVerification, InMemoryReviewerIdentity } from "../in-memory";

/** Admin store whose live elevations can be seeded directly (the real flow is covered by admin.http.test). */
export class SeedableAdminStore extends InMemoryAdminStore {
  private readonly extra: ElevationRecord[] = [];
  elevate(userId: string, role: ElevationRecord["role"], nowMs: number): void {
    this.extra.push({
      id: `elev-${this.extra.length}`,
      userId,
      role,
      reasonCode: "kyc_review",
      approvalId: "appr",
      requestedTtlMs: 3_600_000,
      state: "ACTIVE",
      requestedAtMs: nowMs,
      activatedAtMs: nowMs,
      expiresAtMs: nowMs + 3_600_000,
      revokedAtMs: null,
      revokedBy: null,
    });
  }
  override async liveElevations(userId: string, nowMs: number): Promise<readonly ElevationRecord[]> {
    const base = await super.liveElevations(userId, nowMs);
    return [...base, ...this.extra.filter((e) => e.userId === userId && e.expiresAtMs !== null && nowMs < e.expiresAtMs)];
  }
}

class TestAuthenticator implements Authenticator {
  private readonly byToken = new Map(Object.values(PRINCIPALS).map((p) => [p.token, p]));
  async authenticate(token: string, nowMs: number) {
    const p = this.byToken.get(token);
    if (p === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    return {
      actor: p.actor,
      claims: { iss: "test", sub: p.actor.id, aud: p.aud, iat, exp: iat + 600, jti: `jti-${p.actor.id}`, sid: `sid-${p.actor.id}`, amr: ["otp_sms" as const] },
    };
  }
}

@Global()
@Module({})
class TestAuthModule {
  static register(): DynamicModule {
    return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: new TestAuthenticator() }], exports: [AUTHENTICATOR] };
  }
}

export interface BrandReviewHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly adminStore: SeedableAdminStore;
  readonly audit: InMemoryAdminAudit;
  readonly apps: InMemoryBrandApplicationsAdmin;
  readonly verification: InMemoryBrandVerification;
  readonly reviewers: InMemoryReviewerIdentity;
  /** Scriptable provisioning retry: `outcome` is what the next retry reports; `calls` records application ids. */
  readonly provisioning: { outcome: ProvisioningRetryOutcome; readonly calls: string[] };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createBrandReviewHarness(): Promise<BrandReviewHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const adminStore = new SeedableAdminStore();
  const audit = new InMemoryAdminAudit();
  const apps = new InMemoryBrandApplicationsAdmin();
  const verification = new InMemoryBrandVerification();
  const reviewers = new InMemoryReviewerIdentity();
  const provisioning: BrandReviewHarness["provisioning"] = { outcome: { kind: "provisioned" }, calls: [] };
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      BrandReviewModule.forRoot(config, {
        adminStore,
        audit,
        applications: apps,
        verification,
        reviewers,
        provisioning: {
          retry: async (id) => {
            provisioning.calls.push(id);
            if (provisioning.outcome.kind === "provisioned") apps.patch(id, { status: "APPROVED", provisioningFailure: null, storeId: "0192f3a4-5b6c-7d8e-9f01-0000000a0001" });
            return provisioning.outcome;
          },
        },
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, adminStore, audit, apps, verification, reviewers, provisioning, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const APPLICANT = "0192f3a4-5b6c-7d8e-9f01-000000000900";
let seq = 0;
export const appId = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(7000 + ++seq).padStart(12, "0")}`;

export function makeApplication(nowMs: number, over: Partial<BrandApplicationRecord> = {}): BrandApplicationRecord {
  return {
    id: appId(),
    version: 1,
    status: "IN_REVIEW",
    brandName: "Nile Basics",
    brandKind: "local",
    country: "EG",
    applicantUserId: APPLICANT,
    applicantShopperUserId: null,
    applicantPhoneHash: "hash-applicant",
    brandDomain: "nilebasics.example",
    assigneeId: null,
    submittedAtMs: nowMs - 86_400_000,
    decisionDueAtMs: nowMs + 5 * 86_400_000,
    appeal: false,
    highRiskCountry: false,
    riskScore: null,
    pendingCosign: null,
    claimConflictOpen: false,
    duplicateClaimApplicationIds: [],
    requestedItems: [],
    decision: null,
    internalNotes: [],
    history: [],
    storeId: null,
    provisioningFailure: null,
    createdAtMs: nowMs - 2 * 86_400_000,
    updatedAtMs: nowMs - 86_400_000,
    ...over,
  };
}
