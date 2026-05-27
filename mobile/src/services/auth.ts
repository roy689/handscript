/**
 * auth.ts — Authentication service
 *
 * All Firebase Auth calls are now proxied through the backend.
 * The public function signatures are identical to the previous Firebase-SDK
 * version so call sites throughout the app need no changes.
 *
 * Google federated sign-in uses the native SDK to obtain an OAuth credential,
 * then ships it to the backend which exchanges it with Firebase Identity
 * Toolkit for an idToken/refreshToken pair.
 */

import Constants from 'expo-constants';
import { auth, type AuthUser } from './firebase';
import { BACKEND_URL } from '../config';

// ── Google Sign-In configuration ──────────────────────────────────────────────
// Configure once on first use. webClientId is pulled from app.json -> extra.
// It comes from the Firebase Console: Project Settings -> General -> Your apps
// -> OAuth client IDs (auto-created when you enable Google in Firebase
// Authentication).
//
// IMPORTANT: The native module @react-native-google-signin/google-signin
// REQUIRES a native build (EAS Build dev client or production). It is NOT
// available in Expo Go because Expo Go ships with a fixed set of native
// modules and cannot dynamically load third-party native code.
// `isGoogleSignInAvailable()` lets the UI hide the button in Expo Go.
let _googleConfigured = false;

/**
 * Returns true when the native Google Sign-In module is actually present in
 * the running binary. False in Expo Go (where third-party native modules
 * cannot be loaded) and on web.
 *
 * Implementation: try to require the module and check that the GoogleSignin
 * export exposes a usable method. We don't actually call into it here so
 * this is safe to call from render paths.
 */
export function isGoogleSignInAvailable(): boolean {
  // Expo Go ships with appOwnership === 'expo'. A standalone build / dev
  // client returns 'standalone' or undefined depending on Expo SDK version.
  // Even outside Expo Go, double-check the native binding exists so we don't
  // crash if the package is installed but not linked yet.
  if (Constants.appOwnership === 'expo') {
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-google-signin/google-signin');
    // GoogleSignin proxies to a TurboModule. If the native side is missing
    // the import resolves but property access throws on first use. We only
    // verify the JS shape here.
    return typeof mod?.GoogleSignin?.signIn === 'function';
  } catch {
    return false;
  }
}

function _configureGoogleSignIn(): void {
  if (_googleConfigured) return;
  if (!isGoogleSignInAvailable()) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GoogleSignin } = require('@react-native-google-signin/google-signin');
    const extra = Constants.expoConfig?.extra as
      | { GOOGLE_WEB_CLIENT_ID?: string; GOOGLE_IOS_CLIENT_ID?: string }
      | undefined;

    GoogleSignin.configure({
      // Web client ID is REQUIRED — it's the audience Firebase expects in the ID token
      webClientId: extra?.GOOGLE_WEB_CLIENT_ID ?? '',
      // iOS client ID is only needed when building the native iOS app
      iosClientId: extra?.GOOGLE_IOS_CLIENT_ID,
      offlineAccess: false,    // we don't need a server-side refresh token
      scopes: ['email', 'profile'],
    });
    _googleConfigured = true;
  } catch (err) {
    // Should not happen because isGoogleSignInAvailable() already gated us,
    // but keep a guard in case the runtime check disagrees with the native
    // binding's actual behaviour.
    console.warn('[Auth] GoogleSignin.configure() skipped:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _post<T>(path: string, body: object): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(data.detail ?? `שגיאת שרת (${res.status})`);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('פסק זמן: השרת לא ענה. בדוק את החיבור ונסה שוב.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type _AuthResponse = {
  idToken:      string;
  refreshToken: string;
  expiresIn:    string;
  uid:          string;
  email:        string;
};

// ── Public API ────────────────────────────────────────────────────────────────

export async function signUpWithEmail(email: string, password: string): Promise<AuthUser> {
  const data = await _post<_AuthResponse>('/auth/signup', { email, password });
  await auth._saveSession(data);
  if (!auth.currentUser) throw new Error('Session initialization failed');
  return auth.currentUser;
}

export async function signInWithEmail(email: string, password: string): Promise<AuthUser> {
  const data = await _post<_AuthResponse>('/auth/login', { email, password });
  await auth._saveSession(data);
  if (!auth.currentUser) throw new Error('Session initialization failed');
  return auth.currentUser;
}

export async function signOut(): Promise<void> {
  await auth.signOut();
}

/**
 * Register an auth-state listener.
 * One-argument form used across the app (auth.ts-level convenience wrapper).
 * Returns unsubscribe.
 */
export function onAuthStateChanged(cb: (user: AuthUser | null) => void): () => void {
  return auth.onAuthStateChanged(cb);
}

export function getCurrentUserId(): string | null {
  return auth.currentUser?.uid ?? null;
}

export async function resetPassword(email: string): Promise<void> {
  await _post('/auth/reset-password', { email });
}

// ── Federated sign-in (Google / Apple) ────────────────────────────────────────

/**
 * Sign in with Google.
 *
 * Uses @react-native-google-signin/google-signin to launch the native Google
 * picker, retrieves an ID token, and exchanges it with the backend for a
 * Firebase session. Works on iOS, Android, and Expo dev clients.
 *
 * Throws:
 *   - 'CANCELED' if the user dismisses the picker
 *   - Hebrew error message on backend failures
 */
export async function signInWithGoogle(): Promise<AuthUser> {
  if (!isGoogleSignInAvailable()) {
    throw new Error(
      'התחברות עם גוגל זמינה רק בבילד פיתוח או הפקה. אקספו גו לא תומך במודול הזה.'
    );
  }

  _configureGoogleSignIn();

  // Lazy require so the app still boots if the native module isn't linked yet
  // (e.g. running in Expo Go before EAS Build adds the native code).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleSignin, statusCodes } = require('@react-native-google-signin/google-signin');

  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  let idToken: string | null = null;
  try {
    const result = await GoogleSignin.signIn();
    // SDK 13+ wraps the payload under `data`; older versions returned it flat.
    idToken = result?.data?.idToken ?? result?.idToken ?? null;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === statusCodes?.SIGN_IN_CANCELLED) {
      throw new Error('ההתחברות בוטלה');
    }
    if (code === statusCodes?.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new Error('שירותי גוגל פליי אינם זמינים במכשיר זה');
    }
    throw new Error('שגיאה בהתחברות עם גוגל. נסה שוב.');
  }

  if (!idToken) {
    throw new Error('לא התקבל טוקן מגוגל. נסה שוב.');
  }

  const data = await _post<_AuthResponse>('/auth/signin-google', { id_token: idToken });
  await auth._saveSession(data);
  if (!auth.currentUser) throw new Error('Session initialization failed');
  return auth.currentUser;
}

