import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/access-token.guard.js';
import type { Database } from '../db/client.js';
import { isModerator } from '../db/moderation.js';
import { DB } from '../infra/tokens.js';

/**
 * CHAT-077: moderators only. Runs after `AccessTokenGuard`, and reads the flag from the database
 * on every request, so taking someone off the moderator team takes effect at once.
 */
@Injectable()
export class ModeratorGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user || !(await isModerator(this.db, req.user.sub))) {
      throw new ForbiddenException('Moderators only');
    }
    return true;
  }
}
