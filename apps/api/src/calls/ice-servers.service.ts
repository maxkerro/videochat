import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { iceServerSchema, type IceServer, type IceServersResponse } from '@videochat/shared';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';

/** How long to wait for Cloudflare before giving up and handing out STUN only. A call that can't
 *  get a relay may still connect directly; a call that waits forever on this never starts. */
export const CLOUDFLARE_TIMEOUT_MS = 3_000;

const cloudflareResponseSchema = z.object({
  // `generate-ice-servers` returns an array; the older `generate` endpoint a single object.
  iceServers: z.union([z.array(iceServerSchema), iceServerSchema]),
});

/**
 * CHAT-040: builds the ICE server list for one call. STUN entries are static; TURN entries carry
 * credentials that expire after `TURN_TTL_SEC`, so a leaked credential can't be used to relay
 * traffic through our TURN bill indefinitely.
 */
@Injectable()
export class IceServersService {
  private readonly logger = new Logger(IceServersService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async forUser(userId: string, now: Date = new Date()): Promise<IceServersResponse> {
    const ttlSeconds = this.env.TURN_TTL_SEC;
    const iceServers: IceServer[] = [];
    if (this.env.STUN_URLS.length > 0) iceServers.push({ urls: this.env.STUN_URLS });

    switch (this.env.TURN_PROVIDER) {
      case 'hmac':
        iceServers.push(this.hmacCredential(userId, now));
        break;
      case 'cloudflare':
        iceServers.push(...(await this.cloudflareCredentials()));
        break;
      case 'none':
        break;
    }
    return { iceServers, ttlSeconds };
  }

  /**
   * coturn's `use-auth-secret` / "TURN REST API" scheme: the username is
   * `<unix expiry>:<user id>` and the password is base64(HMAC-SHA1(secret, username)). coturn
   * recomputes the HMAC itself and rejects the credential once the expiry has passed, so nothing
   * has to be stored server-side and an expired credential can't be reused.
   */
  private hmacCredential(userId: string, now: Date): IceServer {
    const expiry = Math.floor(now.getTime() / 1000) + this.env.TURN_TTL_SEC;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', this.env.TURN_SECRET).update(username).digest('base64');
    return { urls: this.env.TURN_URLS, username, credential };
  }

  /** Cloudflare mints its own short-lived credentials; any failure degrades to STUN only. */
  private async cloudflareCredentials(): Promise<IceServer[]> {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      this.env.CLOUDFLARE_TURN_KEY_ID,
    )}/credentials/generate-ice-servers`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.CLOUDFLARE_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: this.env.TURN_TTL_SEC }),
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = cloudflareResponseSchema.parse(await res.json());
      return Array.isArray(parsed.iceServers) ? parsed.iceServers : [parsed.iceServers];
    } catch (err) {
      this.logger.warn(
        `Cloudflare TURN credentials unavailable, falling back to STUN only: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
