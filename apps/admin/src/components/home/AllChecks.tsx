import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import { flattenTiles, tileState, type DashboardResponse } from "../../lib/dashboard";
import { TileSection } from "../kit/Tile";
import { HomeTile } from "./HomeTile";
import { CHECK_SECTIONS } from "./tileModel";

/** "All checks": every allowed tile grouped by area; an area with nothing visible is not rendered. */
export function AllChecks({ resp, now, t, locale, base, rtl }: { resp: DashboardResponse; now: Date; t: Translator; locale: Locale; base: string; rtl: boolean }) {
  const tiles = flattenTiles(resp);
  const sections = CHECK_SECTIONS.map((s) => ({ ...s, tiles: s.tiles.filter((k) => tileState(k, tiles[k], now).kind !== "hidden") })).filter((s) => s.tiles.length > 0);
  if (sections.length === 0) return null;
  return (
    <section aria-labelledby="home-checks" className="stack" data-section="checks">
      <h2 id="home-checks" className="panelTitle">{t("admin.home.checks.title")}</h2>
      {sections.map((s) => (
        <TileSection key={s.id} id={s.id} title={t(`admin.home.section.${s.id}` as MessageKey)}>
          {s.tiles.map((k) => <HomeTile key={k} tileKey={k} tiles={tiles} now={now} t={t} locale={locale} base={base} rtl={rtl} />)}
        </TileSection>
      ))}
    </section>
  );
}
