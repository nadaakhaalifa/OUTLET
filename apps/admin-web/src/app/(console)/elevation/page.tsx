import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { activateElevationAction, requestElevationAction, revokeElevationAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { elevationRow } from "../../../view-models/elevation";
import { REASON_CODES } from "../../../view-models/common";
import { admin } from "@outlet/domain";

export default async function ElevationPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.myElevations();
  const now = r.ok ? (r.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const rows = r.ok ? r.value.data.items.map((e) => elevationRow(e, c.selfId ?? "", now)) : [];
  const writes = c.posture.sensitiveWritesEnabled;
  const reasons = REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  return (
    <>
      <PageHeader title={c.t("elevation.title")} intro={c.t("elevation.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <section className="card">
        <h2>{c.t("elevation.request")}</h2>
        <p className="muted">{c.t("elevation.dualApprovalNote")}</p>
        <form action={requestElevationAction}>
          <label htmlFor="role">{c.t("col.role")}</label>
          <select id="role" name="role" required defaultValue="">
            <option value="" disabled>{c.t("common.choose")}</option>
            {admin.ADMIN_ROLE_NAMES.map((n) => (
              <option key={n} value={n}>{c.t(`role.${n}`)}{n === "super_admin" ? ` (${c.t("elevation.breakGlass")})` : ""}</option>
            ))}
          </select>
          <label htmlFor="reason_code">{c.t("common.reason")}</label>
          <select id="reason_code" name="reason_code" required defaultValue="">
            <option value="" disabled>{c.t("common.choose")}</option>
            {reasons.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
          </select>
          <label htmlFor="ttl">{c.t("elevation.ttlMinutes")}</label>
          <input id="ttl" name="ttl_minutes" inputMode="numeric" pattern="[0-9]{1,3}" dir="ltr" />
          <div className="row end"><button className="btn primary" type="submit" disabled={!writes}>{c.t("act.request")}</button></div>
        </form>
      </section>
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.t("col.role")}</th><th>{c.t("col.status")}</th><th>{c.t("col.expires")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{c.t(`role.${e.role}`)} {e.breakGlass ? <Badge tone="bad">{c.t("elevation.breakGlass")}</Badge> : null}</td>
                  <td><Badge tone={e.live ? "ok" : "neutral"}>{e.lapsed ? "LAPSED" : e.state}</Badge></td>
                  <td>{e.remainingMs === null ? "" : c.t("clock.left.minutes", { n: Math.floor(e.remainingMs / 60_000) })}</td>
                  <td className="row">
                    <form action={activateElevationAction}><input type="hidden" name="id" value={e.id} />
                      <button className="btn" type="submit" disabled={!e.canActivate || !writes}>{c.t("act.activate")}</button></form>
                    <form action={revokeElevationAction}><input type="hidden" name="id" value={e.id} />
                      <button className="btn danger" type="submit" disabled={!e.canRevoke || !writes}>{c.t("act.revoke")}</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
