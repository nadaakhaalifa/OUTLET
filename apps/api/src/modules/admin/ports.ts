import type { AuditEntryInput } from "@outlet/audit-log";
import type { Queryable } from "@outlet/db";

// Types-only ports shared by several admin files (keeps the import graph acyclic).

/** Appends one hash-chained audit entry. AuditChain satisfies it; production stays Unconfigured (503) until the Postgres chain is composed. */
export interface AuditAppendPort {
  /** Written in the caller's transaction: the entry commits or rolls back with the audited change. */
  appendIn(tx: Queryable, input: AuditEntryInput): Promise<unknown>;
}

export interface SnapshotRow { readonly key: string; readonly asOf: string; readonly payload: unknown; readonly version: number }
export interface SalesDailyRow { readonly day: string; readonly orders: number; readonly gmvMinor: bigint; readonly refundedMinor: bigint }
export interface SalesDaily {
  readonly rows: readonly SalesDailyRow[];
  /** First day the rollup ever covered (null = never ran). Days before it are absent from every series, never invented. */
  readonly firstDay: string | null;
  /** Newest refresh time among the rows read. */
  readonly refreshedAt: string | null;
}
export interface StoreTop {
  readonly items: readonly { storeId: string; nameAr: string; nameEn: string | null; orders: number; gmvMinor: bigint }[];
  readonly other: { readonly stores: number; readonly orders: number; readonly gmvMinor: bigint };
  readonly asOf: string | null;
}
/** The three rollup reads (one statement each, job admin.dashboard). */
export interface DashboardReaderPort {
  snapshots(marketId: string, keys: readonly string[]): Promise<readonly SnapshotRow[]>;
  salesDaily(marketId: string, currency: string, from: string, to: string): Promise<SalesDaily>;
  storeSalesTop(marketId: string, currency: string, from: string, to: string, limit: number): Promise<StoreTop>;
}

