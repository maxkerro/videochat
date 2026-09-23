import { vi, type Mock } from 'vitest';

vi.mock('../db/users.js', () => ({
  createUser: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  isUsernameTaken: vi.fn(),
  markEmailVerified: vi.fn(),
  recordFailedLogin: vi.fn(),
  resetFailedLogins: vi.fn(),
  setPasswordHash: vi.fn(),
}));
vi.mock('../db/refresh-tokens.js', () => ({
  createRefreshToken: vi.fn(),
  findRefreshTokenByHash: vi.fn(),
  revokeAllForUser: vi.fn(),
  revokeFamily: vi.fn(),
  revokeRefreshToken: vi.fn(),
}));
vi.mock('../db/auth-tokens.js', () => ({
  consumeAuthToken: vi.fn(),
  createAuthToken: vi.fn(),
  findValidAuthToken: vi.fn(),
}));
vi.mock('./password.js', () => ({
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(),
}));

import * as authTokensDb from '../db/auth-tokens.js';
import * as refreshTokensDb from '../db/refresh-tokens.js';
import * as usersDb from '../db/users.js';
import { hashPassword, verifyPassword } from './password.js';
import { AuthService } from './auth.service.js';
import type { Env } from '../config/env.js';
import type { User } from '../db/schema.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'a@test.dev',
    username: 'alice',
    displayName: 'Alice',
    avatarKey: null,
    passwordHash: 'hashed:pw',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const env: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  LOG_LEVEL: 'warn',
  CORS_ORIGINS: [],
  DATABASE_URL: 'postgres://x',
  DATABASE_POOL_MAX: 1,
  REDIS_URL: 'redis://x',
  OTEL_SERVICE_NAME: 'x',
  APP_VERSION: 'dev',
  JWT_SECRET: 'x'.repeat(32),
  JWT_ACCESS_TTL_MIN: 15,
  JWT_REFRESH_TTL_DAYS: 30,
  PUBLIC_WEB_URL: 'http://localhost:5173',
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'x',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'x',
  S3_SECRET_ACCESS_KEY: 'x',
  S3_FORCE_PATH_STYLE: true,
};

function makeService() {
  const jwt = { sign: vi.fn(() => 'signed.jwt.token') };
  const mail = { sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() };
  const s3 = { getAvatarUrl: vi.fn(async () => null) };
  // The service only ever passes `db` through to the mocked repository functions, never
  // touches it directly, so a placeholder is enough here.
  const service = new AuthService({} as never, env, jwt as never, mail as never, s3 as never);
  return { service, jwt, mail, s3 };
}

describe('AuthService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('signUp', () => {
    it('rejects a duplicate email', async () => {
      (usersDb.findUserByEmail as Mock).mockResolvedValue(makeUser());
      const { service } = makeService();
      await expect(
        service.signUp({
          email: 'a@test.dev',
          username: 'x',
          displayName: 'X',
          password: 'pw123456',
        }),
      ).rejects.toThrow(/already exists/);
    });

    it('rejects a duplicate username', async () => {
      (usersDb.findUserByEmail as Mock).mockResolvedValue(undefined);
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(true);
      const { service } = makeService();
      await expect(
        service.signUp({
          email: 'new@test.dev',
          username: 'alice',
          displayName: 'X',
          password: 'pw123456',
        }),
      ).rejects.toThrow(/already taken/);
    });

    it('creates the user, hashes the password, and sends a verification email', async () => {
      (usersDb.findUserByEmail as Mock).mockResolvedValue(undefined);
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(false);
      const created = makeUser({ id: 'new-id', emailVerifiedAt: null });
      (usersDb.createUser as Mock).mockResolvedValue(created);
      (authTokensDb.createAuthToken as Mock).mockResolvedValue({ id: 'tok-1' });
      const { service, mail } = makeService();

      await service.signUp({
        email: created.email,
        username: created.username,
        displayName: created.displayName,
        password: 'pw123456',
      });

      expect(hashPassword).toHaveBeenCalledWith('pw123456');
      expect(usersDb.createUser).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ passwordHash: 'hashed:pw123456' }),
      );
      expect(mail.sendVerificationEmail).toHaveBeenCalledWith(created.email, expect.any(String));
    });
  });

  describe('login', () => {
    it('rejects an unknown email with the same message as a wrong password', async () => {
      (usersDb.findUserByEmail as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.login({ email: 'nobody@test.dev', password: 'x' })).rejects.toThrow(
        'Invalid email or password',
      );
    });

    it('rejects while locked out, without checking the password', async () => {
      const user = makeUser({ lockedUntil: new Date(Date.now() + 60_000) });
      (usersDb.findUserByEmail as Mock).mockResolvedValue(user);
      const { service } = makeService();
      await expect(service.login({ email: user.email, password: 'pw' })).rejects.toThrow(
        /Too many failed attempts/,
      );
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('records a failed attempt and rejects on a wrong password', async () => {
      const user = makeUser();
      (usersDb.findUserByEmail as Mock).mockResolvedValue(user);
      (verifyPassword as Mock).mockResolvedValue(false);
      const { service } = makeService();
      await expect(service.login({ email: user.email, password: 'wrong' })).rejects.toThrow(
        'Invalid email or password',
      );
      expect(usersDb.recordFailedLogin).toHaveBeenCalledWith(expect.anything(), user.id);
    });

    it('rejects an unverified email even with the correct password', async () => {
      const user = makeUser({ emailVerifiedAt: null });
      (usersDb.findUserByEmail as Mock).mockResolvedValue(user);
      (verifyPassword as Mock).mockResolvedValue(true);
      const { service } = makeService();
      await expect(service.login({ email: user.email, password: 'pw' })).rejects.toThrow(
        /verify your email/,
      );
      // Attempts are still reset on a correct password, even though login is refused for
      // another reason -- an unverified account shouldn't also creep toward lockout.
      expect(usersDb.resetFailedLogins).toHaveBeenCalledWith(expect.anything(), user.id);
    });

    it('resets attempts and issues a session on success', async () => {
      const user = makeUser();
      (usersDb.findUserByEmail as Mock).mockResolvedValue(user);
      (verifyPassword as Mock).mockResolvedValue(true);
      (usersDb.findUserById as Mock).mockResolvedValue(user);
      (refreshTokensDb.createRefreshToken as Mock).mockResolvedValue({ id: 'rt-1' });
      const { service, jwt } = makeService();

      const { session, refreshToken } = await service.login({ email: user.email, password: 'pw' });

      expect(usersDb.resetFailedLogins).toHaveBeenCalledWith(expect.anything(), user.id);
      expect(jwt.sign).toHaveBeenCalledWith({ sub: user.id });
      expect(session.user.id).toBe(user.id);
      expect(typeof refreshToken).toBe('string');
    });
  });

  describe('refresh', () => {
    it('rejects a missing token', async () => {
      const { service } = makeService();
      await expect(service.refresh(undefined)).rejects.toThrow('Missing refresh token');
    });

    it('rejects an unknown token', async () => {
      (refreshTokensDb.findRefreshTokenByHash as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.refresh('nope')).rejects.toThrow('Invalid session');
    });

    it('revokes the whole family and rejects on reuse of an already-revoked token', async () => {
      (refreshTokensDb.findRefreshTokenByHash as Mock).mockResolvedValue({
        id: 'rt-1',
        familyId: 'fam-1',
        userId: 'user-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const { service } = makeService();
      await expect(service.refresh('stolen')).rejects.toThrow(/revoked/);
      expect(refreshTokensDb.revokeFamily).toHaveBeenCalledWith(expect.anything(), 'fam-1');
    });

    it('rejects an expired token without needing to revoke anything', async () => {
      (refreshTokensDb.findRefreshTokenByHash as Mock).mockResolvedValue({
        id: 'rt-1',
        familyId: 'fam-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      const { service } = makeService();
      await expect(service.refresh('expired')).rejects.toThrow(/expired/);
      expect(refreshTokensDb.revokeFamily).not.toHaveBeenCalled();
    });

    it('rotates: revokes the old token and issues a new one in the same family', async () => {
      const user = makeUser();
      (refreshTokensDb.findRefreshTokenByHash as Mock).mockResolvedValue({
        id: 'rt-1',
        familyId: 'fam-1',
        userId: user.id,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      (usersDb.findUserById as Mock).mockResolvedValue(user);
      (refreshTokensDb.createRefreshToken as Mock).mockResolvedValue({ id: 'rt-2' });
      const { service } = makeService();

      const { session } = await service.refresh('valid');

      expect(refreshTokensDb.revokeRefreshToken).toHaveBeenCalledWith(expect.anything(), 'rt-1');
      expect(refreshTokensDb.createRefreshToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ familyId: 'fam-1', userId: user.id }),
      );
      expect(session.user.id).toBe(user.id);
    });
  });

  describe('logout', () => {
    it('does nothing when there is no token', async () => {
      const { service } = makeService();
      await service.logout(undefined);
      expect(refreshTokensDb.findRefreshTokenByHash).not.toHaveBeenCalled();
    });

    it('revokes the family for a known token', async () => {
      (refreshTokensDb.findRefreshTokenByHash as Mock).mockResolvedValue({
        id: 'rt-1',
        familyId: 'fam-9',
      });
      const { service } = makeService();
      await service.logout('a-token');
      expect(refreshTokensDb.revokeFamily).toHaveBeenCalledWith(expect.anything(), 'fam-9');
    });
  });

  describe('password reset', () => {
    it('silently no-ops requesting a reset for an unknown email', async () => {
      (usersDb.findUserByEmail as Mock).mockResolvedValue(undefined);
      const { service, mail } = makeService();
      await service.requestPasswordReset('nobody@test.dev');
      expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('sends a reset email for a known address', async () => {
      const user = makeUser();
      (usersDb.findUserByEmail as Mock).mockResolvedValue(user);
      (authTokensDb.createAuthToken as Mock).mockResolvedValue({ id: 'tok' });
      const { service, mail } = makeService();
      await service.requestPasswordReset(user.email);
      expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(user.email, expect.any(String));
    });

    it('rejects an invalid or expired reset token', async () => {
      (authTokensDb.findValidAuthToken as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.resetPassword({ token: 'bad', password: 'newpass123' })).rejects.toThrow(
        /invalid or has expired/,
      );
    });

    it('sets the new password and revokes every existing session', async () => {
      (authTokensDb.findValidAuthToken as Mock).mockResolvedValue({
        id: 'tok-1',
        userId: 'user-1',
      });
      const { service } = makeService();
      await service.resetPassword({ token: 'good', password: 'newpass123' });
      expect(authTokensDb.consumeAuthToken).toHaveBeenCalledWith(expect.anything(), 'tok-1');
      expect(usersDb.setPasswordHash).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'hashed:newpass123',
      );
      expect(refreshTokensDb.revokeAllForUser).toHaveBeenCalledWith(expect.anything(), 'user-1');
    });
  });

  describe('verifyEmail', () => {
    it('rejects an invalid or expired token', async () => {
      (authTokensDb.findValidAuthToken as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.verifyEmail('bad')).rejects.toThrow(/invalid or has expired/);
    });

    it('marks the email verified and consumes the token', async () => {
      (authTokensDb.findValidAuthToken as Mock).mockResolvedValue({
        id: 'tok-1',
        userId: 'user-1',
      });
      const { service } = makeService();
      await service.verifyEmail('good');
      expect(authTokensDb.consumeAuthToken).toHaveBeenCalledWith(expect.anything(), 'tok-1');
      expect(usersDb.markEmailVerified).toHaveBeenCalledWith(expect.anything(), 'user-1');
    });
  });
});
