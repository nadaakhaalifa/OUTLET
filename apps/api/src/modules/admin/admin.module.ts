import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AdminController } from "./adapters/admin.controller";
import { AdminMeController, telemetryMeCounter, type AdminIdentityOptions, type SessionBindingPort } from "./adapters/admin-me.controller";
import { MAX_ACTIVE_EDGE_KIDS, MIN_EDGE_KEY_BYTES, UnconfiguredEdgeReplayStore } from "./adapters/edge-posture";
import {
  InMemoryAdminAudit,
  InMemoryAdminStore,
  InMemoryFlagBackend,
  InMemoryPiiSource,
  InMemorySellerKyc,
  SPEC_KILL_SWITCH_KEYS,
} from "./adapters/in-memory";
import {
  ADMIN_IDENTITY,
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
  /** `GET /v1/admin/me` signals (ADR-0048, Proposed). Every field defaults to the fail-closed value. */
  readonly identity?: AdminIdentityModuleOptions;
}

export interface AdminIdentityModuleOptions extends Partial<AdminIdentityOptions> {
  /** Set by the infra pipeline when the API listener is reachable only from the edge (VR-AC-04). */
  readonly privateIngressAttested?: boolean;
}

export class AdminIdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminIdentityConfigError";
  }
}

/** Passkey sessions are `passkey_uv_unbound` until migration 0092 and a real binding source exist. */
class UnboundSessionBinding implements SessionBindingPort {
  bindingOf(i: { passkey: boolean }): Promise<"passkey_uv_unbound" | "not_passkey"> {
    return Promise.resolve(i.passkey ? "passkey_uv_unbound" : "not_passkey");
  }
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
    const idn = options.identity ?? {};
    const edgeKeys = idn.edgeKeys ?? new Map<string, Uint8Array>();
    const realEnv = production;
    if (edgeKeys.size > MAX_ACTIVE_EDGE_KIDS) throw new AdminIdentityConfigError("at most two active edge posture kids");
    for (const k of edgeKeys.values()) {
      if (k.byteLength < MIN_EDGE_KEY_BYTES) throw new AdminIdentityConfigError("edge posture keys must be at least 32 bytes");
    }
    if (realEnv && idn.devTrust === true) throw new AdminIdentityConfigError("ADMIN_POSTURE_DEV_TRUST is refused with real adapters");
    if (realEnv && edgeKeys.size > 0 && idn.privateIngressAttested !== true) {
      throw new AdminIdentityConfigError("edge posture keys require ADMIN_API_PRIVATE_INGRESS_ATTESTED");
    }
    const identity: AdminIdentityOptions = {
      enabled: idn.enabled ?? (() => false),
      edgeKeys,
      replay: idn.replay ?? new UnconfiguredEdgeReplayStore(),
      binding: idn.binding ?? new UnboundSessionBinding(),
      devTrust: idn.devTrust === true,
      count: idn.count ?? telemetryMeCounter,
    };
    const approvalConfig = validateApprovalConfig(options.approvalConfig ?? DEFAULT_APPROVAL_CONFIG);
    const elevationConfig = options.elevationConfig ?? DEFAULT_ELEVATION_CONFIG;
    return {
      module: AdminModule,
      controllers: [AdminController, AdminMeController],
      providers: [
        { provide: ADMIN_IDENTITY, useValue: identity },
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
