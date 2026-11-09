import type { Locale, Translator } from "@outlet/i18n";
import { fmtDate, fmtDateTime } from "../../lib/fmt";
import { tileState, type TileKey, type Tiles } from "../../lib/dashboard";
import { Sparkline } from "../kit/Sparkline";
import { Tile } from "../kit/Tile";
import { DESCRIBERS, tileLabel, type TileBody } from "./tileModel";

/** Day strings from the API are market-local dates (YYYY-MM-DD): format them as plain dates, never shifted by a time zone. */
export const shortDay = (day: string, locale: Locale): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat(locale === "ar-EG" ? "ar-EG" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
};

/**
 * One tile from the dashboard response. forbidden -> nothing is rendered. unavailable -> the reason in words (never a zero).
 * ok -> the figure, its notes and when it was computed; a figure older than its refresh window also says "Stale since".
 */
export function HomeTile({ tileKey, tiles, now, t, locale, base, rtl, href, spark }: {
  tileKey: TileKey;
  tiles: Tiles;
  now: Date;
  t: Translator;
  locale: Locale;
  base: string;
  rtl: boolean;
  /** Overrides the destination (Today cards open their pop page). */
  href?: string | null;
  spark?: readonly { readonly day: string; readonly value: number }[];
}) {
  const s = tileState(tileKey, tiles[tileKey], now);
  if (s.kind === "hidden") return null;
  const label = tileLabel(t, tileKey);
  if (s.kind === "unavailable") return <Tile tileKey={tileKey} icon="info" label={label} note={<span data-testid="tile-unavailable">{t(`admin.home.unavailable.${s.reason}`)}</span>} />;
  const describe = DESCRIBERS[tileKey] as ((d: unknown, c: { t: Translator; locale: Locale }) => TileBody) | undefined;
  if (describe === undefined) return null;
  const b = describe(s.data, { t, locale });
  const dest = href !== undefined ? href : b.href === null ? null : `${base}${b.href}`;
  const notes = [...b.notes, s.staleSince !== null ? t("admin.home.staleSince", { time: fmtDateTime(s.staleSince, locale) }) : t("admin.home.updated", { time: fmtDateTime(s.asOf, locale) })];
  return (
    <Tile
      tileKey={tileKey}
      icon={b.icon}
      label={label}
      {...(b.value !== undefined ? { value: b.value } : {})}
      note={<>{notes.map((x, i) => <span key={i} className="tileNoteLine">{x}</span>)}</>}
      {...(dest !== null ? { href: dest, linkLabel: t("admin.kit.attention.open") } : {})}
      {...(b.alert === undefined ? {} : { status: b.alert ? ("alert" as const) : ("ok" as const), statusLabel: t(b.alert ? "admin.kit.statusAlert" : "admin.kit.statusOk") })}
    >
      {spark !== undefined && spark.length > 0 ? <Sparkline values={spark.map((p) => p.value)} rtl={rtl} label={t("admin.home.pop.seriesTitle", { days: 14 })} valueText={(i, v) => `${fmtDate(`${spark[i]?.day ?? ""}T00:00:00Z`, locale)}: ${String(v)}`} /> : null}
    </Tile>
  );
}
