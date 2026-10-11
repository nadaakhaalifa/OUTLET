import { isTerminal } from "../domain/bridge";
import type { SagaRepository } from "../domain/ports";

/**
 * R-6: satisfies the store-credit sweeper guard. A credit hold ref is `hold:{orderGroupId}` or
 * `hold:{orderGroupId}:{seq}`; it is live while its saga exists and is not terminal.
 * An unparsable ref is treated as live (fail closed).
 */
export class SagaHoldLiveness {
  constructor(private readonly sagas: Pick<SagaRepository, "get">) {}

  async isLive(holdRef: string): Promise<boolean> {
    const m = /^hold:([^:]+)(?::\d+)?$/.exec(holdRef);
    if (m === null || m[1] === undefined) return true;
    const rec = await this.sagas.get(m[1]);
    if (rec === null) return false;
    return !isTerminal(rec.facts.status);
  }
}
