import { z } from "zod";

/** Evaluation context. Never stored in global tables; only hashed for rollout. */
export interface EvalContext {
  readonly marketId: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly deviceId?: string;
}

/** Targeting carried in feature_flags.rules. No user ids (data-model 7.3). */
export const FlagRulesSchema = z.strictObject({
  /** 0..100. Omitted means 100 (everyone). Bucketed by SHA-256(userId ?? deviceId + key). */
  rolloutPercent: z.number().min(0).max(100).optional(),
  /** Allow-list of business store ids. Omitted means all stores. */
  storeIds: z.array(z.string().min(1)).optional(),
});
export type FlagRules = z.infer<typeof FlagRulesSchema>;

export interface FlagRecord {
  readonly key: string;
  /** null = global row; otherwise a per-market override. */
  readonly marketId: string | null;
  readonly enabled: boolean;
  readonly rules: FlagRules;
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface FlagWrite {
  readonly key: string;
  readonly marketId: string | null;
  readonly enabled: boolean;
  readonly rules?: FlagRules;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** Persistence port. */
export interface FlagStore {
  /** Global row plus the row for marketId (if any). */
  get(key: string, marketId: string): Promise<readonly FlagRecord[]>;
  list(): Promise<readonly FlagRecord[]>;
  /** Upsert; version increments by one on update. */
  put(write: FlagWrite): Promise<{ before: FlagRecord | undefined; after: FlagRecord }>;
}

export interface FlagAuditEntry {
  readonly actor: string;
  readonly action: "flag.set" | "kill_switch.engaged" | "kill_switch.released";
  readonly target: string;
  readonly marketId: string | null;
  readonly before: { enabled: boolean; rules: FlagRules; version: number } | null;
  readonly after: { enabled: boolean; rules: FlagRules; version: number };
  readonly at: Date;
}

/** Audit port (implemented over @outlet/audit-log by the composition root). */
export interface AuditPort {
  record(entry: FlagAuditEntry): Promise<void>;
}
