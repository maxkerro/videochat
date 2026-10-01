import {
  iceServersResponseSchema,
  type CallStats,
  type IceServersResponse,
} from '@videochat/shared';
import { z } from 'zod';
import { apiGet, apiPost } from '../../lib/api';

/** CHAT-040: STUN/TURN servers for the next call. Fetched fresh per call -- TURN credentials in
 *  it expire. */
export function fetchIceServers(accessToken: string): Promise<IceServersResponse> {
  return apiGet('/calls/ice-servers', iceServersResponseSchema, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** CHAT-043: end-of-call quality summary. Best-effort -- a lost report isn't worth surfacing. */
export function postCallStats(
  accessToken: string,
  callId: string,
  stats: CallStats,
): Promise<void> {
  return apiPost(`/calls/${callId}/stats`, z.undefined(), stats, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
