import { z } from 'zod';

/** What the server puts in a push notification's data (see FcmPushChannel). Treated as untrusted:
 *  only a well-formed conversation id is ever turned into a route. */
const pushDataSchema = z.object({ conversationId: z.uuid() });

/** The route a tapped notification opens, or null when it carries no usable conversation. */
export function routeForNotification(data: unknown): `/c/${string}` | null {
  const parsed = pushDataSchema.safeParse(data);
  return parsed.success ? `/c/${parsed.data.conversationId}` : null;
}

/** The unread total shown on the app icon: muted conversations don't count. */
export function totalUnread(
  conversations: ReadonlyArray<{ lastSeq: number; lastReadSeq: number; muted: boolean }>,
): number {
  let total = 0;
  for (const c of conversations) {
    if (!c.muted) total += Math.max(0, c.lastSeq - c.lastReadSeq);
  }
  return total;
}
