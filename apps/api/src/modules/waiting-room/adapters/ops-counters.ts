import { QueueUnavailableError, type AdmissionStore, type Clock, type QueuePort } from "../domain/ports";

/** Structural twin of the drops module's DropOpsSource. Reads stored counters only. */
export class WaitingRoomOpsCounters {
  constructor(
    private readonly queue: QueuePort,
    private readonly store: AdmissionStore,
    private readonly clock: Clock,
  ) {}

  /** Queue depth, or null when the queue backend is unreachable (unmeasured, never guessed). */
  async queueDepth(dropId: string): Promise<number | null> {
    try {
      return await this.queue.size(dropId);
    } catch (e) {
      if (e instanceof QueueUnavailableError) return null;
      throw e;
    }
  }

  async windowCounts(dropId: string, windowMs: number): Promise<{ admitted: number; rejected: number; abandoned: number }> {
    return this.store.countsSince(dropId, this.clock.nowMs() - windowMs);
  }
}
