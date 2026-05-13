import { Platform } from 'react-native';

/**
 * Resolves the dev backend URL for the current environment:
 *   - Physical device via Expo Go: reads the bundler host IP from expo-constants
 *     so the phone can reach your Mac on the same WiFi automatically.
 *   - Android emulator:  10.0.2.2  (emulator's alias for host machine)
 *   - iOS simulator:     localhost
 *   - Production:        EXPO_PUBLIC_BACKEND_URL env var
 */
function resolveDevUrl(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants').default;

    // Try every known location where Expo embeds the bundler host IP.
    // Order matters: prefer the most specific / newest SDK path first.
    const rawHost: string =
      Constants?.expoGoConfig?.debuggerHost ??          // SDK 49+ Expo Go
      Constants?.expoConfig?.hostUri ??                 // SDK 50+ generic
      Constants?.manifest2?.extra?.expoClient?.debuggerHost ?? // SDK 46-48
      Constants?.manifest?.debuggerHost ??              // SDK < 46
      '';

    // rawHost is "192.168.x.x:8081" — strip the Metro port, use backend port
    const ip = rawHost.split(':')[0];
    if (ip && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '') {
      return `http://${ip}:8000`;
    }
  } catch {
    // expo-constants unavailable — fall through
  }

  // Emulator shortcuts (never reached on a physical device in Expo Go)
  return Platform.select({
    android: 'http://10.0.2.2:8000',
    ios:     'http://localhost:8000',
    default: 'http://localhost:8000',
  }) as string;
}

export const BACKEND_URL: string =
  process.env.EXPO_PUBLIC_BACKEND_URL || resolveDevUrl();
