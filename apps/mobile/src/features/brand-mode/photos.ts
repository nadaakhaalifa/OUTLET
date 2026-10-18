import * as ImagePicker from "expo-image-picker";

export type PickResult = { readonly kind: "ok"; readonly uris: readonly string[] } | { readonly kind: "cancelled" } | { readonly kind: "denied" };

/** Library (multi-select) or camera. Only URIs leave this module; EXIF/GPS is stripped server-side on re-encode. */
export async function pickPhotos(source: "library" | "camera", limit: number): Promise<PickResult> {
  if (limit <= 0) return { kind: "cancelled" };
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return { kind: "denied" };
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 });
    return r.canceled ? { kind: "cancelled" } : { kind: "ok", uris: r.assets.map((a) => a.uri) };
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && perm.accessPrivileges !== "limited") return { kind: "denied" };
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: limit, quality: 0.85 });
  return r.canceled ? { kind: "cancelled" } : { kind: "ok", uris: r.assets.map((a) => a.uri) };
}
