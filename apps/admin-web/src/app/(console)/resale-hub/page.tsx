import { ErrorBlock, PageHeader } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { getConsole } from "../../../server/console";

export default async function ResaleHubPage() {
  const c = await getConsole();
  const f = await c.api.flags("kill_switch");
  return (
    <>
      <PageHeader title={c.t("hub.title")} intro={c.t("hub.intro")} />
      {!f.ok ? <ErrorBlock error={f.error} c={c} /> : <SwitchStrip items={f.value.data.items} keys={["kill.resale_lane", "kill.hub_consolidation"]} c={c} />}
      <p><a href="/flags">{c.t("nav.flags")}</a></p>
      <h2>{c.t("hub.listings")}</h2>
      <p className="muted">{c.t("common.noEndpoint")}</p>
    </>
  );
}
