import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenGuard, type AuthenticatedRequest } from './access-token.guard.js';
import type { TokenStateService } from './token-state.service.js';

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
  const tokenState = { isTokenValid: vi.fn(async () => true) };
  const guard = new AccessTokenGuard(jwt, tokenState as unknown as TokenStateService);

  it('rejects a missing Authorization header', async () => {
    await expect(guard.canActivate(contextWithAuthHeader())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a header that is not a Bearer token', async () => {
    await expect(guard.canActivate(contextWithAuthHeader('Basic abc123'))).rejects.toThrow(
      /Missing access token/,
    );
  });

  it('rejects garbage that is not a JWT at all', async () => {
    await expect(guard.canActivate(contextWithAuthHeader('Bearer not-a-jwt'))).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('accepts a validly signed, unexpired token and attaches the user id', async () => {
    const token = jwt.sign({ sub: 'user-1' });
    const ctx = contextWithAuthHeader(`Bearer ${token}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    expect(req.user.sub).toBe('user-1');
  });

  it('rejects a token that has expired', async () => {
    const expired = new JwtService({ secret: SECRET, signOptions: { expiresIn: '-10s' } });
    const token = expired.sign({ sub: 'user-1' });
    await expect(guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('rejects a token signed with a different secret', async () => {
    const otherSecretJwt = new JwtService({ secret: 'b'.repeat(32) });
    const token = otherSecretJwt.sign({ sub: 'user-1' });
    await expect(guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('rejects an unsigned token that declares alg: none', async () => {
    // Hand-built rather than signed: a real attack shape where the client controls the header
    // and claims no signature is needed. jsonwebtoken only accepts "none" when the verifier
    // explicitly opts into it via `algorithms: ['none']`, which this guard never does.
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const token = `${header}.${payload}.`;
    await expect(guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('CHAT-037: rejects a validly signed token whose user is deleted or changed password since', async () => {
    tokenState.isTokenValid.mockResolvedValueOnce(false);
    const token = jwt.sign({ sub: 'user-1' });
    await expect(guard.canActivate(contextWithAuthHeader(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
