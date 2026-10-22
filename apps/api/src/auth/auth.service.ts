import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  type OnModuleInit,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  LIMITS,
  isEmailIdentifier,
  type AuthSession,
  type LoginLinkVerifyInput,
  type ChangePasswordInput,
  type LoginInput,
  type ResetPasswordInput,
  type SignUpInput,
} from '@videochat/shared';
import { randomInt, randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { User } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { DB, ENV, REDIS } from '../infra/tokens.js';
import { Redis } from 'ioredis';
import { publishSessionEnded } from '../realtime/realtime.service.js';
import { TokenStateService } from './token-state.service.js';
import {
  consumeAllAuthTokens,
  consumeAuthToken,
  countRecentAuthTokens,
  createAuthToken,
  voidLoginCodes,
} from '../db/auth-tokens.js';
import { isUniqueViolation } from '../db/pg-errors.js';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeAllForUser,
  revokeAllForUserExcept,
  revokeFamily,
  revokeRefreshToken,
} from '../db/refresh-tokens.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  isUsernameTaken,
  markEmailVerified,
  recordFailedLogin,
  recordLoginCodeFailure,
  resetFailedLogins,
  resetLoginCodeFailures,
  setPasswordHash,
} from '../db/users.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword, warmDummyHash } from './password.js';
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

/** CHAT-080: one message for an unknown email, an unknown username and a wrong password. */
export const INVALID_LOGIN_MESSAGE = 'Incorrect email/username or password';

@Injectable()
export class AuthService implements OnModuleInit {
  /** CHAT-081: delay, throttle and sign-in-link events, per account, to spot abuse. */
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly s3: S3Service,
    private readonly tokenState: TokenStateService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): Promise<void> {
    return warmDummyHash();
  }

  async signUp(input: SignUpInput): Promise<void> {
    if (await findUserByEmail(this.db, input.email)) {
      throw new ConflictException('An account with that email already exists');
    }
    if (await isUsernameTaken(this.db, input.username)) {
      throw new ConflictException('That username is already taken');
    }

    const passwordHash = await hashPassword(input.password);
    let user;
    try {
      user = await createUser(this.db, {
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
      });
    } catch (err) {
      // The checks above are a courtesy, not a guarantee: two concurrent signups with the same
      // email or username can both pass them and race to the insert. The unique index is the
      // real source of truth, so a violation here is still a 409, not a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException('An account with that email or username already exists');
      }
      throw err;
    }

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
    const row = await consumeAuthToken(this.db, hashToken(token), 'email_verify');
    if (!row) throw new BadRequestException('This verification link is invalid or has expired');
    await markEmailVerified(this.db, row.userId);
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    // CHAT-080: email or username. Everything after the lookup -- lockout (per account, so
    // switching between the two doesn't reset it), password check, verification -- is the same.
    // Lowercased here, and both lookups also compare lower() on both sides (matching the
    // lower(email)/lower(username) unique indexes), so case never matters on either path. The
    // login throttler (LoginThrottlerGuard) keys on client IP only, never the body, so the field
    // rename doesn't affect it.
    const identifier = input.identifier.trim().toLowerCase();
    const user = isEmailIdentifier(identifier)
      ? await findUserByEmail(this.db, identifier)
      : await findUserByUsername(this.db, identifier);
    // Same generic error whether the account doesn't exist or the password is wrong: don't let a
    // login attempt reveal which emails or usernames have an account.
    const invalid = () => new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    if (!user || !user.passwordHash) {
      await verifyAgainstDummyHash(input.password); // keep timing in line with a wrong password
      throw invalid();
    }

    // CHAT-081: anyone who has seen a username can fail on purpose, so failures only cost a short,
    // growing delay (at most LIMITS.loginDelayMaxSeconds), and the owner can always sign in with
    // an emailed link or code instead (requestLoginLink), which this delay doesn't apply to.
    this.refuseWhileDelayed(user);

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      await this.recordFailure(user.id);
      throw invalid();
    }
    await resetFailedLogins(this.db, user.id);

    if (!user.emailVerifiedAt) {
      // CHAT-077: a code, so clients can tell this 403 from a lockout or a suspension.
      throw new ForbiddenException({
        message: 'Please verify your email before logging in',
        code: 'email_unverified',
      });
    }

    return this.issueSession(user.id);
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedSession> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const tokenHash = hashToken(refreshToken);
    const row = await findRefreshTokenByHash(this.db, tokenHash);
    if (!row) throw new UnauthorizedException('Invalid session');
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired; please log in again');
    }

    // The revoke IS the gate: it only succeeds for whichever request gets there first, so two
    // concurrent refreshes with the same token (two tabs, a retried request) can't both pass a
    // separate "is it revoked" check and both mint a live child -- that race is what let a
    // replayed stolen token go undetected, and forked the token family, before this fix. A short
    // grace window that tolerated re-presenting a just-rotated token was considered (to spare
    // multi-tab users an occasional full logout), but there's no way to tell that case apart
    // from an attacker replaying a token within a few seconds of its legitimate rotation --
    // exactly the reuse this endpoint exists to catch -- so any presentation of an already-dead
    // token still ends the whole session.
    const rotated = await revokeRefreshToken(this.db, row.id);
    if (!rotated) {
      await revokeFamily(this.db, row.familyId);
      throw new UnauthorizedException('Session revoked; please log in again');
    }
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
    const row = await consumeAuthToken(this.db, hashToken(input.token), 'password_reset');
    if (!row) throw new BadRequestException('This reset link is invalid or has expired');
    const passwordHash = await hashPassword(input.password);
    await setPasswordHash(this.db, row.userId, passwordHash, { passwordChanged: true });
    this.tokenState.invalidate(row.userId);
    // Force every existing session to re-authenticate: a password reset usually means the old
    // password (and anything signed in with it) shouldn't be trusted anymore -- including access
    // tokens and open connections, not just refresh tokens.
    await revokeAllForUser(this.db, row.userId);
    await publishSessionEnded(this.redis, row.userId, 'password-changed').catch(() => undefined);
  }

  /**
   * CHAT-037: change password while signed in. The current password proves it's really you (an
   * unlocked laptop isn't enough); every *other* session ends, this one carries on.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentRefreshToken: string | undefined,
  ): Promise<void> {
    if (!(await this.checkPasswordWithLockout(userId, input.currentPassword))) {
      throw new BadRequestException('Your current password is incorrect');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const current = currentRefreshToken
      ? await findRefreshTokenByHash(this.db, hashToken(currentRefreshToken))
      : undefined;
    // Both or neither: a new password with the old sessions still alive (or the reverse) is
    // never left behind by a failure in between.
    await this.db.transaction(async (tx) => {
      await setPasswordHash(tx, userId, passwordHash, { passwordChanged: true });
      await revokeAllForUserExcept(
        tx,
        userId,
        current && current.userId === userId ? current.familyId : null,
      );
    });
    // Other devices' access tokens stop working at once (they predate passwordChangedAt).
    this.tokenState.invalidate(userId);
    // Other devices' live connections end too; this tab reconnects with a fresh token.
    await publishSessionEnded(this.redis, userId, 'password-changed').catch(() => undefined);
  }

  /** CHAT-037: re-checks the password before an account is deleted. */
  verifyPasswordFor(userId: string, password: string): Promise<boolean> {
    return this.checkPasswordWithLockout(userId, password);
  }

  /**
   * A signed-in password re-check (change password, delete account) counts toward the same
   * CHAT-010 lockout as logging in: otherwise a stolen access token would allow guessing the
   * password at the throttle's rate, unbounded across IPs.
   */
  private async checkPasswordWithLockout(userId: string, password: string): Promise<boolean> {
    const user = await findUserById(this.db, userId);
    if (!user?.passwordHash) return false;
    this.refuseWhileDelayed(user);
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.recordFailure(user.id);
      return false;
    }
    if (user.failedLoginAttempts > 0) await resetFailedLogins(this.db, user.id);
    return true;
  }

  /**
   * CHAT-081: "email me a sign-in link". The email has a one-time link (web) and a 6-digit code
   * (phones), both valid for LIMITS.loginLinkTtlMinutes, and it works while password sign-in is
   * delayed -- so someone failing on purpose can never keep the owner out. Answered the same way
   * whether or not the account exists; at most LIMITS.loginLinksPerWindow emails per window.
   */
  async requestLoginLink(identifier: string): Promise<void> {
    const id = identifier.trim().toLowerCase();
    const user = isEmailIdentifier(id)
      ? await findUserByEmail(this.db, id)
      : await findUserByUsername(this.db, id);
    if (!user || user.deletedAt) return;
    const ttlMs = LIMITS.loginLinkTtlMinutes * 60_000;
    const recent = await countRecentAuthTokens(
      this.db,
      user.id,
      'login_link',
      new Date(Date.now() - ttlMs),
    );
    if (recent >= LIMITS.loginLinksPerWindow) {
      this.logger.warn({ event: 'login.link_limited', userId: user.id });
      return;
    }
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    await createAuthToken(this.db, {
      userId: user.id,
      purpose: 'login_link',
      tokenHash: hashToken(token),
      expiresAt,
    });
    let code = '';
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        await createAuthToken(this.db, {
          userId: user.id,
          purpose: 'login_code',
          tokenHash: hashToken(loginCodeKey(user.id, candidate)),
          expiresAt,
        });
        code = candidate;
      } catch (err) {
        // The same 6 digits are already out for this account (rare): pick others.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    // A fresh email gets a fresh set of tries at its code.
    await resetLoginCodeFailures(this.db, user.id);
    await this.mail.sendLoginLinkEmail(user.email, token, code);
    this.logger.warn({ event: 'login.link_sent', userId: user.id });
  }

  /** CHAT-081: signs in with the emailed link's token or code (one use; the email's other half
   *  stops working too). Proves the email address, so it also verifies it. */
  async verifyLoginLink(input: LoginLinkVerifyInput): Promise<IssuedSession> {
    let userId: string;
    if ('token' in input) {
      const row = await consumeAuthToken(this.db, hashToken(input.token), 'login_link');
      if (!row) throw new BadRequestException('This sign-in link is invalid or has expired');
      userId = row.userId;
    } else {
      const invalid = () => new BadRequestException('That code is wrong or has expired');
      const id = input.identifier.trim().toLowerCase();
      const user = isEmailIdentifier(id)
        ? await findUserByEmail(this.db, id)
        : await findUserByUsername(this.db, id);
      if (!user || user.deletedAt) throw invalid();
      if (user.loginCodeFailures >= LIMITS.loginCodeMaxFailures) throw invalid();
      const row = await consumeAuthToken(
        this.db,
        hashToken(loginCodeKey(user.id, input.code)),
        'login_code',
      );
      if (!row) {
        const failures = await recordLoginCodeFailure(this.db, user.id);
        if (failures >= LIMITS.loginCodeMaxFailures) {
          // Too many wrong codes: void the codes. The link in the email still works, so someone
          // guessing can't lock the owner out this way either.
          await voidLoginCodes(this.db, user.id);
          this.logger.warn({ event: 'login.codes_voided', userId: user.id });
        }
        throw invalid();
      }
      userId = user.id;
    }
    await consumeAllAuthTokens(this.db, userId, 'login_link');
    await consumeAllAuthTokens(this.db, userId, 'login_code');
    await markEmailVerified(this.db, userId);
    await resetFailedLogins(this.db, userId);
    this.logger.warn({ event: 'login.link_used', userId });
    return this.issueSession(userId);
  }

  /** CHAT-081: refuses while the account's delay runs, saying how long and what else works. */
  private refuseWhileDelayed(user: Pick<User, 'id' | 'lockedUntil'>): void {
    const waitMs = user.lockedUntil ? user.lockedUntil.getTime() - Date.now() : 0;
    if (waitMs <= 0) return;
    const seconds = Math.ceil(waitMs / 1000);
    this.logger.warn({ event: 'login.throttled', userId: user.id, retryAfterSec: seconds });
    throw new ForbiddenException({
      message: `Too many failed attempts. Try again in ${formatWait(seconds)}, or sign in with an emailed code.`,
      code: 'login_throttled',
      retryAfterSec: seconds,
    });
  }

  private async recordFailure(userId: string): Promise<void> {
    const row = await recordFailedLogin(this.db, userId);
    if (row.failedLoginAttempts >= LIMITS.loginAttemptsBeforeLockout) {
      this.logger.warn({
        event: 'login.delayed',
        userId,
        failures: row.failedLoginAttempts,
        until: row.lockedUntil?.toISOString(),
      });
    }
  }

  private async issueSession(
    userId: string,
    familyId: string = randomUUID(),
  ): Promise<IssuedSession> {
    const user = await findUserById(this.db, userId);
    if (!user) throw new UnauthorizedException('Invalid session');
    // CHAT-077: a suspended or banned account gets no new session (sign-in or refresh).
    const restricted = restrictionMessage(user);
    if (restricted) throw new ForbiddenException(restricted);

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

/** CHAT-077: why this account can't sign in right now, or null. */
export function restrictionMessage(
  user: Pick<User, 'bannedAt' | 'suspendedUntil'>,
  now = Date.now(),
): string | null {
  if (user.bannedAt) return 'This account has been banned.';
  if (user.suspendedUntil && user.suspendedUntil.getTime() > now) {
    return `This account is suspended until ${user.suspendedUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
  }
  return null;
}

/** CHAT-081: what an emailed code is stored as (hashed, and tied to the account, so the same six
 *  digits sent to two people are two different rows). */
function loginCodeKey(userId: string, code: string): string {
  return `login-code:${userId}:${code}`;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}
