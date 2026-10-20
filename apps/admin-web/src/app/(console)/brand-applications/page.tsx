import Link from "next/link";
import { BrandShortcuts } from "../../../components/brand-shortcuts";
import { Pager, QueueFilterForm, QueueTable } from "../../../components/brand-ui";
import { ErrorBlock, PageHeader } from "../../../components/ui";
import { getConsole } from "../../../server/console";
import { pickBrandLabels } from "../../../view-models/brand-labels";
import { flashFor, parseQueueFilters, queueApiQuery, queueRows } from "../../../view-models/brand-review";
import { serverNow } from "../../../view-models/common";

export default async function BrandQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = parseQueueFilters(sp);
  const r = await c.api.brandQueue(queueApiQuery(f));
  const flash = flashFor(typeof sp.r === "string" ? sp.r : undefined);
  const rows = r.ok ? queueRows(r.value.data.items, serverNow(r.value.serverNowMs, c.deviceNowMs), c.selfId) : [];
  return (
    <>
      <PageHeader title={c.t("brand.queue.title")} intro={c.t("brand.queue.intro")} />
      <BrandShortcuts scope="queue" labels={pickBrandLabels(c.t)} mineHref="/brand-applications/mine" queueHref="/brand-applications" />
      {flash === null ? null : <p role={flash.tone === "ok" ? "status" : "alert"} className={`notice ${flash.tone}`}>{c.t(flash.key)}</p>}
      <nav className="row tabs" aria-label={c.t("brand.views")}>
        <Link className="btn primary" href="/brand-applications" aria-current="page">{c.t("brand.view.queue")}</Link>
        <Link className="btn" href="/brand-applications/mine">{c.t("brand.view.mine")}</Link>
        <span className="muted">{c.t("brand.sc.hint")}</span>
      </nav>
      <QueueFilterForm f={f} t={c.t} lockAssignee={false} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : (
        <>
          <QueueTable rows={rows} t={c.t} base="/brand-applications" />
          <Pager f={f} nextCursor={r.value.data.page.next_cursor} t={c.t} />
        </>
      )}
    </>
  );
}
