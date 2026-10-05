import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  type CanActivate,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { TokenStateService } from './token-state.service.js';

export interface AccessTokenPayload {
  sub: string;
  /** Issued-at (seconds), set by the JWT library. */
  iat?: number;
}

/** Attached to `req.user` by AccessTokenGuard once the token is verified. */
export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

/**
 * Requires a valid `Authorization: Bearer <access token>` header. Rejects with 401 for a
 * missing, malformed or expired/invalid-signature token -- never a 500, since an untrusted
 * client controls this header entirely.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly tokenState: TokenStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthorizedException('Missing access token');

    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    // CHAT-037 review: a deleted account's tokens, and tokens from before a password change, are
    // refused even though their signature is still fine. (The client refreshes on a 401, which
    // gets the current session a fresh token; other sessions' refresh tokens are revoked.)
    if (!(await this.tokenState.isTokenValid(payload.sub, payload.iat))) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    (req as AuthenticatedRequest).user = { sub: payload.sub };
    return true;
  }
}

/** The authenticated user's id, from the verified access token. */
export const CurrentUserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return req.user.sub;
});
