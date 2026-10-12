import { LIMITS, createAttachmentUploadSchema, type Message } from '@videochat/shared';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { requestUpload, sendMessage, uploadToStorage } from '../data/api';
import { newClientMsgId, recordMessage } from '../data/outboxRunner';

export interface PickedFile {
  uri: string;
  name: string;
  contentType: string;
  /** May be unknown until the file is read. */
  sizeBytes: number | null;
}

const nameFromUri = (uri: string, fallback: string) =>
  decodeURIComponent(uri.split('/').pop() ?? '') || fallback;

export async function pickPhoto(): Promise<PickedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.85,
  });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  return {
    uri: asset.uri,
    name: asset.fileName ?? nameFromUri(asset.uri, 'photo.jpg'),
    contentType: asset.mimeType ?? 'image/jpeg',
    sizeBytes: asset.fileSize ?? null,
  };
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

export const MAX_ATTACHMENT_MB = LIMITS.attachmentMaxBytes / (1024 * 1024);

/**
 * CHAT-030 on mobile: ask for an upload slot, PUT the bytes straight to object storage, then send
 * the message that carries the attachment. Needs the network the whole way (a file is too big for
 * the offline outbox), so a failure is reported to the person rather than queued.
 */
export async function sendAttachment(
  conversationId: string,
  file: PickedFile,
  options: { caption?: string; replyToId?: string | null },
  onProgress: (fraction: number) => void,
): Promise<Message> {
  const blob = await (await fetch(file.uri)).blob();
  const input = createAttachmentUploadSchema.parse({
    filename: file.name,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes ?? blob.size,
  });
  const upload = await requestUpload(conversationId, input);
  await uploadToStorage(upload, blob, onProgress);
  const caption = options.caption?.trim();
  const message = await sendMessage(conversationId, {
    clientMsgId: newClientMsgId(),
    attachmentId: upload.attachmentId,
    ...(caption ? { body: caption } : {}),
    ...(options.replyToId ? { replyToId: options.replyToId } : {}),
  });
  await recordMessage(message);
  return message;
}
