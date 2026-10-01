import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CallsController } from './calls.controller.js';
import { IceServersService } from './ice-servers.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CallsController],
  providers: [IceServersService],
})
export class CallsModule {}
