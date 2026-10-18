import { View } from "react-native";
import { Button, Icon, Text, useTheme } from "../ui";
import { Illustration, type IllustrationName } from "../art";

/** Thin banner shown while the device is offline. Pure presentation: callers decide `visible`. */
export function OfflineBanner(props: { visible: boolean; message: string; actionLabel?: string; onAction?: () => void }) {
  const { colors } = useTheme();
  if (!props.visible) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={props.message}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: colors.fill, borderStartWidth: 2, borderStartColor: colors.textPrimary }}
    >
      <Icon name="cloud-offline-outline" size={18} />
      <Text variant="callout" style={{ flex: 1 }} accessibilityRole="none">{props.message}</Text>
      {props.actionLabel !== undefined && props.onAction !== undefined ? (
        <Button title={props.actionLabel} variant="ghost" fullWidth={false} onPress={props.onAction} />
      ) : null}
    </View>
  );
}

/** Full-width illustrated empty or error state with one clear action. */
export function StateScreen(props: { illustration: IllustrationName; title: string; description?: string; actionTitle?: string; onAction?: () => void }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 48, paddingHorizontal: 12, gap: 14 }}>
      <Illustration name={props.illustration} size={112} />
      <Text variant="title2" align="center" accessibilityRole="header">{props.title}</Text>
      {props.description !== undefined ? <Text variant="callout" secondary align="center">{props.description}</Text> : null}
      {props.actionTitle !== undefined && props.onAction !== undefined ? (
        <View style={{ alignSelf: "stretch", marginTop: 8 }}><Button title={props.actionTitle} onPress={props.onAction} /></View>
      ) : null}
    </View>
  );
}
