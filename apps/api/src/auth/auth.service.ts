import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthSession, LoginInput, ResetPasswordInput, SignUpInput } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { DB, ENV } from '../infra/tokens.js';
import { consumeAuthToken, createAuthToken, findValidAuthToken } from '../db/auth-tokens.js';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeAllForUser,
  revokeFamily,
  revokeRefreshToken,
} from '../db/refresh-tokens.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  isUsernameTaken,
  markEmailVerified,
  recordFailedLogin,
  resetFailedLogins,
  setPasswordHash,
} from '../db/users.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateOpaqueToken, hashToken } from './tokens.js';
import { MailService } from '../mail/mail.service.js';
import { S3Service } from '../storage/s3.service.js';
import { toMe } from '../users/user-mapper.js';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly s3: S3Service,
  ) {}

  async signUp(input: SignUpInput): Promise<void> {
    if (await findUserByEmail(this.db, input.email)) {
      throw new ConflictException('An account with that email already exists');
    }
    if (await isUsernameTaken(this.db, input.username)) {
      throw new ConflictException('That username is already taken');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await createUser(this.db, {
      email: input.email,
      username: input.username,
      displayName: input.displayName,
      passwordHash,
    });

    await this.issueAndSendVerification(user.id, user.email);
  }

  async resendVerification(email: string): Promise<void> {
    const user = await findUserByEmail(this.db, email);
    // Silent no-op for an unknown or already-verified email: never confirm which emails exist.
    if (!user || user.emailVerifiedAt) return;
    await this.issueAndSendVerification(user.id, user.email);
  }

  private async issueAndSendVerification(userId: string, email: string): Promise<void> {
    const token = generateOpaqueToken();
    await createAuthToken(this.db, {
      userId,
      purpose: 'email_verify',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });
    await this.mail.sendVerificationEmail(email, token);
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await findValidAuthToken(this.db, hashToken(token), 'email_verify');
    if (!row) throw new BadRequestException('This verification link is invalid or has expired');
    await consumeAuthToken(this.db, row.id);
    await markEmailVerified(this.db, row.userId);
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const user = await findUserByEmail(this.db, input.email);
    // Same generic error whether the email doesn't exist or the password is wrong: don't let a
    // login attempt reveal which emails have an account.
    const invalid = () => new UnauthorizedException('Invalid email or password');
    if (!user || !user.passwordHash) throw invalid();

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('Too many failed attempts. Try again in a few minutes.');
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      await recordFailedLogin(this.db, user.id);
      throw invalid();
    }
    await resetFailedLogins(this.db, user.id);

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Please verify your email before logging in');
    }

    return this.issueSession(user.id);
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedSession> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const tokenHash = hashToken(refreshToken);
    const row = await findRefreshTokenByHash(this.db, tokenHash);
    if (!row) throw new UnauthorizedException('Invalid session');

    if (row.revokedAt) {
      // Someone presented a token that was already rotated away or explicitly logged out --
      // either a replay of a stolen token, or a client bug. Either way, end the whole session.
      await revokeFamily(this.db, row.familyId);
      throw new UnauthorizedException('Session revoked; please log in again');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired; please log in again');
    }

    await revokeRefreshToken(this.db, row.id);
    return this.issueSession(row.userId, row.familyId);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const row = await findRefreshTokenByHash(this.db, hashToken(refreshToken));
    if (row) await revokeFamily(this.db, row.familyId);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await findUserByEmail(this.db, email);
    if (!user) return; // Silent: don't reveal whether the email has an account.
    const token = generateOpaqueToken();
    await createAuthToken(this.db, {
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    await this.mail.sendPasswordResetEmail(user.email, token);
  }

  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const row = await findValidAuthToken(this.db, hashToken(input.token), 'password_reset');
    if (!row) throw new BadRequestException('This reset link is invalid or has expired');
    await consumeAuthToken(this.db, row.id);
    const passwordHash = await hashPassword(input.password);
    await setPasswordHash(this.db, row.userId, passwordHash);
    // Force every existing session to re-authenticate: a password reset usually means the old
    // password (and anything signed in with it) shouldn't be trusted anymore.
    await revokeAllForUser(this.db, row.userId);
  }

  private async issueSession(
    userId: string,
    familyId: string = randomUUID(),
  ): Promise<IssuedSession> {
    const user = await findUserById(this.db, userId);
    if (!user) throw new UnauthorizedException('Invalid session');

    const refreshToken = generateOpaqueToken();
    await createRefreshToken(this.db, {
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    const accessToken = this.jwt.sign({ sub: userId });
    const accessTokenExpiresAt = new Date(
      Date.now() + this.env.JWT_ACCESS_TTL_MIN * 60 * 1000,
    ).toISOString();
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);

    return {
      session: { accessToken, accessTokenExpiresAt, user: toMe(user, avatarUrl) },
      refreshToken,
    };
  }
}
