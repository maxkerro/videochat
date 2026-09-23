import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import type { Database } from './client.js';
import { appendMessage, directKeyFor } from './messages.js';
import { conversations, memberships, users } from './schema.js';

export const DEMO_PASSWORD = 'password123';

const DEMO_USERS = [
  { username: 'anna', displayName: 'Anna Schmidt', email: 'anna@example.com' },
  { username: 'ben', displayName: 'Ben Okafor', email: 'ben@example.com' },
  { username: 'clara', displayName: 'Clara Novak', email: 'clara@example.com' },
] as const;

export interface SeedResult {
  created: boolean;
  userIds: Record<(typeof DEMO_USERS)[number]['username'], string>;
  directConversationId?: string;
  groupConversationId?: string;
}

/**
 * Creates demo users, a direct chat (Anna ↔ Ben) and a group chat with all three.
 * Safe to run repeatedly: if the demo users exist it does nothing.
 */
export async function seedDemoData(db: Database): Promise<SeedResult> {
  const existing = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(sql`lower(${users.username}) in ('anna', 'ben', 'clara')`);
  if (existing.length === DEMO_USERS.length) {
    return {
      created: false,
      userIds: Object.fromEntries(existing.map((u) => [u.username, u.id])) as SeedResult['userIds'],
    };
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const inserted = await db
    .insert(users)
    .values(DEMO_USERS.map((u) => ({ ...u, passwordHash, emailVerifiedAt: new Date() })))
    .onConflictDoNothing()
    .returning({ id: users.id, username: users.username });
  const ids = Object.fromEntries(inserted.map((u) => [u.username, u.id])) as SeedResult['userIds'];
  const { anna, ben, clara } = ids;

  const [dm] = await db
    .insert(conversations)
    .values({ type: 'direct', createdBy: anna, directKey: directKeyFor(anna, ben) })
    .returning({ id: conversations.id });
  await db.insert(memberships).values([
    { conversationId: dm!.id, userId: anna, role: 'member' },
    { conversationId: dm!.id, userId: ben, role: 'member' },
  ]);

  const [group] = await db
    .insert(conversations)
    .values({ type: 'group', title: 'Project Relay', createdBy: anna })
    .returning({ id: conversations.id });
  await db.insert(memberships).values([
    { conversationId: group!.id, userId: anna, role: 'admin' },
    { conversationId: group!.id, userId: ben, role: 'member' },
    { conversationId: group!.id, userId: clara, role: 'member' },
  ]);

  const script: Array<[string, string | null, string, 'text' | 'system']> = [
    [dm!.id, anna, 'Hi Ben! Did you see the new backlog?', 'text'],
    [dm!.id, ben, 'Yes, M0 looks good. Starting on the schema today.', 'text'],
    [dm!.id, anna, 'Great, ping me when the migrations are in.', 'text'],
    [group!.id, null, 'Anna created the group “Project Relay”', 'system'],
    [group!.id, null, 'Anna added Ben and Clara', 'system'],
    [group!.id, anna, 'Welcome, both! This is where we coordinate the M1 release.', 'text'],
    [group!.id, clara, 'Hi everyone 👋', 'text'],
    [group!.id, ben, 'Staging should be up by Friday.', 'text'],
  ];
  for (const [conversationId, senderId, body, type] of script) {
    await appendMessage(db, { conversationId, senderId, body, type });
  }

  return {
    created: true,
    userIds: ids,
    directConversationId: dm!.id,
    groupConversationId: group!.id,
  };
}
