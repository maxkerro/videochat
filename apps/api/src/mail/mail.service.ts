import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';

/**
 * Thin wrapper over nodemailer. Points at Mailpit locally (see docker-compose.yml) and at any
 * real SMTP server in production via SMTP_URL. Failures are logged, never thrown: a broken mail
 * server should degrade the product (a user doesn't get their email) rather than 500 the request
 * that triggered it (e.g. sign-up should still succeed even if the verification email fails to send).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = nodemailer.createTransport(env.SMTP_URL);
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to, subject, html });
    } catch (err) {
      this.logger.error(`Failed to send "${subject}" to ${to}: ${(err as Error).message}`);
    }
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = `${this.env.PUBLIC_WEB_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Verify your email',
      `<p>Welcome to Videochat! Confirm your email address to finish setting up your account.</p>
       <p><a href="${link}">Verify email</a></p>
       <p>This link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>`,
    );
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const link = `${this.env.PUBLIC_WEB_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Reset your password',
      `<p>We received a request to reset your Videochat password.</p>
       <p><a href="${link}">Reset password</a></p>
       <p>This link expires in 30 minutes and works once. If you didn't request this, you can ignore this email.</p>`,
    );
  }

  /** CHAT-077: tells someone a moderator acted on their account. Deliberately generic: no
   *  moderator names or internal notes. */
  async sendModerationNotice(
    to: string,
    notice: { kind: 'warn' } | { kind: 'suspend'; until: Date } | { kind: 'ban' },
  ): Promise<void> {
    const body =
      notice.kind === 'warn'
        ? '<p>A message or behaviour of yours on Videochat was reported and reviewed by our moderators. Please keep to the community rules: repeated reports can lead to a suspension.</p>'
        : notice.kind === 'suspend'
          ? `<p>After reviewing reports, our moderators suspended your Videochat account until ${notice.until.toISOString().slice(0, 16).replace('T', ' ')} UTC. You were signed out and can sign in again after that.</p>`
          : '<p>After reviewing reports, our moderators banned your Videochat account. You were signed out and can no longer sign in.</p>';
    const subject =
      notice.kind === 'warn'
        ? 'A warning about your Videochat account'
        : notice.kind === 'suspend'
          ? 'Your Videochat account is suspended'
          : 'Your Videochat account is banned';
    await this.send(
      to,
      subject,
      `${body}<p>If you think this is a mistake, reply to this email.</p>`,
    );
  }
}
