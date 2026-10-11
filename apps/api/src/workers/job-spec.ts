/** The shape of a scheduled job. Lives in its own file so registry.ts and retention-jobs.ts do not import each other. */
import type { Cadence, Criticality } from "./scheduler";

export interface JobSpec {
  readonly name: string;
  /** Nest provider token of the real use case. The registry test resolves every one from a booted AppModule. */
  readonly token: symbol;
  /** Method called on the resolved use case. The registry test asserts it exists. */
  readonly method: string;
  readonly args?: (nowMs: number) => readonly unknown[];
  readonly ownerModule: string;
  readonly cadence: Cadence;
  readonly timeoutMs: number;
  readonly criticality: Criticality;
  readonly capability?: string;
  /** Intraday-style jobs that run only while event mode is on. */
  readonly eventModeOnly?: boolean;
  /** One line: why re-running is safe. Rendered into docs/specs/workers.md. */
  readonly idempotency: string;
}
