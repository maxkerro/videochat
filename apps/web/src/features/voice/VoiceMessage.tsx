import {
  formatVoiceTime,
  nextVoiceSpeed,
  type Attachment,
  type VoiceInfo,
} from '@videochat/shared';
import type { KeyboardEvent, MouseEvent } from 'react';
import { cx } from '../../lib/cx';
import { useVoicePlayback } from './VoicePlaybackProvider';
import styles from './Voice.module.css';

/** The bars of a waveform; those before `progress` (0..1) are drawn as played. */
export function Waveform({ waveform, progress }: { waveform: number[]; progress: number }) {
  return (
    <span className={styles.bars} aria-hidden="true">
      {waveform.map((v, i) => (
        <span
          key={i}
          className={cx(styles.bar, (i + 0.5) / waveform.length <= progress && styles.played)}
          style={{ height: `${Math.max(8, v)}%` }}
        />
      ))}
    </span>
  );
}

const SEEK_STEP_MS = 5000;

/** CHAT-074: a voice message in the chat: play/pause, waveform to seek, time, 1x/1.5x/2x. */
export function VoiceMessage({ attachment }: { attachment: Attachment & { voice: VoiceInfo } }) {
  const { store, state } = useVoicePlayback();
  const { durationMs, waveform } = attachment.voice;
  const current = state.attachmentId === attachment.id;
  const playing = current && state.playing;
  const position = current ? Math.min(state.positionMs, durationMs) : 0;
  const progress = durationMs > 0 ? position / durationMs : 0;

  function seekTo(ms: number) {
    void store.seek(attachment.id, Math.max(0, Math.min(durationMs, ms)));
  }
  function onBarsClick(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    seekTo(fraction * durationMs);
  }
  function onBarsKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowRight: position + SEEK_STEP_MS,
      ArrowUp: position + SEEK_STEP_MS,
      ArrowLeft: position - SEEK_STEP_MS,
      ArrowDown: position - SEEK_STEP_MS,
      Home: 0,
      End: durationMs,
    };
    if (event.key in moves) {
      event.preventDefault();
      seekTo(moves[event.key]!);
    }
  }

  return (
    <span className={styles.voice}>
      <button
        type="button"
        className={styles.play}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => void store.toggle(attachment.id)}
        disabled={current && state.loading}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
            <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"
              fill="currentColor"
            />
          </svg>
        )}
      </button>
      <div
        className={styles.seek}
        role="slider"
        tabIndex={0}
        aria-label="Voice message position"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(position / 1000)}
        aria-valuetext={`${formatVoiceTime(position)} of ${formatVoiceTime(durationMs)}`}
        onClick={onBarsClick}
        onKeyDown={onBarsKey}
      >
        <Waveform waveform={waveform} progress={progress} />
      </div>
      <span className={styles.time}>
        {current && (state.playing || position > 0)
          ? formatVoiceTime(position)
          : formatVoiceTime(durationMs)}
      </span>
      <button
        type="button"
        className={styles.speed}
        aria-label={`Playback speed ${state.rate}x`}
        onClick={() => store.setRate(nextVoiceSpeed(state.rate))}
      >
        {state.rate}x
      </button>
      {current && state.error && (
        <span className={styles.error} role="alert">
          Couldn’t play this.
        </span>
      )}
    </span>
  );
}
