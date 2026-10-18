import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { BottomSheet, Button, Checkbox, Chip, SearchField, Text } from "../../ui";
import { areasOfGovernorate, EGYPT_AREAS, EGYPT_GOVERNORATES, governorateById, nameOf, searchAreas, sortByName, type EgyptArea } from "./egypt-areas";
import { pluralKey } from "../../i18n/plural";
import { pluralForm, selectGovernorate, toggleArea, type LocationCounts, type LocationSelection } from "./model";

export interface LocationSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly selection: LocationSelection;
  readonly onChange: (next: LocationSelection) => void;
  readonly counts: LocationCounts;
  /** Real number of outlets matching the current filters (footer button). */
  readonly resultCount: number;
  readonly locale: "ar" | "en";
  readonly t: (key: string, opts?: Record<string, string | number>) => string;
  readonly num: (n: number) => string;
}

/** Location sheet for the outlets list: governorate first, then a searchable, multi-select area list. Applies live; the footer shows the real count. */
export function LocationSheet(p: LocationSheetProps) {
  const { t, num, locale, counts, selection } = p;
  const [areaQuery, setAreaQuery] = useState("");

  const governorates = useMemo(
    () => sortByName(EGYPT_GOVERNORATES.filter((g) => (counts.governorates[g.id] ?? 0) > 0 || g.id === selection.governorateId), locale),
    [counts.governorates, selection.governorateId, locale],
  );
  const areas = useMemo(() => {
    const pool = selection.governorateId === null ? EGYPT_AREAS : areasOfGovernorate(selection.governorateId);
    const visible = pool.filter((x) => (counts.areas[x.id] ?? 0) > 0 || selection.areaIds.includes(x.id));
    return sortByName(searchAreas(visible, areaQuery), locale);
  }, [selection, counts.areas, areaQuery, locale]);

  const withCount = (name: string, n: number) => `${name} · ${num(n)}`;
  const gov = (x: EgyptArea) => governorateById(x.governorateId);
  const heading = (key: string) => <Text variant="headline" weight="500" accessibilityRole="header">{t(key)}</Text>;

  return (
    <BottomSheet visible={p.visible} onClose={p.onClose} title={t("storesDir.filter.title")} closeLabel={t("common.close")}>
      <ScrollView style={{ maxHeight: 520 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 20, paddingBottom: 8 }} testID="stores-location-sheet">
        <View style={{ gap: 8 }}>
          {heading("storesDir.filter.governorate")}
          <View accessibilityRole="radiogroup" accessibilityLabel={t("storesDir.filter.governorate")} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip role="radio" label={t("storesDir.filter.allGovernorates")} selected={selection.governorateId === null} onPress={() => p.onChange(selectGovernorate(selection, null))} testID="stores-gov-all" />
            {governorates.map((g) => (
              <Chip key={g.id} role="radio" label={withCount(nameOf(g, locale), counts.governorates[g.id] ?? 0)} selected={selection.governorateId === g.id}
                accessibilityLabel={t(pluralKey("storesDir.filter.govA11y", counts.governorates[g.id] ?? 0), { name: nameOf(g, locale), n: num(counts.governorates[g.id] ?? 0) })}
                onPress={() => p.onChange(selectGovernorate(selection, g.id))} testID={`stores-gov-${g.id}`} />
            ))}
          </View>
        </View>
        <View style={{ gap: 8 }}>
          {heading("storesDir.filter.area")}
          <SearchField value={areaQuery} onChangeText={setAreaQuery} placeholder={t("storesDir.filter.areaSearch")} label={t("storesDir.filter.areaSearch")} clearLabel={t("storesDir.clear")} testID="stores-area-search" />
          {areas.length === 0 ? <Text variant="caption" secondary>{t("storesDir.filter.areaNone")}</Text> : null}
          {areas.map((x) => {
            const g = gov(x);
            const label = withCount(nameOf(x, locale), counts.areas[x.id] ?? 0);
            return (
              <Checkbox key={x.id} label={selection.governorateId === null && g !== undefined ? `${label} (${nameOf(g, locale)})` : label}
                value={selection.areaIds.includes(x.id)} onValueChange={() => p.onChange(toggleArea(selection, x))} />
            );
          })}
          {areas.some((x) => !x.verified) ? <Text variant="caption" secondary>{t("storesDir.filter.unverifiedNote")}</Text> : null}
        </View>
        <View style={{ gap: 4 }} accessibilityRole="summary" testID="stores-region-row">
          <Text variant="body" weight="600">{t("storesDir.filter.regionValue")}</Text>
          <Text variant="caption" secondary>{t("storesDir.filter.regionNote")}</Text>
        </View>
      </ScrollView>
      <View style={{ gap: 8 }}>
        <Button title={p.resultCount === 0 ? t("storesDir.filter.showNone") : t(`storesDir.filter.show${pluralForm(p.resultCount)}`, { n: num(p.resultCount) })} onPress={p.onClose} disabled={p.resultCount === 0} testID="stores-location-apply" />
        {selection.governorateId !== null ? <Button title={t("storesDir.filter.clearAll")} variant="ghost" onPress={() => p.onChange({ governorateId: null, areaIds: [] })} testID="stores-location-clear" /> : null}
      </View>
    </BottomSheet>
  );
}
