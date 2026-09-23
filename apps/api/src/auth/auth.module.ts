import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';
import { MailModule } from '../mail/mail.module.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: `${env.JWT_ACCESS_TTL_MIN}m` },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccessTokenGuard],
  exports: [AccessTokenGuard, JwtModule],
})
export class AuthModule {}
