import { useContext } from 'react';
import { CallContext } from '../calls/CallProvider';
import { useOptionalGroupCall } from './GroupCallProvider';

/** In any call already (1:1, or a group call): no second one. */
export function useOptionalCallsBusy(): boolean {
  const calls = useContext(CallContext);
  const group = useOptionalGroupCall();
  const oneToOne = calls?.call != null && calls.call.phase !== 'ended';
  return oneToOne || Boolean(group?.session);
}
