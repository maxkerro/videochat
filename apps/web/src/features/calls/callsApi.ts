import { iceServersResponseSchema, type IceServersResponse } from '@videochat/shared';
import { apiGet } from '../../lib/api';

/** CHAT-040: STUN/TURN servers for the next call. Fetched fresh per call -- TURN credentials in
 *  it expire. */
export function fetchIceServers(accessToken: string): Promise<IceServersResponse> {
  return apiGet('/calls/ice-servers', iceServersResponseSchema, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
