import { useSyncExternalStore } from 'react';
import { videoBlur } from '../../modules/video-blur';
import { BlurController, type BlurState, type EffectTrack } from './blur';
import { backgroundBlurOn } from './callPrefs';
import type { RtcStream } from './rtc';

/** CHAT-084: the app's one blur controller (one camera at a time). */
export const blur = new BlurController(videoBlur, backgroundBlurOn);

/** Hands every camera track in `stream` to the blur before the call can send it. */
export function withBlur(stream: RtcStream): RtcStream {
  for (const track of stream.getVideoTracks()) blur.attach(track as unknown as EffectTrack);
  return stream;
}

export function useBlur(): BlurState {
  return useSyncExternalStore(blur.subscribe, blur.getState);
}
