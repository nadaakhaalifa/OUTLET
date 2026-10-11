import type { Translator } from "../i18n";
import type { StatTile } from "../view-models/ads";

/** Tiles with a value of null say "not enough data" and never render zero. */
export function StatTiles({ tiles, t }: { tiles: readonly StatTile[]; t: Translator }) {
  return (
    <dl className="tiles">
      {tiles.map((x) => (
        <div className="tile" key={x.id}>
          <dt>{t(x.labelKey)}</dt>
          <dd>{x.value ?? <span className="hint">{t("p2.noValue")}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
