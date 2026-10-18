import { ScrollView, View } from "react-native";
import { useState } from "react";
import { spacing } from "@outlet/ui-tokens";
import { BottomSheet, Button, Icon, SwitchRow, Text } from "../../ui";
import { useFormat } from "../home/parts";
import { canShare, type Wishlist } from "./model";

export interface ListSettingsSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly list: Wishlist;
  readonly shareActive: boolean;
  readonly offline: boolean;
  readonly bottomInset: number;
  readonly onCoolOff: (on: boolean) => void;
  readonly onCreateShare: (hidePrices: boolean) => void;
  readonly onRevokeShare: () => void;
}

/** List settings: cool-off switch with its full helper text, and (gift and birthday lists only) the share controls. */
export function ListSettingsSheet(props: ListSettingsSheetProps) {
  const f = useFormat();
  const [hidePrices, setHidePrices] = useState(false);
  const l = props.list;
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title={f.t("savedTab.listSettings")} closeLabel={f.t("common.close")} maxHeightRatio={0.9}>
      <ScrollView contentContainerStyle={{ gap: spacing.lg, paddingBottom: props.bottomInset }} testID="list-settings-sheet">
        {l.intent === "want" ? (
          <View style={{ gap: spacing.xs }}>
            <SwitchRow label={f.t("savedTab.coolOffTitle")} value={l.coolOffEnabled} disabled={props.offline} onValueChange={props.onCoolOff} />
            <Text variant="caption" secondary>{f.t("savedTab.coolOffHelper")}</Text>
          </View>
        ) : null}
        {canShare(l) ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="caption" secondary>{f.t("wishlists.shareHelp")}</Text>
            <SwitchRow label={f.t("savedTab.hidePrices")} value={hidePrices} disabled={props.offline} onValueChange={setHidePrices} />
            {props.shareActive ? (
              <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
                <Icon name="link-outline" size={16} color="textSecondary" />
                <Text variant="caption" secondary>{f.t("savedTab.shared")}</Text>
              </View>
            ) : null}
            <Button variant="secondary" title={f.t("savedTab.createLink")} disabled={props.offline} onPress={() => props.onCreateShare(hidePrices)} testID="list-share-create" />
            {props.shareActive ? <Button variant="ghost" title={f.t("savedTab.stopSharing")} disabled={props.offline} onPress={props.onRevokeShare} testID="list-share-stop" /> : null}
          </View>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}
