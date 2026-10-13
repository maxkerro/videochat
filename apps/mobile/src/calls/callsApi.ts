import {
  iceServersResponseSchema,
  type CallStats,
  type IceServersResponse,
} from '@videochat/shared';
import { z } from 'zod';
import { apiGet, apiPost } from '../lib/api';

/** CHAT-040: STUN/TURN servers for the next call. Fetched fresh per call -- TURN credentials in
 *  it expire. */
export const fetchIceServers = (): Promise<IceServersResponse> =>
  apiGet('/calls/ice-servers', iceServersResponseSchema);

/** CHAT-043: end-of-call quality summary. Best-effort -- a lost report isn't worth surfacing. */
export const postCallStats = (callId: string, stats: CallStats): Promise<void> =>
  apiPost(`/calls/${callId}/stats`, z.undefined(), stats);
