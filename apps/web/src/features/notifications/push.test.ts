import { askForPushAfterFirstSend } from './push';

describe('askForPushAfterFirstSend (CHAT-035)', () => {
  let requestPermission: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    requestPermission = vi.fn().mockResolvedValue('granted');
    subscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
    });
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
    };
    vi.stubGlobal(
      'Notification',
      Object.assign(function Notification() {}, { permission: 'default', requestPermission }),
    );
    vi.stubGlobal('PushManager', function PushManager() {});
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
      },
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/push/vapid-public-key')
        ? new Response(JSON.stringify({ publicKey: 'BBBB' }))
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('asks once, subscribes, and registers the subscription with the server', async () => {
    await askForPushAfterFirstSend('token');
    await askForPushAfterFirstSend('token');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/push/subscriptions'));
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it("doesn't ask when permission was already decided", async () => {
    (Notification as unknown as { permission: string }).permission = 'denied';
    await askForPushAfterFirstSend('token');
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
