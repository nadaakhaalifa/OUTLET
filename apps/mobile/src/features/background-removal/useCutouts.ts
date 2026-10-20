import { useCallback, useEffect, useRef, useState } from "react";
import {
  CutoutError, linksExpired, pollUntilSettled, refreshDelayMs, viewOf,
  type CutoutBlock, type CutoutJob, type CutoutModel, type CutoutPort, type CutoutView,
} from "./model";

export interface CutoutEntry {
  readonly job: CutoutJob | null;
  readonly block: CutoutBlock | null;
  readonly working: boolean;
  readonly acting: boolean;
}
const IDLE: CutoutEntry = { job: null, block: null, working: false, acting: false };

export interface CutoutsApi {
  readonly entry: (localId: string) => CutoutEntry;
  readonly view: (localId: string) => CutoutView;
  readonly start: (localId: string, uri: string) => void;
  readonly accept: (localId: string) => void;
  readonly useOriginal: (localId: string) => void;
  readonly rerun: (localId: string, model: CutoutModel) => void;
  readonly forget: (localId: string) => void;
  /** Loads an existing job (a product's linked cutout) so its preview links can be shown and kept fresh. */
  readonly adopt: (localId: string, jobId: string) => void;
}


const kindOf = (e: unknown): CutoutBlock => (e instanceof CutoutError ? e.kind : "failed");

/**
 * Runs cutouts per photo without ever blocking the form: every call is fire-and-forget and writes into a small map.
 * Polling uses backoff and stops on unmount.
 */
export function useCutouts(port: CutoutPort, opts: { sleep?: (ms: number) => Promise<void>; nowMs?: () => number } = {}): CutoutsApi {
  const [map, setMap] = useState<ReadonlyMap<string, CutoutEntry>>(new Map());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.nowMs ?? Date.now;

  const patch = useCallback((id: string, p: Partial<CutoutEntry>) => {
    if (!alive.current) return;
    setMap((m) => new Map(m).set(id, { ...(m.get(id) ?? IDLE), ...p }));
  }, []);

  const settle = useCallback(async (id: string, first: CutoutJob) => {
    patch(id, { job: first, working: true });
    try {
      const done = await pollUntilSettled(port, first, { sleep, cancelled: () => !alive.current, onUpdate: (j) => patch(id, { job: j }) });
      patch(id, { job: done, working: false, block: null });
    } catch (e) {
      // The job never settled: drop it so the panel shows the failure, not a spinner that never ends.
      patch(id, { job: null, working: false, block: kindOf(e) });
    }
  }, [port, patch, sleep]);

  const start = useCallback((id: string, uri: string) => {
    patch(id, { job: null, block: null, working: true });
    port.start(uri).then((j) => settle(id, j), (e: unknown) => patch(id, { working: false, block: kindOf(e) }));
  }, [port, patch, settle]);

  const act = useCallback((id: string, f: (jobId: string) => Promise<CutoutJob>, poll: boolean) => {
    const cur = map.get(id)?.job;
    if (cur === undefined || cur === null) return;
    patch(id, { acting: true, block: null });
    f(cur.jobId).then(
      (j) => { patch(id, { job: j, acting: false }); if (poll) void settle(id, j); },
      (e: unknown) => patch(id, { acting: false, block: kindOf(e) }),
    );
  }, [map, patch, settle]);

  const accept = useCallback((id: string) => act(id, async (j) => {
    const cur = map.get(id)?.job;
    // A stale signed link must not reach the grid: refresh first.
    if (cur !== undefined && cur !== null && linksExpired(cur, now())) await port.refresh(j);
    return port.accept(j);
  }, false), [act, map, now, port]);
  const useOriginal = useCallback((id: string) => act(id, (j) => port.useOriginal(j), false), [act, port]);
  const rerun = useCallback((id: string, model: CutoutModel) => act(id, (j) => port.rerun(j, model), true), [act, port]);
  const forget = useCallback((id: string) => setMap((m) => { const n = new Map(m); n.delete(id); return n; }), []);

  const adopt = useCallback((id: string, jobId: string) => {
    patch(id, { job: null, block: null, working: true });
    port.refresh(jobId).then((j) => patch(id, { job: j, working: false }), (e: unknown) => patch(id, { working: false, block: kindOf(e) }));
  }, [port, patch]);

  // Signed links expire (at most 15 minutes): re-fetch each job's links shortly before, so no preview goes stale.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [id, e] of map) {
      const job = e.job;
      if (job === null || e.working || e.acting) continue;
      const wait = refreshDelayMs(job, now());
      if (wait === null) continue;
      timers.push(setTimeout(() => {
        port.refresh(job.jobId).then((j) => patch(id, { job: j }), () => undefined);
      }, wait));
    }
    return () => timers.forEach(clearTimeout);
  }, [map, now, port, patch]);

  const entry = useCallback((id: string) => map.get(id) ?? IDLE, [map]);
  const view = useCallback((id: string): CutoutView => {
    const e = map.get(id);
    return viewOf(e?.job ?? null, e?.block ?? null, e?.working ?? false);
  }, [map]);
  return { entry, view, start, accept, useOriginal, rerun, forget, adopt };
}
