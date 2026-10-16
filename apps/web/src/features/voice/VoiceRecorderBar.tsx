import { formatVoiceTime, VOICE } from '@videochat/shared';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui';
import type { RecorderSnapshot } from './voiceRecorder';
import { Waveform } from './VoiceMessage';
import styles from './Voice.module.css';

/** CHAT-074: in place of the text box while recording: timer, live level, cancel, send. */
export function VoiceRecorderBar({
  snapshot,
  onCancel,
  onSend,
}: {
  snapshot: RecorderSnapshot;
  onCancel: () => void;
  onSend: () => void;
}) {
  // Focus follows the recording: the microphone button it replaced is gone.
  const sendRef = useRef<HTMLButtonElement>(null);
  const ready = snapshot.phase === 'recording';
  useEffect(() => {
    if (ready) sendRef.current?.focus();
  }, [ready]);
  const bars = snapshot.levels.map((l) => Math.round(l * 100));
  const padded = [...Array.from({ length: 32 - bars.length }, () => 0), ...bars];
  const left = VOICE.maxSeconds * 1000 - snapshot.elapsedMs;
  return (
    <div
      className={styles.recorder}
      role="group"
      aria-label="Recording a voice message"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.time} role="timer" aria-live="off">
        {snapshot.phase === 'starting' ? '…' : formatVoiceTime(snapshot.elapsedMs)}
      </span>
      <span className={styles.live}>
        <Waveform waveform={padded} progress={1} />
      </span>
      {left < 30_000 && snapshot.phase === 'recording' && (
        <span className={styles.time}>{formatVoiceTime(left)} left</span>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button ref={sendRef} type="button" size="sm" onClick={onSend} disabled={!ready}>
        Send
      </Button>
    </div>
  );
}
