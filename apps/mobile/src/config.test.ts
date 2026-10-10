import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const good = {
  variant: 'staging',
  apiUrl: 'https://api.example.com/',
  realtimeUrl: 'wss://api.example.com/realtime',
};

describe('parseConfig', () => {
  it('accepts a valid config and strips the trailing slash from the API url', () => {
    expect(parseConfig(good)).toEqual({ ...good, apiUrl: 'https://api.example.com' });
  });

  it('rejects an unknown variant, a bad API url and a non-websocket realtime url', () => {
    expect(() => parseConfig({ ...good, variant: 'beta' })).toThrow(/Invalid app config/);
    expect(() => parseConfig({ ...good, apiUrl: 'not a url' })).toThrow(/Invalid app config/);
    expect(() => parseConfig({ ...good, realtimeUrl: 'https://x' })).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it('rejects a missing extra block', () => {
    expect(() => parseConfig(undefined)).toThrow(/Invalid app config/);
  });
});
