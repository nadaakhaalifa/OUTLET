import { useEffect, useState, type ReactNode } from "react";

/**
 * Leaf ticker: owns the 1 s timer so only this subtree re-renders each second, never the whole screen.
 * `nowFn` is the (server-anchored or injected) clock; the caller keeps all server-time logic.
 */
export function Ticker(props: { nowFn: () => number; render: (nowMs: number) => ReactNode; intervalMs?: number; active?: boolean }) {
  const { nowFn, intervalMs = 1000, active = true } = props;
  const [now, setNow] = useState<number>(() => nowFn());
  useEffect(() => {
    if (!active) return;
    setNow(nowFn());
    const id = setInterval(() => setNow(nowFn()), intervalMs);
    return () => clearInterval(id);
  }, [nowFn, intervalMs, active]);
  return <>{props.render(now)}</>;
}
