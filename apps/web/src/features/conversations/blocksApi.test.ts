import { blockUser, fetchBlockedUsers, unblockUser } from './blocksApi.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe('blockUser', () => {
  it('POSTs to /users/:id/block with the auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Blocked.' }));
    vi.stubGlobal('fetch', fetchMock);

    await blockUser('token-1', 'user-2');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/user-2/block');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });
});

describe('unblockUser', () => {
  it('DELETEs to /users/:id/block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Unblocked.' }));
    vi.stubGlobal('fetch', fetchMock);

    await unblockUser('token-1', 'user-2');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/user-2/block');
    expect(init.method).toBe('DELETE');
  });
});

describe('fetchBlockedUsers', () => {
  it('GETs /users/blocked and parses the list', async () => {
    const user = {
      id: '00000000-0000-4000-8000-000000000001',
      username: 'anna_k',
      displayName: 'Anna',
      avatarUrl: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ users: [user] })));

    const result = await fetchBlockedUsers('token-1');

    expect(result.users).toEqual([user]);
  });
});
