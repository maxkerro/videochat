import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** The part of Firebase's `google-services.json` this check reads. */
interface GoogleServicesFile {
  client?: Array<{ client_info?: { android_client_info?: { package_name?: string } } }>;
}

interface GoogleServicesEnv {
  /** Where the file is (an EAS file variable, or the committed one beside app.config.ts). */
  path: string;
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

/**
 * CHAT-055: the Google Services Gradle plugin fails a build whose package name has no entry in
 * `google-services.json`. So the file is handed to a variant only if it lists that variant's
 * package; otherwise the variant builds without Firebase (no push on it) instead of not at all.
 * Returns the path to use, or why not.
 */
function pickGoogleServicesFile(
  packageId: string,
  env: GoogleServicesEnv,
): { file: string } | { file: null; reason: string } {
  if (!env.exists(env.path)) return { file: null, reason: 'no google-services.json' };
  let parsed: GoogleServicesFile;
  try {
    parsed = JSON.parse(env.read(env.path)) as GoogleServicesFile;
  } catch {
    return { file: null, reason: 'google-services.json is not valid JSON' };
  }
  const listed = parsed.client?.some(
    (c) => c.client_info?.android_client_info?.package_name === packageId,
  );
  return listed
    ? { file: env.path }
    : {
        file: null,
        reason: `google-services.json has no Android app "${packageId}" (add it in the Firebase console and download the file again)`,
      };
}

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

/** `GOOGLE_SERVICES_JSON` (an EAS file variable) or the `google-services.json` beside this file. */
const googleServicesPath =
  process.env.GOOGLE_SERVICES_JSON ?? join(__dirname, 'google-services.json');

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantFromEnv(process.env.APP_VARIANT);
  const v = VARIANTS[variant];
  // Push needs this variant's package in the file; without it the build still works (see the
  // helper), just without Firebase.
  const googleServices = pickGoogleServicesFile(v.id, {
    path: googleServicesPath,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
  });
  if (googleServices.file === null && existsSync(googleServicesPath)) {
    console.warn(`[app.config] Android push is off for ${v.id}: ${googleServices.reason}`);
  }
  const googleServicesFile = googleServices.file ?? undefined;
  return {
    ...config,
    name: v.name,
    slug: 'videochat',
    version: '0.5.0',
    orientation: 'portrait',
    scheme: v.scheme,
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: v.id,
      supportsTablet: false,
      // CHAT-062: a call keeps its sound when the app is left, and the video can continue in the
      // picture-in-picture window.
      infoPlist: { UIBackgroundModes: ['audio'] },
    },
    android: {
      package: v.id,
      // Firebase Cloud Messaging (CHAT-055): the file from the Firebase console, holding one entry
      // per app id above. Without it the build still works, just without push on Android.
      ...(googleServicesFile ? { googleServicesFile } : {}),
      // The WebRTC config plugin (CHAT-060) also declares "draw over other apps", which a chat app
      // does not need and which Google Play questions; calls work without it.
      blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW'],
      // CHAT-062: lets the call move its sound to a paired Bluetooth headset (Android 12+).
      permissions: ['android.permission.BLUETOOTH_CONNECT'],
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-sqlite',
      [
        'expo-image-picker',
        {
          photosPermission: 'Chat needs access to your photos so you can send them.',
          cameraPermission: 'Chat needs the camera so you can take a photo to send.',
          // Photos only here. The microphone is declared for calls (the WebRTC plugin below); this
          // must not be `false`, which would strip RECORD_AUDIO from the Android manifest.
          microphonePermission:
            'Chat needs the microphone so the other person can hear you on calls.',
        },
      ],
      'expo-document-picker',
      'expo-notifications',
      // CHAT-062: lets a video call continue in a small window (Android picture-in-picture).
      // (The plugin reads its options unconditionally, so it needs the empty object.)
      ['expo-pip', {}],
      // CHAT-061: the phone's own call screen (CallKit on iOS, Telecom on Android). The ring
      // timeout matches the server's (CALL_RING_TIMEOUT_SEC), so a call that rang out is missed.
      [
        'expo-callkit-telecom',
        {
          incomingCallTimeout: 30,
          outgoingCallTimeout: 60,
          fulfillAnswerCallTimeout: 30,
          microphonePermission:
            'Chat needs the microphone so the other person can hear you on calls.',
          cameraPermission: 'Chat needs the camera so the other person can see you on video calls.',
        },
      ],
      // Android Telecom (Core-Telecom) needs Android 8 (API 26). The iOS minimum is already above
      // what the library asks for.
      ['expo-build-properties', { android: { minSdkVersion: 26 } }],
      // The LiveKit WebRTC build used for calls (CHAT-060, swapped in CHAT-061 for iOS CallKit).
      '@livekit/react-native-expo-plugin',
      // CHAT-060: native WebRTC for calls. The texts are what iOS shows in its permission prompts.
      [
        '@config-plugins/react-native-webrtc',
        {
          cameraPermission: 'Chat needs the camera so the other person can see you on video calls.',
          microphonePermission:
            'Chat needs the microphone so the other person can hear you on calls.',
        },
      ],
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
