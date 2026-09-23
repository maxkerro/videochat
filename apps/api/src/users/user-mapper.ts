import type { Me, PublicUser } from '@videochat/shared';
import type { User } from '../db/schema.js';

export function toPublicUser(user: User, avatarUrl: string | null): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl,
  };
}

export function toMe(user: User, avatarUrl: string | null): Me {
  return {
    ...toPublicUser(user, avatarUrl),
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}
