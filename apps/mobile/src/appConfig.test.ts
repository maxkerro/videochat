import { describe, expect, it } from 'vitest';
import appConfig from '../app.config';

type PluginEntry = string | [string, Record<string, unknown>];

const config = appConfig({ config: {} } as never);
const plugin = (name: string) =>
  (config.plugins as PluginEntry[]).find((p) => (Array.isArray(p) ? p[0] : p) === name);

describe('app config for calls (CHAT-060)', () => {
  it('loads the WebRTC plugin with the permission texts iOS shows', () => {
    const entry = plugin('@config-plugins/react-native-webrtc');
    expect(Array.isArray(entry)).toBe(true);
    const options = (entry as [string, Record<string, string>])[1];
    expect(options.cameraPermission).toMatch(/camera/i);
    expect(options.microphonePermission).toMatch(/microphone/i);
  });

  it('does not strip the microphone permission calls need', () => {
    // `microphonePermission: false` on the image picker adds RECORD_AUDIO to the Android
    // manifest's removals, and calls then cannot hear anyone.
    const picker = plugin('expo-image-picker') as [string, Record<string, unknown>];
    expect(picker[1].microphonePermission).not.toBe(false);
    const blocked = config.android?.blockedPermissions ?? [];
    expect(blocked).not.toContain('android.permission.RECORD_AUDIO');
    expect(blocked).not.toContain('android.permission.CAMERA');
  });

  it('keeps "draw over other apps" out of the app', () => {
    expect(config.android?.blockedPermissions).toContain('android.permission.SYSTEM_ALERT_WINDOW');
  });

  it('allows picture-in-picture, background sound and Bluetooth routing (CHAT-062)', () => {
    expect(plugin('expo-pip')).toBeDefined();
    expect(config.android?.permissions).toContain('android.permission.BLUETOOTH_CONNECT');
    expect(config.ios?.infoPlist?.UIBackgroundModes).toContain('audio');
  });
});
