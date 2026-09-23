import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenGuard, type AuthenticatedRequest } from './access-token.guard.js';

const SECRET = 'a'.repeat(32);

function contextWithAuthHeader(authorization?: string): ExecutionContext {
  const req: Partial<AuthenticatedRequest> = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** Base64url-encodes a plain JS object, matching JWT segment encoding. */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('AccessTokenGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  const guard = new AccessTokenGuard(jwt);

  it('rejects a missing Authorization header', () => {
    expect(() => guard.canActivate(contextWithAuthHeader())).toThrow(UnauthorizedException);
  });

  it('rejects a header that is not a Bearer token', () => {
    expect(() => guard.canActivate(contextWithAuthHeader('Basic abc123'))).toThrow(
      /Missing access token/,
    );
  });

  it('rejects garbage that is not a JWT at all', () => {
    expect(() => guard.canActivate(contextWithAuthHeader('Bearer not-a-jwt'))).toThrow(
      /Invalid or expired/,
    );
  });

  it('accepts a validly signed, unexpired token and attaches the user id', () => {
    const token = jwt.sign({ sub: 'user-1' });
    const ctx = contextWithAuthHeader(`Bearer ${token}`);
    expect(guard.canActivate(ctx)).toBe(true);
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    expect(req.user.sub).toBe('user-1');
  });

  it('rejects a token that has expired', () => {
    const expired = new JwtService({ secret: SECRET, signOptions: { expiresIn: '-10s' } });
    const token = expired.sign({ sub: 'user-1' });
    expect(() => guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).toThrow(
      /Invalid or expired/,
    );
  });

  it('rejects a token signed with a different secret', () => {
    const otherSecretJwt = new JwtService({ secret: 'b'.repeat(32) });
    const token = otherSecretJwt.sign({ sub: 'user-1' });
    expect(() => guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).toThrow(
      /Invalid or expired/,
    );
  });

  it('rejects an unsigned token that declares alg: none', () => {
    // Hand-built rather than signed: a real attack shape where the client controls the header
    // and claims no signature is needed. jsonwebtoken only accepts "none" when the verifier
    // explicitly opts into it via `algorithms: ['none']`, which this guard never does.
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const token = `${header}.${payload}.`;
    expect(() => guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).toThrow(
      /Invalid or expired/,
    );
  });
});
