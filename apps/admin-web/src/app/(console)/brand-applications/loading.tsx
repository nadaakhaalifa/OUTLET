import { getConsole } from "../../../server/console";

export default async function Loading() {
  const c = await getConsole();
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{c.t("common.loading")}</span>
      <div className="skeleton h" />
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton row-s" />)}
    </div>
  );
}
