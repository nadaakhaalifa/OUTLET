/** Device file pickers (camera, photo library, files). Not unit-tested: needs the native runtime. Never logs names or contents. */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { BrandApplyError, type FilePickerPort, type PickSource, type PickedFile } from "./model";

export class DevicePicker implements FilePickerPort {
  constructor(private readonly allowSample: boolean) {}

  async pick(source: PickSource): Promise<PickedFile | null> {
    if (source === "sample") {
      if (!this.allowSample) return null;
      // Development fixture so the flow can be reviewed on a simulator without a camera or documents.
      return { uri: "sample://document.pdf", mimeType: "application/pdf", sizeBytes: 318_000, name: "sample.pdf" };
    }
    if (source === "files") {
      const r = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/jpeg", "image/png"], copyToCacheDirectory: true, multiple: false });
      const a = r.canceled ? undefined : r.assets[0];
      return a === undefined ? null : { uri: a.uri, mimeType: a.mimeType ?? "application/octet-stream", sizeBytes: a.size ?? 0, name: a.name };
    }
    const perm = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) throw new BrandApplyError("failed", "permission_denied");
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.85, allowsEditing: false, exif: false };
    const r = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = r.canceled ? undefined : r.assets[0];
    return a === undefined ? null : { uri: a.uri, mimeType: a.mimeType ?? "image/jpeg", sizeBytes: a.fileSize ?? 0, name: a.fileName ?? undefined };
  }
}
