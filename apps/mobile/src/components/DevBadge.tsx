/** Single, unobtrusive development indicator, mounted once in the root layout. Never rendered in release builds. */
import { useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getDevHints, isDevBadgeVisible, subscribeDevHints } from "../services/dev-hints";
import { currentBackendConfig } from "../services/release-guard";
import { apiBaseUrlFromEnv } from "../services/runtime";

export function DevBadge() {
  const insets = useSafeAreaInsets();
  const hints = useSyncExternalStore(subscribeDevHints, getDevHints, getDevHints);
  const [open, setOpen] = useState(false);
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;
  if (!isDevBadgeVisible(currentBackendConfig(apiBaseUrlFromEnv()), isDev, process.env["EXPO_PUBLIC_HIDE_DEV_BADGE"])) return null;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Development details"
        hitSlop={8}
        // Centered under the Dynamic Island so it never covers header icons (search, bag) in design reviews.
        style={{ position: "absolute", top: Math.max(insets.top - 12, 2), alignSelf: "center", opacity: 0.45, backgroundColor: "#000", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}
        testID="dev-badge"
      >
        <Text style={{ color: "#fff", fontSize: 10 }}>DEV · fixtures</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" }} onPress={() => setOpen(false)}>
          <View style={{ backgroundColor: "#fff", padding: 16, paddingBottom: insets.bottom + 16, borderTopStartRadius: 16, borderTopEndRadius: 16, maxHeight: "60%" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 8, color: "#111" }}>Development build · in-memory fakes</Text>
            <ScrollView>
              {hints.length === 0 ? <Text style={{ color: "#444" }}>No hints registered.</Text> : null}
              {hints.map((h) => <Text key={h.id} style={{ color: "#222", marginBottom: 8 }}>{h.text}</Text>)}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
