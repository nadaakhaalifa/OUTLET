import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AdminController } from "./adapters/admin.controller";
import {
  InMemoryAdminAudit,
  InMemoryAdminStore,
  InMemoryFlagBackend,
  InMemoryPiiSource,
  InMemorySellerKyc,
  SPEC_KILL_SWITCH_KEYS,
} from "./adapters/in-memory";
import {
  ADMIN_AUDIT,
  ADMIN_STORE,
  DUAL_APPROVALS,
  FEATURE_FLAG_ADMIN,
  FLAG_ADMIN_BACKEND,
  PII_SOURCE,
  ROLE_ELEVATIONS,
  SELLER_KYC_ADMIN,
  SELLER_KYC_PORT,
  VIEW_PII,
} from "./adapters/tokens";
import { DualApprovals, FeatureFlagAdmin, RoleElevations, SellerKycAdmin, ViewPii } from "./application/admin";
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_ELEVATION_CONFIG,
  validateApprovalConfig,
  type ApprovalConfig,
  type ElevationConfig,
} from "./domain/bridge";
import type {
  AdminAuditPort,
  AdminStore,
  FlagAdminBackend,
  PiiSourcePort,
  SellerKycPort,
} from "./domain/ports";

export interface AdminModuleOptions {
  readonly approvalConfig?: ApprovalConfig;
  readonly elevationConfig?: ElevationConfig;
  /** KyselyAdminStore in production. */
  readonly store?: AdminStore;
  readonly audit?: AdminAuditPort;
  readonly kyc?: SellerKycPort;
  /** Backend over packages/feature-flags (registry + provider). */
  readonly flags?: FlagAdminBackend;
  readonly pii?: PiiSourcePort;
}

@Module({})
export class AdminModule {
  static forRoot(config: AppConfig, options: AdminModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (
      production &&
      (options.store === undefined ||
        options.audit === undefined ||
        options.kyc === undefined ||
        options.flags === undefined ||
        options.pii === undefined)
    ) {
      throw new NoProductionAdaptersError();
    }
    const approvalConfig = validateApprovalConfig(options.approvalConfig ?? DEFAULT_APPROVAL_CONFIG);
    const elevationConfig = options.elevationConfig ?? DEFAULT_ELEVATION_CONFIG;
    return {
      module: AdminModule,
      controllers: [AdminController],
      providers: [
        { provide: ADMIN_STORE, useValue: options.store ?? new InMemoryAdminStore() },
        { provide: ADMIN_AUDIT, useValue: options.audit ?? new InMemoryAdminAudit() },
        { provide: SELLER_KYC_PORT, useValue: options.kyc ?? new InMemorySellerKyc() },
        {
          provide: FLAG_ADMIN_BACKEND,
          useValue:
            options.flags ??
            new InMemoryFlagBackend(
              SPEC_KILL_SWITCH_KEYS.map((key) => ({ key, kind: "kill_switch" as const, description: key })),
            ),
        },
        { provide: PII_SOURCE, useValue: options.pii ?? new InMemoryPiiSource() },
        {
          provide: DUAL_APPROVALS,
          inject: [ADMIN_STORE, ADMIN_AUDIT, CLOCK, ID_GENERATOR],
          useFactory: (s: AdminStore, a: AdminAuditPort, c: Clock, ids: IdGenerator) =>
            new DualApprovals(s, a, c, ids, approvalConfig),
        },
        {
          provide: ROLE_ELEVATIONS,
          inject: [ADMIN_STORE, ADMIN_AUDIT, CLOCK, ID_GENERATOR],
          useFactory: (s: AdminStore, a: AdminAuditPort, c: Clock, ids: IdGenerator) =>
            new RoleElevations(s, a, c, ids, approvalConfig, elevationConfig),
        },
        {
          provide: VIEW_PII,
          inject: [PII_SOURCE, ADMIN_AUDIT, CLOCK],
          useFactory: (p: PiiSourcePort, a: AdminAuditPort, c: Clock) => new ViewPii(p, a, c),
        },
        {
          provide: FEATURE_FLAG_ADMIN,
          inject: [FLAG_ADMIN_BACKEND, ADMIN_AUDIT, CLOCK],
          useFactory: (b: FlagAdminBackend, a: AdminAuditPort, c: Clock) => new FeatureFlagAdmin(b, a, c),
        },
        {
          provide: SELLER_KYC_ADMIN,
          inject: [ADMIN_STORE, SELLER_KYC_PORT, ADMIN_AUDIT, CLOCK, ID_GENERATOR],
          useFactory: (s: AdminStore, k: SellerKycPort, a: AdminAuditPort, c: Clock, ids: IdGenerator) =>
            new SellerKycAdmin(s, k, a, c, ids),
        },
      ],
      exports: [SELLER_KYC_ADMIN, DUAL_APPROVALS],
    };
  }
}
