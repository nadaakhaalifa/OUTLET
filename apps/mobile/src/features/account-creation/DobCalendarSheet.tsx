import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, View } from "react-native";
import { BottomSheet, Button, IconButton, Text, useTheme } from "../../ui";
import {
  addMonths, canGoNext, canGoPrev, initialView, isDayDisabled, isSameDay, localeDigits, monthMatrix,
  weekdayOrder, yearIndex, yearList, type CalDay,
} from "../dob-calendar";

const ROW = 44;

/**
 * Real month-grid calendar in a bottom sheet. The week starts on Saturday (Egypt). Future days are
 * disabled, the header opens a year list. Nothing is preselected unless the typed date is valid.
 */
export function DobCalendarSheet(props: {
  visible: boolean;
  onClose: () => void;
  selected: CalDay | null;
  today: CalDay;
  onDone: (day: CalDay) => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const lang = i18n.language === "ar" ? "ar" : "en";
  const locale = lang === "ar" ? "ar-EG" : "en-GB";
  const { selected, today, visible } = props;
  const [view, setView] = useState(() => initialView(selected, today));
  const [pick, setPick] = useState<CalDay | null>(selected);
  const [yearMode, setYearMode] = useState(false);
  const yearsRef = useRef<ScrollView>(null);

  // Re-seed each time the sheet opens: the field may have been typed into meanwhile.
  useEffect(() => {
    if (!visible) return;
    setView(initialView(selected, today));
    setPick(selected);
    setYearMode(false);
  }, [visible]);

  const monthNames = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2001, i, 1))));
  }, [locale]);
  const order = useMemo(() => weekdayOrder(), []);
  const weekdayNames = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return order.map((wd) => f.format(new Date(Date.UTC(2001, 0, 7 + wd)))); // 2001-01-07 is a Sunday
  }, [locale, order]);
  const weeks = useMemo(() => monthMatrix(view.year, view.month), [view.year, view.month]);
  const years = useMemo(() => yearList(today.year), [today.year]);
  const title = `${monthNames[view.month - 1] ?? ""} ${localeDigits(view.year, lang)}`;

  const step = (delta: number) => setView((v) => addMonths(v.year, v.month, delta));

  return (
    <BottomSheet visible={visible} onClose={props.onClose} title={t("onboarding.dob.pickerTitle")} closeLabel={t("onboarding.dob.pickerClose")} maxHeightRatio={0.85}>
      <View testID="dob-calendar-sheet" style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <IconButton icon="chevron-back" directional label={t("onboarding.dob.prevMonth")} onPress={() => step(-1)} disabled={yearMode || !canGoPrev(view.year, view.month)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${t("onboarding.dob.pickYear")}`}
            accessibilityState={{ expanded: yearMode }}
            onPress={() => setYearMode((m) => !m)}
            style={{ minHeight: ROW, paddingHorizontal: 12, justifyContent: "center" }}
          >
            <Text variant="callout" weight="600">{title}</Text>
          </Pressable>
          <IconButton icon="chevron-forward" directional label={t("onboarding.dob.nextMonth")} onPress={() => step(1)} disabled={yearMode || !canGoNext(view.year, view.month, today)} />
        </View>

        {yearMode ? (
          <ScrollView
            ref={yearsRef}
            style={{ height: ROW * 6 }}
            onLayout={() => yearsRef.current?.scrollTo({ y: Math.max(0, yearIndex(view.year, today.year) - 2) * ROW, animated: false })}
          >
            {years.map((y) => {
              const on = y === view.year;
              return (
                <Pressable
                  key={y}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => { setView((v) => ({ year: y, month: y === today.year ? Math.min(v.month, today.month) : v.month })); setYearMode(false); }}
                  style={{ height: ROW, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: on ? colors.brand : "transparent" }}
                >
                  <Text variant="body" weight={on ? "600" : "400"} style={{ color: on ? colors.onBrand : colors.textPrimary }}>{localeDigits(y, lang)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <View>
            <View style={{ flexDirection: "row" }}>
              {weekdayNames.map((n, i) => (
                <View key={order[i]} style={{ flex: 1, height: 32, alignItems: "center", justifyContent: "center" }}>
                  <Text variant="caption" secondary accessibilityRole="none">{n}</Text>
                </View>
              ))}
            </View>
            {weeks.map((row, r) => (
              <View key={r} style={{ flexDirection: "row" }}>
                {row.map((d, c) => {
                  if (d === null) return <View key={c} style={{ flex: 1, height: ROW }} />;
                  const day: CalDay = { year: view.year, month: view.month, day: d };
                  const disabled = isDayDisabled(day.year, day.month, day.day, today);
                  const on = isSameDay(pick, day);
                  const isToday = isSameDay(today, day);
                  return (
                    <View key={c} style={{ flex: 1, height: ROW, alignItems: "center", justifyContent: "center" }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${localeDigits(d, lang)} ${title}`}
                        accessibilityState={{ selected: on, disabled }}
                        disabled={disabled}
                        onPress={() => setPick(day)}
                        style={{
                          width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center",
                          backgroundColor: on ? colors.brand : "transparent",
                          borderWidth: isToday && !on ? 1.5 : 0, borderColor: colors.brand,
                          opacity: disabled ? 0.35 : 1,
                        }}
                      >
                        <Text variant="body" weight={on ? "600" : "400"} style={{ color: on ? colors.onBrand : colors.textPrimary }}>{localeDigits(d, lang)}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        )}

        <Button
          title={t("onboarding.dob.done")}
          variant="brand"
          disabled={pick === null || yearMode}
          onPress={() => { if (pick !== null) props.onDone(pick); }}
        />
      </View>
    </BottomSheet>
  );
}
