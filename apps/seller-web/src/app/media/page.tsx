import { MediaCompare } from "../../components/MediaCompare";
import { ScreenFrame } from "../../components/ScreenFrame";
import { loadProductMedia } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";

export default async function MediaPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadProductMedia(ctx);
  return (
    <section aria-labelledby="md-h">
      <h2 id="md-h">{t("media.title")}</h2>
      <p className="hint">{t("media.intro")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm) => vm.unavailable ? <p className="banner" role="note">{t("media.unavailable")}</p> : vm.rows.length === 0 ? <p className="hint">{t("media.none")}</p> : (
          <div className="media-grid">
            {vm.rows.map((r) => <MediaCompare key={r.id} row={r} storeId={vm.storeId} locale={locale} />)}
          </div>
        )}
      </ScreenFrame>
    </section>
  );
}
