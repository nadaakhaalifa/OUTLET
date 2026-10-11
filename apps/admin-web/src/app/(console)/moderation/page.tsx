import { Empty, ErrorBlock, Flash, PageHeader } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import { moderateAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { moderationRows } from "../../../view-models/queues";

export default async function ModerationPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.moderationQueue("HELD");
  const rows = r.ok ? moderationRows(r.value.data.items) : [];
  return (
    <>
      <PageHeader title={c.t("moderation.title")} intro={c.t("moderation.intro")} />
      <Flash code={sp.r} t={c.t} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : rows.map((m) => (
        <article key={m.targetId} className="card">
          <p className="muted">{m.targetType} · {m.holdReason ?? ""} · {formatDateTime(new Date(m.createdAtMs).toISOString(), c.locale)}</p>
          <p dir="auto">{m.text ?? c.t("common.none")}</p>
          {m.photoCount > 0 ? <p className="muted">{c.t("moderation.photos", { n: m.photoCount })}</p> : null}
          <div className="row">
            {(["publish", "reject"] as const).map((d) => (
              <form key={d} action={moderateAction}>
                <input type="hidden" name="target_type" value={m.targetType} />
                <input type="hidden" name="target_id" value={m.targetId} />
                <input type="hidden" name="decision" value={d} />
                <button className={d === "publish" ? "btn primary" : "btn danger"} type="submit">{c.t(d === "publish" ? "act.publish" : "act.rejectContent")}</button>
              </form>
            ))}
          </div>
        </article>
      ))}
    </>
  );
}
