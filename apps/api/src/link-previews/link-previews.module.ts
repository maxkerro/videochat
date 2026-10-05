import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { LinkPreviewFetcher } from './link-preview.fetcher.js';
import { LinkPreviewsController } from './link-previews.controller.js';
import { LinkPreviewsService } from './link-previews.service.js';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [LinkPreviewsController],
  providers: [LinkPreviewFetcher, LinkPreviewsService],
  exports: [LinkPreviewsService],
})
export class LinkPreviewsModule {}
