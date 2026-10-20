import { DoraLoader } from "../../../components/dora-loader";
import { PageHeader } from "../../../components/ui";
import { getConsole } from "../../../server/console";
import { NOT_MEASURED_PLACEHOLDERS } from "../../../view-models/dora";
import type { MessageKey } from "../../../i18n";

export default async function EngineeringPage() {
  const c = await getConsole();
  const names = Object.fromEntries(
    ["deploymentFrequency", "leadTime", "changeFailureRate", "timeToRecover", "reworkRate"].map((k) => [k, c.t(`eng.metric.${k}` as MessageKey)]),
  );
  return (
    <>
      <PageHeader title={c.t("eng.title")} intro={c.t("eng.intro")} />
      <DoraLoader labels={{
        input: c.t("eng.input"), file: c.t("eng.file"), load: c.t("eng.load"), invalid: c.t("eng.invalid"), notMeasured: c.t("common.notMeasured"),
        proxy: c.t("eng.proxy", { proxy: "{{proxy}}" }), window: c.t("eng.window", { days: "{{days}}", at: "{{at}}" }), basis: c.t("eng.basis", { basis: "{{basis}}" }),
        sample: c.t("eng.sample", { n: "{{n}}" }), band: c.t("eng.band", { band: "{{band}}" }), series: c.t("eng.series"), week: c.t("eng.col.week"),
        deployments: c.t("eng.col.deployments"), failures: c.t("eng.col.failures"), rework: c.t("eng.col.rework"), notes: c.t("eng.notes"), metricNames: names,
      }} />
      <h2>{c.t("eng.cost")}</h2>
      <p className="muted">{c.t("eng.costNote")}</p>
      <ul>{NOT_MEASURED_PLACEHOLDERS.map((k) => <li key={k}>{c.t(`eng.cost.${k}` as MessageKey)}: {c.t("common.notMeasured")}</li>)}</ul>
    </>
  );
}
