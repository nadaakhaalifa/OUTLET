export interface SessionEvent {
  readonly productId: string;
  readonly kind: "view" | "save" | "bag" | "purchase";
  readonly atMs: number;
}

export const MAX_SESSION_EVENTS = 50;
const KIND_WEIGHT: Readonly<Record<SessionEvent["kind"], number>> = { view: 1, save: 3, bag: 4, purchase: 0 };

/**
 * Next-item scoring over a shopper session. A real sequence model (GRU4Rec/SASRec class) sits
 * behind the API module's async port; this pure first-order transition model is the offline
 * baseline and the deterministic reference the fake adapter delegates to.
 */
export interface TransitionModel {
  readonly modelVersion: string;
  /** from -> (to -> weight) */
  readonly transitions: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export function trainTransitions(sessions: readonly (readonly SessionEvent[])[], modelVersion = "session-markov-v1"): TransitionModel {
  const t = new Map<string, Map<string, number>>();
  for (const s of sessions) {
    const ev = [...s].sort((a, b) => a.atMs - b.atMs).slice(0, MAX_SESSION_EVENTS);
    for (let i = 0; i + 1 < ev.length; i++) {
      const a = ev[i];
      const b = ev[i + 1];
      if (a === undefined || b === undefined || a.productId === b.productId) continue;
      const row = t.get(a.productId) ?? new Map<string, number>();
      row.set(b.productId, (row.get(b.productId) ?? 0) + 1 + KIND_WEIGHT[b.kind]);
      t.set(a.productId, row);
    }
  }
  return { modelVersion, transitions: t };
}

/** Scores candidates from the last events of the session, recency weighted (halving per step back). */
export function scoreNextItems(
  model: TransitionModel,
  session: readonly SessionEvent[],
  candidateIds: readonly string[],
): ReadonlyMap<string, number> {
  const ev = [...session].sort((a, b) => a.atMs - b.atMs).slice(-MAX_SESSION_EVENTS);
  const seen = new Set(ev.map((e) => e.productId));
  const out = new Map<string, number>();
  for (const id of candidateIds) out.set(id, 0);
  let w = 1;
  for (let i = ev.length - 1; i >= 0 && w > 0.01; i--, w /= 2) {
    const row = model.transitions.get(ev[i]?.productId ?? "");
    if (row === undefined) continue;
    for (const id of candidateIds) {
      const v = row.get(id);
      if (v !== undefined) out.set(id, (out.get(id) ?? 0) + v * w);
    }
  }
  for (const id of seen) if (out.has(id)) out.set(id, 0);
  return out;
}

/** Hit rate of the held-out next item within the top k (offline session evaluation). */
export function hitRateAtK(
  model: TransitionModel,
  sessions: readonly (readonly SessionEvent[])[],
  catalog: readonly string[],
  k: number,
): number {
  let hits = 0;
  let n = 0;
  for (const s of sessions) {
    const ev = [...s].sort((a, b) => a.atMs - b.atMs);
    if (ev.length < 2) continue;
    const held = ev[ev.length - 1];
    if (held === undefined) continue;
    const scores = scoreNextItems(model, ev.slice(0, -1), catalog);
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([id]) => id);
    if (top.includes(held.productId)) hits++;
    n++;
  }
  return n === 0 ? 0 : hits / n;
}
