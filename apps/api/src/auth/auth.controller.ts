import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signUpSchema,
  verifyEmailSchema,
  type AuthSession,
} from '@videochat/shared';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { REFRESH_COOKIE_NAME, clearRefreshCookie, setRefreshCookie } from './refresh-cookie.js';

const emailOnlySchema = requestPasswordResetSchema; // { email }

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('signup')
  @HttpCode(201)
  async signUp(@Body(new ZodValidationPipe(signUpSchema)) body: z.infer<typeof signUpSchema>) {
    await this.auth.signUp(body);
    return { message: 'Account created. Check your email to verify it.' };
  }

  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
  ) {
    await this.auth.resendVerification(body.email);
    return { message: 'If that email has an account, a verification link was sent.' };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
  ) {
    await this.auth.verifyEmail(body.token);
    return { message: 'Email verified.' };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const { session, refreshToken } = await this.auth.login(body);
    setRefreshCookie(res, refreshToken, this.env);
    return session;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const current = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    const { session, refreshToken } = await this.auth.refresh(current);
    setRefreshCookie(res, refreshToken, this.env);
    return session;
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const current = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    await this.auth.logout(current);
    clearRefreshCookie(res, this.env);
    return { message: 'Logged out.' };
  }

  @Post('request-password-reset')
  @HttpCode(200)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(requestPasswordResetSchema))
    body: z.infer<typeof requestPasswordResetSchema>,
  ) {
    await this.auth.requestPasswordReset(body.email);
    return { message: 'If that email has an account, a reset link was sent.' };
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ) {
    await this.auth.resetPassword(body);
    return { message: 'Password updated.' };
  }
}
