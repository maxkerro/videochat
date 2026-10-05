import { linkPreviewResponseSchema, type LinkPreview } from '@videochat/shared';
import { z } from 'zod';
import { apiDelete, apiGet } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

/** CHAT-031: the composer's preview for a URL being typed. */
export async function fetchLinkPreview(
  accessToken: string,
  url: string,
): Promise<LinkPreview | null> {
  const res = await apiGet(
    `/link-preview?url=${encodeURIComponent(url)}`,
    linkPreviewResponseSchema,
    {
      headers: authHeader(accessToken),
    },
  );
  return res.preview;
}

/** CHAT-031: the sender removes a sent message's preview. */
export function removeLinkPreview(
  accessToken: string,
  conversationId: string,
  messageId: string,
): Promise<unknown> {
  return apiDelete(
    `/conversations/${conversationId}/messages/${messageId}/link-preview`,
    z.unknown(),
    { headers: authHeader(accessToken) },
  );
}
