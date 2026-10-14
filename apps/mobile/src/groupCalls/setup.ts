import { registerGlobals } from '@livekit/react-native';

/*
 * CHAT-070: LiveKit's WebRTC globals, once, before anything else. The phone's call audio session
 * is managed by the native call library for 1:1 calls (CHAT-061), so LiveKit must not configure
 * the iOS audio session on its own; group calls set it up while they run.
 */
registerGlobals({ autoConfigureAudioSession: false });
