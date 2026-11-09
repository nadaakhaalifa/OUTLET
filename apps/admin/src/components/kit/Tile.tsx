import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * One dashboard tile: plain label, big number, short note, optional detail and a link to the screen
 * behind it. `status` adds a chip with an icon and words (colour is never the only signal).
 */
export function Tile({ tileKey, icon, label, value, note, href, linkLabel, status, statusLabel, wide = false, card = false, children }: {
  tileKey: string;
  icon: IconName;
  label: string;
  value?: ReactNode;
  note?: ReactNode;
  href?: string;
  linkLabel?: string;
  status?: "alert" | "ok";
  statusLabel?: string;
  wide?: boolean;
  /** Compact "Today" card: the whole card is the link; no separate Open text. */
  card?: boolean;
  children?: ReactNode;
}) {
  const headingId = `tile-${tileKey}`;
  if (card) {
    const body = (
      <>
        <span className="tileIcon"><Icon name={icon} /></span>
        <span className="tileCardText"><span id={headingId} className="tileLabel">{label}</span>{note ? <span className="tileNote">{note}</span> : null}</span>
        {value !== undefined ? <span className="tileValue" data-testid="tile-value"><bdi>{value}</bdi></span> : null}
        {href ? <span className="tileChevron" aria-hidden="true"><Icon name="chevron" /></span> : null}
        {children}
      </>
    );
    return (
      <li className="tile tileCard" data-tone={status ?? "neutral"} data-tile={tileKey}>
        {href ? <Link href={href} className="tileCardLink">{body}</Link> : <div className="tileCardLink">{body}</div>}
      </li>
    );
  }
  return (
    <li className="tile" data-tone={status ?? "neutral"} data-wide={wide ? "true" : undefined} data-tile={tileKey} aria-labelledby={headingId}>
      <div className="tileHead">
        <span className="tileIcon"><Icon name={icon} /></span>
        <h3 id={headingId} className="tileLabel">{label}</h3>
        {status && statusLabel ? <span className="tileStatus"><Icon name={status === "alert" ? "alert" : "check"} />{statusLabel}</span> : null}
      </div>
      {value !== undefined ? <p className="tileValue" data-testid="tile-value"><bdi>{value}</bdi></p> : null}
      {note ? <p className="tileNote">{note}</p> : null}
      {children}
      {href && linkLabel ? <Link href={href} className="tileLink">{linkLabel}<span className="srOnly"> {label}</span></Link> : null}
    </li>
  );
}

/** A labelled section of tiles (h2 + list). */
export function TileSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="tileSection" aria-labelledby={`section-${id}`} data-section={id}>
      <h2 id={`section-${id}`} className="panelTitle">{title}</h2>
      <ul className="tileGrid">{children}</ul>
    </section>
  );
}
