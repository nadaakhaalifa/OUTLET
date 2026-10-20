import { normalizeImageType, type ImageSource, type ImageSourcePort, type PickOutcome } from "./model";

/**
 * Camera and photo library through expo-image-picker (already a dependency; loaded lazily so tests and the web
 * bundle never pull the native module). EXIF is not requested. Permissions are asked only when the shopper taps.
 */
export class ExpoImageSource implements ImageSourcePort {
  async pick(source: ImageSource): Promise<PickOutcome> {
    const IP = await import("expo-image-picker");
    if (source === "camera") {
      const perm = await IP.requestCameraPermissionsAsync();
      if (!perm.granted) return { kind: "denied" };
    } else {
      const perm = await IP.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return { kind: "denied" };
    }
    const options = { mediaTypes: ["images"] as ("images")[], quality: 0.8, allowsMultipleSelection: false, exif: false };
    const r = source === "camera" ? await IP.launchCameraAsync(options) : await IP.launchImageLibraryAsync(options);
    if (r.canceled) return { kind: "cancelled" };
    const a = r.assets[0];
    if (a === undefined) return { kind: "cancelled" };
    return {
      kind: "picked",
      image: {
        uri: a.uri,
        contentType: normalizeImageType(a.mimeType, a.uri),
        sizeBytes: typeof a.fileSize === "number" ? a.fileSize : null,
        width: a.width > 0 ? a.width : null,
        height: a.height > 0 ? a.height : null,
      },
    };
  }
}
