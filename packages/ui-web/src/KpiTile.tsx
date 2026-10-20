import type { ReactNode } from "react";
import { Skeleton } from "./Skeleton";

export type KpiState = "ready" | "loading" | "stale" | "error" | "empty";
export type DeltaDirection = "up" | "down" | "flat";

export interface KpiDelta {
  readonly direction: DeltaDirection;
  /** Complete visible text, e.g. "+12.4% (+1,240) vs previous 7 days". Never colour alone. */
  readonly text: string;
  /** Spoken direction, translated by the caller: "Increase", "Decrease", "No change". */
  readonly directionLabel: string;
  /** Whether the movement is good for the business; independent of direction (a falling return rate is good). */
  readonly tone?: "good" | "bad" | "neutral";
}

export interface KpiTileProps {
  readonly label: string;
  /** Pre-formatted value (money via the shared formatter over bigint piastres). */
  readonly value: string;
  readonly delta?: KpiDelta;
  /** Optional sparkline (or any small SVG) slot. */
  readonly sparkline?: ReactNode;
  /** Definition shown on demand (keyboard and touch friendly, no hover dependence). */
  readonly definition?: { readonly summaryLabel: string; readonly text: string };
  /** Freshness: visible text plus machine-readable ISO instant. */
  readonly asOf?: { readonly text: string; readonly iso: string };
  readonly state?: KpiState;
  /** Message for stale, error and empty states (why, and what next). */
  readonly stateMessage?: string;
  /** Visible loading text for assistive tech. */
  readonly loadingLabel?: string;
  /** Error retry control. */
  readonly action?: ReactNode;
  /** When true a stale or errored tile keeps showing its last good value (honestly labelled by stateMessage). */
  readonly keepLastValue?: boolean;
}

const DELTA_GLYPH: Readonly<Record<DeltaDirection, string>> = { up: "▲", down: "▼", flat: "▬" };

/** KPI tile: label, value, delta with arrow + words, sparkline slot, definition, "as of", and honest non-ready states. */
export function KpiTile(p: KpiTileProps) {
  const state = p.state ?? "ready";
  const showValue = state === "ready" || ((state === "stale" || state === "error") && p.keepLastValue === true);
  return (
    <article className="uw-kpi" data-state={state} aria-busy={state === "loading" ? true : undefined}>
      <div className="uw-kpi-label">
        <span>{p.label}</span>
        {p.definition === undefined ? null : (
          <details className="uw-def">
            <summary aria-label={p.definition.summaryLabel}>?</summary>
            <div className="uw-def-body">{p.definition.text}</div>
          </details>
        )}
      </div>
      {state === "loading" ? <Skeleton width={50} height="heading" {...(p.loadingLabel === undefined ? {} : { label: p.loadingLabel })} /> : null}
      {showValue ? <p className="uw-kpi-value">{p.value}</p> : null}
      {showValue && p.delta !== undefined ? (
        <p className={`uw-kpi-delta uw-${p.delta.tone ?? "neutral"}`}>
          <span aria-hidden="true">{DELTA_GLYPH[p.delta.direction]}</span>
          <span className="uw-sr">{p.delta.directionLabel}: </span>
          <span>{p.delta.text}</span>
        </p>
      ) : null}
      {showValue ? p.sparkline : null}
      {state === "stale" || state === "empty" ? <p className="uw-kpi-msg uw-muted">{p.stateMessage}</p> : null}
      {state === "error" ? <p role="alert" className="uw-kpi-msg">{p.stateMessage}</p> : null}
      {state === "error" ? p.action : null}
      {p.asOf === undefined || state === "loading" ? null : (
        <p className="uw-kpi-asof"><time dateTime={p.asOf.iso}>{p.asOf.text}</time></p>
      )}
    </article>
  );
}
