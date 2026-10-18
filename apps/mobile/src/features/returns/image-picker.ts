import type { Photo, PhotoPickerPort } from "./model";

/** Device photo library via expo-image-picker (loaded lazily so tests and the web bundle never pull the native module). */
export class ExpoPhotoPicker implements PhotoPickerPort {
  async pick(): Promise<Photo | null> {
    const IP = await import("expo-image-picker");
    const perm = await IP.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return null;
    const r = await IP.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7, allowsMultipleSelection: false });
    if (r.canceled) return null;
    const a = r.assets[0];
    return a === undefined ? null : { uri: a.uri };
  }
}
