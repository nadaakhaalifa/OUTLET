import type { AdminAccess } from "@outlet/admin-access";
import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { OutboxEventInput } from "@outlet/outbox";
import type { Queryable } from "@outlet/db";
import type { DualApprovalConfig } from "@outlet/policy";
import { DEFAULT_WINDOWS } from "../domain/eligibility.js";
import type { WindowConfig } from "../domain/eligibility.js";
import type { EvidencePort, KillSwitchPort, ProviderRefundPort, RestockPort, ReturnPolicyPort } from "./ports.js";

export interface ReturnsConfig extends WindowConfig {
  /** VAT on commission (basis points), must equal the checkout setting (1400). */
  readonly commissionVatBp: number;
  readonly maxRefundAttempts: number;
  readonly retryBackoffSec: number;
  readonly dualApproval: DualApprovalConfig;
  /** A REJECTED return nobody disputed closes after this many days. */
  readonly rejectedCloseDays: number;
}

export const DEFAULT_CONFIG: ReturnsConfig = {
  ...DEFAULT_WINDOWS, commissionVatBp: 1400, maxRefundAttempts: 3, retryBackoffSec: 300, dualApproval: { thresholdMinor: 500_000n }, rejectedCloseDays: 14,
};

export interface ReturnsDeps {
  /** Shopper and seller requests (user / store contexts). */
  readonly app: RoleSqlClient<"outlet_app">;
  /** finance.refunds job: auto-approval, refund creation and processing, dispute resolution. */
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly policy: ReturnPolicyPort;
  readonly evidence: EvidencePort;
  readonly restock: RestockPort;
  readonly provider: ProviderRefundPort;
  readonly kill: KillSwitchPort;
  /** Dual approval (refund.approve) for refunds and manual resolutions at or above the threshold. */
  readonly admin: AdminAccess;
  readonly config?: Partial<ReturnsConfig>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly outbox?: OutboxWriter;
}

export interface Env extends Omit<ReturnsDeps, "config" | "now" | "newId" | "outbox"> {
  readonly config: ReturnsConfig;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly outbox: OutboxWriter;
}

export const makeEnv = (d: ReturnsDeps): Env => ({
  ...d, config: { ...DEFAULT_CONFIG, ...d.config }, now: d.now ?? (() => new Date()), newId: d.newId ?? (() => uuidv7()), outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
});

export const emit = async (env: Env, tx: Queryable, type: string, aggregateType: string, aggregateId: string, payload: Record<string, string | number | boolean | null>): Promise<void> => {
  const e: OutboxEventInput = { id: env.newId(), type, aggregateType, aggregateId, marketId: env.marketId, occurredAt: env.now().toISOString(), visibility: "internal", payload };
  await env.outbox.append(tx, e);
};
