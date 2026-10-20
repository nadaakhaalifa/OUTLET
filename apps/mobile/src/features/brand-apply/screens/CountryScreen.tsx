import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button, Text, TextField } from "../../../ui";
import { ChoiceRow, FlowScreen } from "../components";
import { useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { countryList, countryName, flagEmoji } from "../countries";
import { stepProgress } from "../model";

export function CountryScreen() {
  const { t } = useTranslation();
  const s = useBrandApply();
  const nav = useFlowNav();
  const kind = s.draft.kind ?? "local";
  const [query, setQuery] = useState("");
  useEffect(() => { s.rememberStep("country"); }, [s.rememberStep]);
  const list = useMemo(() => countryList({ kind, query }), [kind, query]);
  const selected = s.draft.country;

  return (
    <FlowScreen
      eyebrow={t("brandApply.country.eyebrow")}
      title={t(kind === "local" ? "brandApply.country.localTitle" : "brandApply.country.globalTitle")}
      body={t(kind === "local" ? "brandApply.country.localBody" : "brandApply.country.globalBody")}
      progress={stepProgress("country", nav.steps)}
      onBack={nav.back}
      footer={<Button title={t("brandApply.common.continue")} disabled={selected === null} onPress={() => { s.patchDraft({ step: "account" }); nav.next("country"); }} testID="brand-country-continue" />}
    >
      {kind === "global" ? <TextField label={t("brandApply.country.search")} value={query} onChangeText={setQuery} testID="brand-country-search" /> : null}
      <View>
        {list.map((c) => (
          <ChoiceRow
            key={c.code}
            testID={`brand-country-${c.code}`}
            title={countryName(c, s.lang)}
            subtitle={s.lang === "ar" ? c.en : c.ar}
            leading={<Text style={{ fontSize: 26, lineHeight: 32 }} accessibilityRole="none">{flagEmoji(c.code)}</Text>}
            selected={selected === c.code}
            badge={c.code === "EG" ? t("brandApply.country.pinned") : undefined}
            onPress={() => s.patchDraft({ country: c.code })}
          />
        ))}
        {list.length === 0 ? <Text secondary>{t("brandApply.country.empty")}</Text> : null}
      </View>
    </FlowScreen>
  );
}
