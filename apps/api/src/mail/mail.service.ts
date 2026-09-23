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
}
