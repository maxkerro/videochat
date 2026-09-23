import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  type CanActivate,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AccessTokenPayload {
  sub: string;
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
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthorizedException('Missing access token');

    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token);
      (req as AuthenticatedRequest).user = { sub: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

/** The authenticated user's id, from the verified access token. */
export const CurrentUserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return req.user.sub;
});
