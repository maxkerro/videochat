import { describe, expect, it } from 'vitest';
import { createAttachmentUploadSchema, isVoiceContentType } from './schemas.js';
import {
  attachmentLabel,
  formatVoiceTime,
  levelFromDecibels,
  nextVoiceSpeed,
  voiceFilename,
  waveformFromLevels,
} from './voice.js';

describe('voice messages (CHAT-074)', () => {
  it('formats times', () => {
    expect(formatVoiceTime(0)).toBe('0:00');
    expect(formatVoiceTime(7_400)).toBe('0:07');
    expect(formatVoiceTime(90_000)).toBe('1:30');
    expect(formatVoiceTime(300_000)).toBe('5:00');
  });

  it('turns recorded levels into a normalised waveform of a fixed size', () => {
    const w = waveformFromLevels([0, 0.1, 0.2, 0.4, 0.1, 0], 3);
    expect(w).toEqual([25, 100, 25]);
    expect(waveformFromLevels([], 4)).toEqual([0, 0, 0, 0]);
    expect(waveformFromLevels([0.5], 3)).toEqual([100, 100, 100]);
    expect(waveformFromLevels(Array.from({ length: 1000 }, (_, i) => i / 1000))).toHaveLength(48);
  });

  it('maps decibels and cycles speeds', () => {
    expect(levelFromDecibels(-160)).toBe(0);
    expect(levelFromDecibels(0)).toBe(1);
    expect(levelFromDecibels(-30)).toBe(0.5);
    expect(levelFromDecibels(undefined)).toBe(0);
    expect([1, 1.5, 2].map(nextVoiceSpeed)).toEqual([1.5, 2, 1]);
  });

  it('accepts only real recording formats for a voice upload', () => {
    expect(isVoiceContentType('audio/webm;codecs=opus')).toBe(true);
    expect(isVoiceContentType('audio/mp4')).toBe(true);
    expect(isVoiceContentType('text/html')).toBe(false);
    const base = {
      filename: 'v.webm',
      sizeBytes: 1000,
      voice: { durationMs: 1200, waveform: [1, 50] },
    };
    expect(
      createAttachmentUploadSchema.safeParse({ ...base, contentType: 'audio/webm' }).success,
    ).toBe(true);
    expect(
      createAttachmentUploadSchema.safeParse({ ...base, contentType: 'video/mp4' }).success,
    ).toBe(false);
    expect(
      createAttachmentUploadSchema.safeParse({
        ...base,
        contentType: 'audio/webm',
        sizeBytes: 9 * 1024 * 1024,
      }).success,
    ).toBe(false);
    expect(
      createAttachmentUploadSchema.safeParse({
        ...base,
        contentType: 'audio/webm',
        voice: { durationMs: 301_000, waveform: [1] },
      }).success,
    ).toBe(false);
    expect(voiceFilename('audio/webm;codecs=opus', new Date('2026-10-15T09:08:07Z'))).toBe(
      'Voice message 20261015-090807.webm',
    );
  });
});

describe('attachmentLabel (CHAT-074)', () => {
  it('names photos, voice messages and files', () => {
    expect(attachmentLabel({ kind: 'image', filename: 'a.jpg' })).toBe('Photo');
    expect(attachmentLabel({ kind: 'file', filename: 'q3.pdf' })).toBe('q3.pdf');
    expect(
      attachmentLabel({ kind: 'file', filename: 'v.webm', voice: { durationMs: 65_000 } }),
    ).toBe('Voice message (1:05)');
  });
});
