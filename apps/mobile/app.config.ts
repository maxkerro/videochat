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
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://videochat-api-p6sw.onrender.com',
    realtimeUrl:
      process.env.EXPO_PUBLIC_REALTIME_URL ?? 'wss://videochat-api-p6sw.onrender.com/realtime',
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
    version: '0.2.0',
    orientation: 'portrait',
    scheme: v.scheme,
    userInterfaceStyle: 'automatic',
    ios: { bundleIdentifier: v.id, supportsTablet: false },
    android: { package: v.id },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-sqlite',
      [
        'expo-image-picker',
        { photosPermission: 'Chat needs access to your photos so you can send them.' },
      ],
      'expo-document-picker',
    ],
    // EAS Update (the staging/production build channels need expo-updates). With the
    // `appVersion` runtime policy an over-the-air update only reaches binaries with the same
    // `version`, so bump `version` (and ship a new native build) whenever a native dependency or
    // native config changes -- otherwise an update could reach a binary that lacks the module it
    // needs and crash. JS-only fixes ship over the air without a new build.
    updates: { url: 'https://u.expo.dev/d9871d7c-558e-48d9-a6d7-33c9643a1881' },
    runtimeVersion: { policy: 'appVersion' },
    extra: {
      variant,
      apiUrl: v.apiUrl,
      realtimeUrl: v.realtimeUrl,
      // Links this app to its EAS project (`eas init`, owner maxkerro). Not a secret.
      eas: { projectId: 'd9871d7c-558e-48d9-a6d7-33c9643a1881' },
    },
  };
};
