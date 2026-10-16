import { VOICE } from './domain.js';

/** CHAT-074: "0:07", "1:30" -- a voice message's length or position. */
export function formatVoiceTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * CHAT-074: squeezes the loudness samples taken while recording (any number, each 0..1) into the
 * waveform a voice message carries: `bars` values from 0 to 100, each the loudest sample in its
 * slice, scaled so the loudest bar is 100 and quiet recordings still show a shape.
 */
export function waveformFromLevels(
  levels: readonly number[],
  bars: number = VOICE.waveformBars,
): number[] {
  if (levels.length === 0) return Array.from({ length: bars }, () => 0);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * levels.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j++) peak = Math.max(peak, levels[j]!);
    out.push(peak);
  }
  const max = Math.max(...out);
  return out.map((v) => (max > 0 ? Math.round(Math.min(1, Math.max(0, v / max)) * 100) : 0));
}

/** CHAT-074: a recorder's level in decibels (about -160 silent .. 0 loudest) as 0..1. */
export function levelFromDecibels(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** CHAT-074: the next playback speed (1x -> 1.5x -> 2x -> 1x). */
export function nextVoiceSpeed(current: number): number {
  const speeds: readonly number[] = VOICE.speeds;
  const i = speeds.indexOf(current);
  return speeds[(i + 1) % speeds.length]!;
}

/** CHAT-074: the file name a recording is uploaded under. */
export function voiceFilename(contentType: string, at: Date = new Date()): string {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  const ext =
    base === 'audio/webm'
      ? 'webm'
      : base === 'audio/ogg'
        ? 'ogg'
        : base === 'audio/aac'
          ? 'aac'
          : 'm4a';
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `Voice message ${stamp}.${ext}`;
}

/** What a message's attachment is called in previews, quotes and notifications. */
export function attachmentLabel(attachment: {
  kind: string;
  filename: string;
  voice?: { durationMs: number };
}): string {
  if (attachment.voice) return `Voice message (${formatVoiceTime(attachment.voice.durationMs)})`;
  return attachment.kind === 'image' ? 'Photo' : attachment.filename;
}
