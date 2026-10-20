import Link from "next/link";
import type { ReactNode } from "react";
import type { Translator } from "../i18n";
import { isBreaching, summaryKey, tileState, type Attention, type TileSpec, type TileValue } from "../view-models/dashboard";

/**
 * One dashboard tile. Distinct states, never a fake number:
 * - zero: quiet ("Nothing waiting"); - failed / not available yet: a compact one-line card with an em dash and a note;
 * - capped: "N+" with a note; - breach with a count: danger edge AND a visible word.
 */
export function Tile({ spec, value, t }: { spec: TileSpec; value: TileValue; t: Translator }) {
  const label = t(spec.labelKey);
  const state = tileState(value);
  const link = <Link className="tile-link" href={spec.href} aria-label={`${t("home.tile.view")}: ${label}`}>{t("home.tile.view")}</Link>;
  if (state === "failed" || state === "notYet") {
    return (
      <li className="tile-card tile-compact">
        <h3 className="tile-label">{label}</h3>
        <p className="tile-line">
          <span className="tile-n" dir="ltr" aria-hidden="true">—</span>
          <span className="muted tile-note">{state === "failed" ? t("home.tile.unavailable") : t("home.tile.notYet")}</span>
        </p>
      </li>
    );
  }
  const breach = isBreaching(spec, value);
  const note = state === "zero" ? t("home.tile.zero") : state === "capped" ? `${t(spec.noteKey)}. ${t("home.tile.capped")}` : t(spec.noteKey);
  return (
    <li className={`tile-card${breach ? " sev-breach" : ""}${state === "zero" ? " tile-quiet" : ""}`}>
      <h3 className="tile-label">{label}</h3>
      {breach && spec.breachLabelKey !== undefined ? <p className="tile-flag">{t(spec.breachLabelKey)}</p> : null}
      <p className="tile-n" dir="ltr">{value.text}</p>
      <p className="muted tile-note">{note}</p>
      {state === "zero" ? null : link}
    </li>
  );
}

export function TileSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="tile-section">
      <h2 id={id}>{title}</h2>
      <ul className="tile-grid">{children}</ul>
    </section>
  );
}

/** Skeleton tiles reusing the shared .skeleton pulse; rendered while a section's reads are in flight. */
export function TileSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ul className="tile-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="tile-card"><div className="skeleton row-s" /><div className="skeleton h" /><div className="skeleton row-s" /></li>
      ))}
    </ul>
  );
}

/** "Needs attention" strip + summary line. Never claims all clear when a read failed. */
export function AttentionStrip({ attention, t }: { attention: Attention; t: Translator }) {
  const { rows, state, total, failedCount } = attention;
  if (state === "items") {
    const n = String(total);
    return (
      <section aria-labelledby="home-attention" className="attention">
        <h2 id="home-attention">{t("home.attention.title")}</h2>
        <p className="attention-summary" role="status">{t(`home.summary.${summaryKey(total)}`, { n })}</p>
        <ul className="attention-list">
          {rows.map((r) => (
            <li key={r.id} className={r.severity === "breach" ? "attention-row sev-breach" : "attention-row"}>
              <Link href={r.spec.href} aria-label={`${t(r.spec.labelKey)}: ${r.text}`}>
                <span className="attention-n" dir="ltr">{r.text}</span>
                <span className="attention-why">
                  {r.severity === "breach" && r.spec.breachLabelKey !== undefined ? <strong className="tile-flag">{t(r.spec.breachLabelKey)}</strong> : null}
                  {t(r.spec.labelKey)}
                </span>
                <span className="flip" aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
        {failedCount > 0 ? <p className="muted" role="status">{t("home.attention.partial")}</p> : null}
      </section>
    );
  }
  if (state === "clear") {
    return (
      <section aria-labelledby="home-attention" className="attention calm">
        <h2 id="home-attention" className="empty-title">{t("home.attention.clear")}</h2>
        <p className="muted">{t("home.attention.clearBody")}</p>
      </section>
    );
  }
  if (state === "none") return null;
  return (
    <section aria-labelledby="home-attention" className="attention">
      <h2 id="home-attention">{t("home.attention.title")}</h2>
      <p className="muted" role="status">{t("home.attention.partial")}</p>
    </section>
  );
}
