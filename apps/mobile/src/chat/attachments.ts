import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { PickedFile } from '../uploads/flow';

export type { PickedFile } from '../uploads/flow';

const nameFromUri = (uri: string, fallback: string) =>
  decodeURIComponent(uri.split('/').pop() ?? '') || fallback;

function fromAsset(asset: ImagePicker.ImagePickerAsset): PickedFile {
  return {
    uri: asset.uri,
    name: asset.fileName ?? nameFromUri(asset.uri, 'photo.jpg'),
    contentType: asset.mimeType ?? 'image/jpeg',
    sizeBytes: asset.fileSize ?? null,
    width: asset.width,
    height: asset.height,
  };
}

/** Why the camera could not be used, for a message to the person. */
export class CameraUnavailableError extends Error {
  constructor(readonly canAskAgain: boolean) {
    super(
      canAskAgain
        ? 'Chat needs camera access to take a photo.'
        : 'Camera access is turned off for Chat. You can turn it on in your phone’s Settings.',
    );
    this.name = 'CameraUnavailableError';
  }
}

/** Opens the camera. The permission is asked for here, the first time it is used, not at launch. */
export async function takePhoto(): Promise<PickedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new CameraUnavailableError(permission.canAskAgain);
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  return fromAsset(asset);
}

/** The photo library. The system picker needs no permission of ours. */
export async function pickPhoto(): Promise<PickedFile | null> {
  // Full quality: the app shrinks and re-encodes it once, in `prepareFile`.
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  return fromAsset(asset);
}

export async function pickFile(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  return {
    uri: asset.uri,
    name: asset.name,
    contentType: asset.mimeType ?? 'application/octet-stream',
    sizeBytes: asset.size ?? null,
  };
}
