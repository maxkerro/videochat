import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { E2eeController } from './e2ee.controller.js';
import { E2eeService } from './e2ee.service.js';

/** CHAT-076 (spike): end-to-end encryption key directory. */
@Module({
  imports: [AuthModule],
  controllers: [E2eeController],
  providers: [E2eeService],
  exports: [E2eeService],
})
export class E2eeModule {}
