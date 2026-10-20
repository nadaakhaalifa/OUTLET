import Link from "next/link";
import { Badge, PageHeader } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { calendarRows, freezeWarning } from "../../../view-models/calendar";

export default async function CalendarPage() {
  const c = await getConsole();
  const now = c.deviceNowMs;
  const year = new Date(now).getUTCFullYear();
  const rows = calendarRows(now, [year, year + 1]);
  const warn = freezeWarning(rows);
  const iso = (ms: number): string => formatDateTime(new Date(ms).toISOString(), c.locale);
  return (
    <>
      <PageHeader title={c.t("calendar.title")} intro={c.t("calendar.intro")} />
      {warn === null ? null : (
        <p role="alert" className="notice error">{c.t("calendar.freezeActive", { event: c.t(`calendar.event.${warn.event.id}`), end: iso(warn.event.endMs) })}</p>
      )}
      <div className="table-wrap"><table>
        <thead><tr><th>{c.t("calendar.col.event")}</th><th>{c.t("calendar.col.start")}</th><th>{c.t("calendar.col.freeze")}</th><th>{c.t("col.status")}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={`${r.event.id}-${r.event.startMs}`}>
            <td>{c.t(`calendar.event.${r.event.id}`)}{r.event.estimated ? <div className="muted">{c.t("calendar.estimated")}</div> : null}</td>
            <td>{iso(r.event.startMs)}</td><td>{iso(r.freezeFromMs)}</td>
            <td><Badge tone={r.state === "freeze_active" ? "bad" : r.state === "event_running" ? "warn" : "neutral"}>{c.t(`calendar.state.${r.state}`)}</Badge></td>
          </tr>
        ))}</tbody>
      </table></div>
      <h2>{c.t("calendar.promos")}</h2>
      <p><Link href="/promotions">{c.t("calendar.promosLink")}</Link></p>
    </>
  );
}
