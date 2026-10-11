import { ProductEditor } from "../../../components/ProductEditor";
import { SizeChartEditor } from "../../../components/SizeChartEditor";
import { pageCtx } from "../../../page-context";

export default async function NewProductPage() {
  const { t, locale } = await pageCtx();
  return (
    <section aria-labelledby="ed-h">
      <h2 id="ed-h">{t("editor.title")}</h2>
      <ProductEditor locale={locale} />
      <SizeChartEditor locale={locale} />
    </section>
  );
}
