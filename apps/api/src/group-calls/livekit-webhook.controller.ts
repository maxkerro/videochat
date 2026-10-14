import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';
import { GroupCallsService } from './group-calls.service.js';

/** Webhook bodies are small JSON; anything bigger is not LiveKit. */
const MAX_BODY_BYTES = 64 * 1024;

/** The request body exactly as sent: the signature covers its bytes. LiveKit sends
 *  `application/webhook+json`, which the JSON body parser leaves alone, so the stream is unread. */
async function rawBody(req: Request): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UnauthorizedException('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * CHAT-070: LiveKit's webhook (configured in the LiveKit Cloud project, see docs/DEPLOYMENT.md).
 * Signed with the project's API secret; unsigned or wrongly signed calls are refused. Only
 * `participant_joined` is acted on: a non-member is removed from the room at once.
 */
@Controller('livekit')
export class LiveKitWebhookController {
  private readonly receiver: WebhookReceiver | null;

  constructor(
    @Inject(ENV) env: Env,
    private readonly groupCalls: GroupCallsService,
  ) {
    this.receiver =
      env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
        ? new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
        : null;
  }

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Headers('authorization') auth?: string): Promise<void> {
    if (!this.receiver) throw new NotFoundException();
    const body = await rawBody(req);
    let event;
    try {
      event = await this.receiver.receive(body, auth);
    } catch {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (event.event === 'participant_joined' && event.room?.name && event.participant?.identity) {
      await this.groupCalls.onParticipantJoined(event.room.name, event.participant.identity);
    }
  }
}
