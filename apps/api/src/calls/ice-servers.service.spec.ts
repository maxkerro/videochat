import { createHmac } from 'node:crypto';
import type { Env } from '../config/env.js';
import { IceServersService } from './ice-servers.service.js';

const baseEnv = {
  STUN_URLS: ['stun:stun.example.test:3478'],
  TURN_PROVIDER: 'none',
  TURN_URLS: [] as string[],
  TURN_SECRET: '',
  TURN_TTL_SEC: 3600,
  CLOUDFLARE_TURN_KEY_ID: '',
  CLOUDFLARE_TURN_API_TOKEN: '',
};

function service(overrides: Partial<typeof baseEnv> = {}): IceServersService {
  return new IceServersService({ ...baseEnv, ...overrides } as unknown as Env);
}

const now = new Date('2026-10-01T12:00:00Z');
const nowUnix = Math.floor(now.getTime() / 1000);

describe('IceServersService (CHAT-040)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands out STUN only when no TURN provider is configured', async () => {
    const res = await service().forUser('user-1', now);
    expect(res).toEqual({
      iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
      ttlSeconds: 3600,
    });
  });

  it('omits the STUN entry entirely when STUN_URLS is empty', async () => {
    const res = await service({ STUN_URLS: [] }).forUser('user-1', now);
    expect(res.iceServers).toEqual([]);
  });

  describe('hmac (coturn use-auth-secret)', () => {
    const secret = 'super-secret-turn-key';
    const turnUrls = ['turn:turn.example.test:3478', 'turns:turn.example.test:443?transport=tcp'];

    it('issues a credential whose username embeds an expiry TTL seconds from now', async () => {
      const res = await service({
        TURN_PROVIDER: 'hmac',
        TURN_URLS: turnUrls,
        TURN_SECRET: secret,
      }).forUser('user-1', now);
      const turn = res.iceServers[1]!;
      expect(turn.urls).toEqual(turnUrls);
      expect(turn.username).toBe(`${nowUnix + 3600}:user-1`);
    });

    it('signs the username with HMAC-SHA1 of the shared secret, exactly as coturn verifies it', async () => {
      const res = await service({
        TURN_PROVIDER: 'hmac',
        TURN_URLS: turnUrls,
        TURN_SECRET: secret,
      }).forUser('user-1', now);
      const turn = res.iceServers[1]!;
      const expected = createHmac('sha1', secret).update(turn.username!).digest('base64');
      expect(turn.credential).toBe(expected);
    });

    it('issues a different credential later, so an expired one is never handed out again', async () => {
      const svc = service({ TURN_PROVIDER: 'hmac', TURN_URLS: turnUrls, TURN_SECRET: secret });
      const first = (await svc.forUser('user-1', now)).iceServers[1]!;
      const later = (await svc.forUser('user-1', new Date(now.getTime() + 3_601_000)))
        .iceServers[1]!;
      expect(later.username).not.toBe(first.username);
      expect(later.credential).not.toBe(first.credential);
    });

    it('honours a custom TTL', async () => {
      const res = await service({
        TURN_PROVIDER: 'hmac',
        TURN_URLS: turnUrls,
        TURN_SECRET: secret,
        TURN_TTL_SEC: 600,
      }).forUser('user-1', now);
      expect(res.ttlSeconds).toBe(600);
      expect(res.iceServers[1]!.username).toBe(`${nowUnix + 600}:user-1`);
    });
  });

  describe('cloudflare', () => {
    const cf = {
      TURN_PROVIDER: 'cloudflare',
      CLOUDFLARE_TURN_KEY_ID: 'key-123',
      CLOUDFLARE_TURN_API_TOKEN: 'token-abc',
    };

    it('requests credentials for the configured key with the configured TTL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            iceServers: [
              { urls: ['stun:stun.cloudflare.com:3478'] },
              {
                urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
                username: 'cf-user',
                credential: 'cf-pass',
              },
            ],
          }),
          { status: 201 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const res = await service(cf).forUser('user-1', now);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers',
      );
      expect(init.headers.Authorization).toBe('Bearer token-abc');
      expect(JSON.parse(init.body as string)).toEqual({ ttl: 3600 });
      expect(res.iceServers).toEqual([
        { urls: ['stun:stun.example.test:3478'] },
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'cf-user',
          credential: 'cf-pass',
        },
      ]);
    });

    it('accepts the older single-object response shape too', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              iceServers: {
                urls: ['turn:turn.cloudflare.com:3478'],
                username: 'u',
                credential: 'p',
              },
            }),
            { status: 201 },
          ),
        ),
      );
      const res = await service(cf).forUser('user-1', now);
      expect(res.iceServers).toHaveLength(2);
    });

    it('falls back to STUN only when Cloudflare errors, instead of failing the call', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
      const res = await service(cf).forUser('user-1', now);
      expect(res.iceServers).toEqual([{ urls: ['stun:stun.example.test:3478'] }]);
    });

    it('falls back to STUN only when Cloudflare is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const res = await service(cf).forUser('user-1', now);
      expect(res.iceServers).toEqual([{ urls: ['stun:stun.example.test:3478'] }]);
    });
  });
});
