/**
 * auth.ts — Authentication service
 *
 * All Firebase Auth calls are now proxied through the backend.
 * The public function signatures are identical to the previous Firebase-SDK
 * version so call sites throughout the app need no changes.
 */

import { auth, type AuthUser } from './firebase';
import { BACKEND_URL } from '../config';

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
