import Link from "next/link";
import { BrandShortcuts } from "../../../../components/brand-shortcuts";
import { Pager, QueueFilterForm, QueueTable } from "../../../../components/brand-ui";
import { ErrorBlock, PageHeader } from "../../../../components/ui";
import { getConsole } from "../../../../server/console";
import { pickBrandLabels } from "../../../../view-models/brand-labels";
import { parseQueueFilters, queueApiQuery, queueRows } from "../../../../view-models/brand-review";
import { serverNow } from "../../../../view-models/common";

/** "My claimed applications": the same queue with assignee=me forced (the filter is not editable here). */
export default async function MyBrandApplicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const f = { ...parseQueueFilters(await searchParams), assignee: "me" as const };
  const r = await c.api.brandQueue(queueApiQuery(f));
  const rows = r.ok ? queueRows(r.value.data.items, serverNow(r.value.serverNowMs, c.deviceNowMs), c.selfId) : [];
  return (
    <>
      <PageHeader title={c.t("brand.mine.title")} intro={c.t("brand.mine.intro")} />
      <BrandShortcuts scope="queue" labels={pickBrandLabels(c.t)} mineHref="/brand-applications/mine" queueHref="/brand-applications" />
      <nav className="row tabs" aria-label={c.t("brand.views")}>
        <Link className="btn" href="/brand-applications">{c.t("brand.view.queue")}</Link>
        <Link className="btn primary" href="/brand-applications/mine" aria-current="page">{c.t("brand.view.mine")}</Link>
      </nav>
      <QueueFilterForm f={f} t={c.t} lockAssignee />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : (
        <>
          <QueueTable rows={rows} t={c.t} base="/brand-applications" />
          <Pager f={f} nextCursor={r.value.data.page.next_cursor} t={c.t} />
        </>
      )}
    </>
  );
}
