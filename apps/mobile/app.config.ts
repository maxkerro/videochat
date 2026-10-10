import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * CHAT-050: one codebase, three installable variants that can live side by side on a phone.
 * `APP_VARIANT` is set per EAS build profile (eas.json); anything else is a local development
 * build. Staging talks to the Render staging API, production to the production API.
 */
type Variant = 'development' | 'staging' | 'production';

const VARIANTS: Record<
  Variant,
  { name: string; id: string; scheme: string; apiUrl: string; realtimeUrl: string }
> = {
  development: {
    name: 'Chat (dev)',
    id: 'app.videochat.chat.dev',
    scheme: 'videochat-dev',
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
    realtimeUrl: process.env.EXPO_PUBLIC_REALTIME_URL ?? 'ws://localhost:3000/realtime',
  },
  staging: {
    name: 'Chat (staging)',
    id: 'app.videochat.chat.staging',
    scheme: 'videochat-staging',
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://videochat-api.onrender.com',
    realtimeUrl:
      process.env.EXPO_PUBLIC_REALTIME_URL ?? 'wss://videochat-api.onrender.com/realtime',
  },
  production: {
    name: 'Chat',
    id: 'app.videochat.chat',
    scheme: 'videochat',
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://api.videochat.example',
    realtimeUrl: process.env.EXPO_PUBLIC_REALTIME_URL ?? 'wss://api.videochat.example/realtime',
  },
};

function variantFromEnv(value: string | undefined): Variant {
  return value === 'staging' || value === 'production' ? value : 'development';
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantFromEnv(process.env.APP_VARIANT);
  const v = VARIANTS[variant];
  return {
    ...config,
    name: v.name,
    slug: 'videochat',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: v.scheme,
    userInterfaceStyle: 'automatic',
    ios: { bundleIdentifier: v.id, supportsTablet: false },
    android: { package: v.id },
    plugins: ['expo-router', 'expo-secure-store'],
    extra: { variant, apiUrl: v.apiUrl, realtimeUrl: v.realtimeUrl },
  };
};
