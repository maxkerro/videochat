import {
  AudioQuality,
  createAudioPlayer,
  IOSOutputFormat,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import type { PlayerAdapter, PlayerStatus } from './playback';
import type { RecorderAdapter } from './capture';

/**
 * CHAT-074: how the phone records a voice message -- AAC in MP4 (.m4a), mono, 64 kbps: about 2.4
 * MB for the full 5 minutes, and every browser and phone plays it.
 */
export const VOICE_RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44_100,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac', audioSource: 'voice_recognition' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64_000 },
};
export const VOICE_RECORDING_TYPE = 'audio/mp4';

let player: AudioPlayer | null = null;
const listeners = new Set<(s: PlayerStatus) => void>();

function ensurePlayer(): AudioPlayer {
  if (player) return player;
  player = createAudioPlayer(null, { updateInterval: 200 });
  player.addListener('playbackStatusUpdate', (s) => {
    const status: PlayerStatus = {
      currentTimeSec: s.currentTime,
      playing: s.playing,
      didJustFinish: s.didJustFinish,
      failed: s.playbackState === 'failed' || s.playbackState === 'error',
    };
    for (const l of listeners) l(status);
  });
  return player;
}

/** The one expo-audio player voice messages play through. */
export const expoPlayer: PlayerAdapter = {
  prepare: () =>
    setAudioModeAsync({
      playsInSilentMode: true,
      // AC: voice messages keep playing with the screen off or the app in the background.
      shouldPlayInBackground: true,
      // Required for the lock-screen controls, which Android needs to keep playing in the
      // background for long.
      interruptionMode: 'doNotMix',
      allowsRecording: false,
    }),
  load: (uri) => ensurePlayer().replace({ uri }),
  play: () => ensurePlayer().play(),
  pause: () => ensurePlayer().pause(),
  seek: (seconds) => ensurePlayer().seekTo(seconds),
  setRate: (rate) => ensurePlayer().setPlaybackRate(rate),
  onStatus: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setNowPlaying: (title) => {
    const p = ensurePlayer();
    if (title) p.setActiveForLockScreen(true, { title, artist: 'Chat' });
    else p.setActiveForLockScreen(false);
  },
};

/** Wraps an expo-audio recorder (from `useAudioRecorder(VOICE_RECORDING)`). */
export function expoRecorder(recorder: AudioRecorder): RecorderAdapter {
  return {
    start: async () => {
      // Stop any voice message playing, and switch the session to recording.
      expoPlayer.pause();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    },
    stop: async () => {
      await recorder.stop();
      // Back to playback through the speaker (iOS routes to the earpiece while recording).
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      return recorder.uri;
    },
    metering: () => recorder.getStatus().metering,
  };
}
