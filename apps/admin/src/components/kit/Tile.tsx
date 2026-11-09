import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * One dashboard tile: plain label, big number, short note, optional detail and a link to the screen
 * behind it. `status` adds a chip with an icon and words (colour is never the only signal).
 */
export function Tile({ tileKey, icon, label, value, note, href, linkLabel, status, statusLabel, wide = false, children }: {
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
  children?: ReactNode;
}) {
  const headingId = `tile-${tileKey}`;
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
      {href && linkLabel ? <Link href={href} className="tileLink">{linkLabel}</Link> : null}
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
