import Constants from 'expo-constants';
import { Platform } from 'react-native';

type ExtraConfig = { BACKEND_URL?: string } | undefined;

/**
 * `??` only catches null/undefined — but Expo's babel plugin replaces
 * `process.env.EXPO_PUBLIC_BACKEND_URL=` (no value) with an empty string `""`,
 * which would pass through the nullish coalescing chain and break every fetch.
 * `nonEmpty()` normalises both to undefined so the chain falls through cleanly.
 */
function nonEmpty(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const fromExtra = nonEmpty(
  (Constants.expoConfig?.extra as ExtraConfig)?.BACKEND_URL ??
  (Constants.expoConfig as { extra?: ExtraConfig })?.extra?.BACKEND_URL,
);

const fromEnv      = nonEmpty(process.env.EXPO_PUBLIC_BACKEND_URL);
const prodFallback = 'https://handscript-production-2667.up.railway.app';

/**
 * In dev (Expo Go on a physical phone or emulator), we cannot use the
 * production URL — the domain doesn't exist yet, and `localhost`/`10.0.2.2`
 * won't reach the dev machine from a real phone on the same WiFi.
 *
 * Expo populates `hostUri` with the Metro bundler's LAN host
 * (e.g. "10.241.237.248:8081"). We extract the IP and point at port 8000
 * (FastAPI default).  This lets a real phone scanning the QR code talk to
 * the backend running on the dev laptop, with zero configuration.
 *
 * iOS Simulator: uses localhost (loopback).
 * Android Emulator: 10.0.2.2 is the host machine.
 * Real device (Expo Go): hostUri gives the laptop's LAN IP.
 */
function devBackendUrl(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as unknown as { manifest2?: { extra?: { expoGo?: { developer?: { tool?: string } } } } })
      .manifest2?.extra?.expoGo?.developer?.tool ??
    '';

  // hostUri looks like "10.241.237.248:8081" — strip the port
  const host = hostUri.split(':')[0];

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:8000`;
  }
  // Fallback per platform
  if (Platform.OS === 'android') return 'http://10.0.2.2:8000';
  return 'http://localhost:8000';
}

/**
 * Priority order:
 *   1. EXPO_PUBLIC_BACKEND_URL from mobile/.env  ← explicit dev choice (Railway, staging)
 *   2. extra.BACKEND_URL from app.json           ← prod build default
 *   3. dev auto-derive from Metro host           ← truly empty .env in dev
 *   4. prod fallback                              ← last resort
 */
export const BACKEND_URL: string =
  fromEnv ??
  fromExtra ??
  (__DEV__ ? devBackendUrl() : prodFallback);

if (!__DEV__ && BACKEND_URL.startsWith('http://')) {
  console.warn('[config] Production build is using HTTP — iOS ATS will block requests');
}

// Helpful breadcrumb in Metro logs
console.log('[config] BACKEND_URL =', BACKEND_URL);
