import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserRecorderDeps, VoiceRecorder, type RecordedVoice } from './voiceRecorder';

/**
 * CHAT-074: click to record, then Send or Cancel. `onRecorded` gets the finished recording
 * (sent as a voice message), `onError` a sentence for the person when the microphone can't be
 * used.
 */
export function useVoiceRecording(options: {
  onRecorded: (recorded: RecordedVoice) => void;
  onError: (message: string) => void;
}) {
  const [handlers] = useState(() => ({ current: options }));
  useEffect(() => {
    handlers.current = options;
  });
  const [recorder] = useState(
    () =>
      new VoiceRecorder(browserRecorderDeps(), () => {
        // The 5-minute limit sends what was recorded.
        void finish();
      }),
  );
  const snapshot = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);

  async function finish() {
    const recorded = await recorder.finish();
    if (recorded) handlers.current.onRecorded(recorded);
  }

  async function start() {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      handlers.current.onError('This browser can’t record voice messages.');
      return;
    }
    try {
      await recorder.start();
    } catch (error) {
      const name = (error as { name?: string }).name;
      handlers.current.onError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access is blocked. Allow it in your browser’s site settings to record.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : 'Couldn’t start recording.',
      );
    }
  }

  // Leaving the chat drops an unfinished recording.
  useEffect(() => () => recorder.cancel(), [recorder]);

  return {
    snapshot,
    recording: snapshot.phase !== 'idle',
    start: () => void start(),
    send: () => void finish(),
    cancel: () => recorder.cancel(),
  };
}
