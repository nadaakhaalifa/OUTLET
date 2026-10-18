import type { AdminAccess, AdminStore } from "../../admin";

export type AdminRoleName = AdminAccess["effective"][number];
import type { ChainProblem } from "./audit-verify";

export interface ChainVerification {
  readonly rowsChecked: number;
  readonly headSeq: string | null;
  readonly headHash: string | null;
  readonly checkpointsChecked: number;
  /** Already sorted by seq; the controller truncates to 100. */
  readonly problems: readonly ChainProblem[];
}

/** Read-only access to the append-only audit_log chains. */
export interface AuditChainReader {
  /** Number of rows in the chain (0 when it does not exist). */
  chainLength(chainId: string, role: AdminRoleName): Promise<number>;
  verify(chainId: string, role: AdminRoleName): Promise<ChainVerification>;
}

/** The one AdminStore method the gate needs (live elevations feed computeAccess). */
export type ElevationLookup = Pick<AdminStore, "liveElevations">;

export interface AttentionReading {
  readonly count: number;
  readonly oldestAtMs: number | null;
  readonly deadlineAtMs: number | null;
}
export interface AttentionSourcePort {
  /** Throws or times out => the item is reported unavailable. Never returns PII. */
  read(itemId: string, actorId: string, nowMs: number): Promise<AttentionReading>;
}
