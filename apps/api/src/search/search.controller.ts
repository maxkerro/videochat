import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { searchQuerySchema, type SearchQuery, type SearchResponse } from '@videochat/shared';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

@Controller('search')
@UseGuards(AccessTokenGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** CHAT-072: `GET /search?q=budget&conversationId=&from=&after=&before=&has=file&cursor=` */
  @Get()
  find(
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<SearchResponse> {
    return this.search.search(userId, query);
  }
}
