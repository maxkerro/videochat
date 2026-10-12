import { LIMITS, createAttachmentUploadSchema, type Message } from '@videochat/shared';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { requestUpload, sendMessage, uploadToStorage } from '../data/api';
import { newClientMsgId, recordMessage } from '../data/outboxRunner';
import { session } from '../lib/api';
import { UploadError } from '../lib/errors';

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
  const startedAt = session.generation();
  const blob = await (await fetch(file.uri)).blob();
  // The bytes we will actually send, not the picker's idea of the size: the signed upload is
  // bound to the size we ask for.
  if (blob.size > LIMITS.attachmentMaxBytes) {
    throw new UploadError(`Files can be up to ${MAX_ATTACHMENT_MB} MB.`);
  }
  if (blob.size === 0) throw new UploadError('That file is empty.');
  const parsed = createAttachmentUploadSchema.safeParse({
    filename: file.name,
    contentType: file.contentType,
    sizeBytes: blob.size,
  });
  if (!parsed.success) {
    throw new UploadError(parsed.error.issues[0]?.message ?? 'That file can’t be sent.');
  }
  const upload = await requestUpload(conversationId, parsed.data);
  await uploadToStorage(upload, blob, onProgress);
  const caption = options.caption?.trim();
  const message = await sendMessage(conversationId, {
    clientMsgId: newClientMsgId(),
    attachmentId: upload.attachmentId,
    ...(caption ? { body: caption } : {}),
    ...(options.replyToId ? { replyToId: options.replyToId } : {}),
  });
  await recordMessage(message, startedAt);
  return message;
}
