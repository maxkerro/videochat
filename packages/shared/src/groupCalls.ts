import { z } from 'zod';

/*
 * CHAT-070: group calls in group conversations, carried by an SFU (LiveKit). The API only keeps
 * which call is running in which group and hands out room tokens; media never touches it.
 */

/** Most people in one group call (the story's 20). */
export const GROUP_CALL_MAX_PARTICIPANTS = 20;

export const GROUP_CALL_EVENTS = {
  /** server -> conversation members: a group call started, changed size, or ended (`call: null`). */
  updated: 'groupcall.updated',
} as const;

export const groupCallSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  startedBy: z.uuid().nullable(),
  startedAt: z.iso.datetime(),
  /** People in the call, as the SFU last reported (refreshed every few seconds). */
  participantCount: z.number().int().nonnegative(),
});
export type GroupCall = z.infer<typeof groupCallSchema>;

/** GET /conversations/:id/group-call */
export const activeGroupCallResponseSchema = z.object({ call: groupCallSchema.nullable() });
export type ActiveGroupCallResponse = z.infer<typeof activeGroupCallResponseSchema>;

/** POST /conversations/:id/group-call (start or join): where to connect, and a short-lived token
 *  for this one room. */
export const groupCallJoinSchema = z.object({
  call: groupCallSchema,
  url: z.string().min(1),
  token: z.string().min(1),
});
export type GroupCallJoin = z.infer<typeof groupCallJoinSchema>;

export const groupCallUpdatedSchema = z.object({
  conversationId: z.uuid(),
  call: groupCallSchema.nullable(),
});
export type GroupCallUpdated = z.infer<typeof groupCallUpdatedSchema>;

/** "Group call · 12:34" / "Group call · 45 s" for the end-of-call system message. */
export function groupCallDurationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** "3 people in the call" / "1 person in the call" / "Starting…" (nobody connected yet). */
export function groupCallParticipantsText(count: number): string {
  if (count <= 0) return 'Starting…';
  return `${count} ${count === 1 ? 'person' : 'people'} in the call`;
}
