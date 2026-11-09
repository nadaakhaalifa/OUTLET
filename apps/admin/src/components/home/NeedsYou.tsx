import Link from "next/link";
import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import type { Needs, NeedRow } from "../../lib/attention";
import { fmtNumber } from "../../lib/fmt";
import { Icon } from "../kit/Icon";

const title = (t: Translator, id: NeedRow["id"]): string => t(`admin.home.need.${id}.title` as MessageKey, { days: 3 });
const hint = (t: Translator, id: NeedRow["id"]): string => t(`admin.home.need.${id}.hint` as MessageKey, { hours: 72 });

/**
 * "Needs you today": only rows with a count, urgent first. A check that could not be read removes the all-clear claim.
 * A row without a destination page is shown without a link (no dead ends that go nowhere).
 */
export function NeedsYou({ needs, t, locale, base }: { needs: Needs; t: Translator; locale: Locale; base: string }) {
  return (
    <section className="attention" aria-labelledby="attention-title" data-attention-panel>
      <h2 id="attention-title" className="panelTitle">{t("admin.home.needs.title")}</h2>
      {needs.rows.length === 0 && !needs.incomplete ? <p className="attentionClear" data-testid="attention-clear"><Icon name="check" /><span>{t("admin.home.needs.allClear")}</span></p> : null}
      {needs.incomplete ? <p className="hint" role="status" data-testid="attention-incomplete"><Icon name="alert" /> {t("admin.home.needs.incomplete")}</p> : null}
      {needs.rows.length > 0 ? (
        <ul className="attentionList">
          {needs.rows.map((r) => {
            const inner = (
              <>
                <span className="attentionIcon"><Icon name={r.urgent ? "alert" : "info"} /></span>
                <span className="attentionText"><span className="attentionTitle">{title(t, r.id)}</span><span className="hint">{hint(t, r.id)}</span></span>
                <span className="attentionCount"><bdi>{fmtNumber(r.count, locale)}</bdi></span>
                {r.href !== null ? <span className="attentionGo">{t("admin.kit.attention.open")}</span> : null}
              </>
            );
            return (
              <li key={r.id} data-need={r.id} data-urgent={r.urgent ? true : undefined}>
                {r.href !== null ? <Link href={`${base}${r.href}`} className="attentionLink">{inner}</Link> : <div className="attentionLink">{inner}</div>}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
