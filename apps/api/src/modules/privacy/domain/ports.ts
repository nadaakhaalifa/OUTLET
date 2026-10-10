import type { ConsentHistory, ConsentRecord } from "@outlet/privacy";

/** Append-only consent store. Records are never updated or deleted by this port. */
export interface ConsentRepository {
  history(userId: string): Promise<ConsentHistory>;
  append(records: readonly ConsentRecord[]): Promise<void>;
}
