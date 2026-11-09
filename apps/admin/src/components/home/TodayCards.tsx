import type { Locale, Translator } from "@outlet/i18n";
import { CARDS, tileState, type Tiles } from "../../lib/dashboard";
import { HomeTile } from "./HomeTile";

/** "Today": one card per tile the plan maps to a card, only the allowed ones; each opens its pop page. */
export function TodayCards({ tiles, now, t, locale, base, rtl }: { tiles: Tiles; now: Date; t: Translator; locale: Locale; base: string; rtl: boolean }) {
  const visible = CARDS.filter((c) => tileState(c.tile, tiles[c.tile], now).kind !== "hidden");
  if (visible.length === 0) return null;
  return (
    <section className="tileSection" aria-labelledby="home-today" data-section="today">
      <h2 id="home-today" className="panelTitle">{t("admin.home.today.title")}</h2>
      <ul className="tileGrid todayGrid">
        {visible.map((c) => {
          const raw = tiles[c.tile];
          const spark = c.tile === "orders_today" && raw.status === "ok" && "series_14d" in raw.data ? raw.data.series_14d : undefined;
          return <HomeTile key={c.slug} tileKey={c.tile} tiles={tiles} now={now} t={t} locale={locale} base={base} rtl={rtl} href={`${base}/today/${c.slug}`} {...(spark ? { spark } : {})} />;
        })}
      </ul>
    </section>
  );
}
