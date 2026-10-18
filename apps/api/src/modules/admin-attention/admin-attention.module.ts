import { Module, type DynamicModule } from "@nestjs/common";
import { InMemoryAdminAudit, InMemoryAdminStore, type AdminAuditPort } from "../admin";
import type { AppConfig } from "../../config/env";
import { AdminAttentionController } from "./adapters/admin-attention.controller";
import { InMemoryAttentionSources, InMemoryAuditChains, UnconfiguredAttentionSources } from "./adapters/in-memory";
import {
  ATTENTION_ROUTES_ENABLED,
  ATTENTION_SOURCES,
  AUDIT_CHAIN_READER,
  AUDIT_LOG_ROUTES_ENABLED,
  ELEVATION_LOOKUP,
  META_AUDIT,
} from "./adapters/tokens";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { AttentionSourcePort, AuditChainReader, ElevationLookup } from "./domain/ports";

export interface AdminAttentionOptions {
  /** KyselyAuditChainReader in production. Required outside in-memory-dev. */
  readonly chains?: AuditChainReader;
  /** The AdminStore (live elevations). Required outside in-memory-dev. */
  readonly elevations?: ElevationLookup;
  /** The admin hash-chained audit port (meta-audit of every verify). Required outside in-memory-dev. */
  readonly audit?: AdminAuditPort;
  /** Missing in production: every attention item reports `unavailable` (never 0). */
  readonly sources?: AttentionSourcePort;
  /** `release.admin.audit_log`. Default false (blocked): verify answers 404. */
  readonly auditLogRoutesEnabled?: () => Promise<boolean> | boolean;
  /** `release.admin.attention`. Default false (blocked): the queue answers 404. */
  readonly attentionRoutesEnabled?: () => Promise<boolean> | boolean;
}

/** Dashboard foundations track 7 (docs/specs/dashboard-foundations.md section 7): audit verify + attention queue. */
@Module({})
export class AdminAttentionModule {
  static forRoot(config: AppConfig, options: AdminAttentionOptions = {}): DynamicModule {
    const dev = config.adapters === "in-memory-dev";
    if (!dev && (options.chains === undefined || options.elevations === undefined || options.audit === undefined)) {
      throw new NoProductionAdaptersError();
    }
    return {
      module: AdminAttentionModule,
      controllers: [AdminAttentionController],
      providers: [
        { provide: AUDIT_CHAIN_READER, useValue: options.chains ?? new InMemoryAuditChains() },
        { provide: ATTENTION_SOURCES, useValue: options.sources ?? (dev ? new InMemoryAttentionSources() : new UnconfiguredAttentionSources()) },
        { provide: ELEVATION_LOOKUP, useValue: options.elevations ?? new InMemoryAdminStore() },
        { provide: META_AUDIT, useValue: options.audit ?? new InMemoryAdminAudit() },
        { provide: AUDIT_LOG_ROUTES_ENABLED, useValue: options.auditLogRoutesEnabled ?? (() => false) },
        { provide: ATTENTION_ROUTES_ENABLED, useValue: options.attentionRoutesEnabled ?? (() => false) },
      ],
    };
  }
}
