import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Screen, SegmentedControl } from "../../ui";
import { Blk } from "./LegalScreen";
import { legalDocView, type LegalDocId, type LegalLocale } from "./model";

export const COMBINED_DOCS: readonly LegalDocId[] = ["terms-of-service", "privacy-policy"];

/** Terms of Service and Privacy Policy in one screen (two tabs). The documents are the existing bundled drafts, unchanged. */
export function LegalCombinedScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const locale: LegalLocale = i18n.language === "en" ? "en" : "ar";
  const id = COMBINED_DOCS[index] ?? "terms-of-service";
  const view = legalDocView(id, locale);
  return (
    <Screen onBack={() => router.back()} backLabel={t("common.back")} testID="legal-combined">
      <SegmentedControl options={COMBINED_DOCS.map((d) => t(`legal.doc.${d}`))} index={index} onChange={setIndex} />
      <Banner tone="warning" message={t("legal.draftNotice")} />
      {view.blocks.map((b, i) => <Blk key={`${id}-${i}`} b={b} />)}
    </Screen>
  );
}
