import { getContext } from "../server-context";

export default async function Loading() {
  const { t } = await getContext();
  return <p role="status" aria-live="polite">{t("state.loading")}</p>;
}
