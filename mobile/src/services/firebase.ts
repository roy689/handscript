/**
 * firebase.ts — Custom auth emulator
 *
 * Replaces the Firebase client SDK.
 * Credentials (FIREBASE_WEB_API_KEY) now live exclusively on the backend.
 * The mobile app only stores the JWT tokens it receives from the backend proxy.
 *
 * Public API is intentionally identical to the subset of Firebase Auth used
 * across the codebase, so no other file needs to change its call sites.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL } from '../config';
import { flushOfflineQueue } from '../utils/api';

// ── Storage keys ──────────────────────────────────────────────────────────────
const _K_TOKEN   = '@hs_idToken';
const _K_REFRESH = '@hs_refreshToken';
const _K_EXP     = '@hs_tokenExp';   // unix-ms when the ID token expires
const _K_USER    = '@hs_user';       // JSON: { uid, email }

// ── Types ─────────────────────────────────────────────────────────────────────
export type AuthUser = {
  uid:         string;
  email:       string | null;
  displayName: string | null;   // always null (not exposed by our proxy)
  getIdToken:  (forceRefresh?: boolean) => Promise<string>;
};

type AuthListener = (user: AuthUser | null) => void;

// ── Auth emulator singleton ───────────────────────────────────────────────────
class _Auth {
  currentUser: AuthUser | null = null;

  private _listeners  = new Set<AuthListener>();
  private _pending: AuthListener[] = []; // called once after async restore
  private _ready      = false;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Restore session from AsyncStorage asynchronously on construction.
    this._restore();
  }

  // ── Public API (mirrors Firebase Auth) ──────────────────────────────────────

  /**
   * Register an auth-state listener.
   * Fires immediately (async) with the current state once restore completes.
   * Returns an unsubscribe function.
   */
  onAuthStateChanged(listener: AuthListener): () => void {
    this._listeners.add(listener);
    if (this._ready) {
      Promise.resolve().then(() => listener(this.currentUser));
    } else {
      this._pending.push(listener);
    }
    return () => { this._listeners.delete(listener); };
  }

  async signOut(): Promise<void> {
    this._cancelRefresh();
    await AsyncStorage.multiRemove([_K_TOKEN, _K_REFRESH, _K_EXP, _K_USER]);
    this._emit(null);
  }

  // ── Internal: called by auth.ts after successful login / signup ─────────────

  async _saveSession(data: {
    uid:          string;
    email:        string;
    idToken:      string;
    refreshToken: string;
    expiresIn:    string;   // seconds as string, e.g. "3600"
  }): Promise<void> {
    const expMs = Date.now() + parseInt(data.expiresIn, 10) * 1_000;
    await AsyncStorage.multiSet([
      [_K_TOKEN,   data.idToken],
      [_K_REFRESH, data.refreshToken],
      [_K_EXP,     String(expMs)],
      [_K_USER,    JSON.stringify({ uid: data.uid, email: data.email })],
    ]);
    this._emit(this._buildUser(data.uid, data.email));
    this._scheduleRefresh(expMs - Date.now());
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _buildUser(uid: string, email: string): AuthUser {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      uid,
      email,
      displayName: null,
      getIdToken: (forceRefresh = false) => self._getToken(forceRefresh),
    };
  }

  private async _getToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh) {
      const pairs  = await AsyncStorage.multiGet([_K_TOKEN, _K_EXP]);
      const token  = pairs[0]?.[1];
      const expStr = pairs[1]?.[1];
      if (token && Date.now() < parseInt(expStr ?? '0', 10) - 60_000) {
        return token;
      }
    }
    return this._doRefresh();
  }

  private async _doRefresh(): Promise<string> {
    const refreshToken = await AsyncStorage.getItem(_K_REFRESH);
    if (!refreshToken) {
      await this.signOut();
      throw new Error('Session expired — please sign in again.');
    }

    // Retry up to 3 times with exponential back-off (network hiccups)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${BACKEND_URL}/auth/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          // 401 = token revoked — sign out immediately, no retry
          if (res.status === 401) break;
          throw new Error(`refresh HTTP ${res.status}`);
        }
        const d = await res.json() as { idToken: string; refreshToken?: string; expiresIn: string };
        const expMs = Date.now() + parseInt(d.expiresIn, 10) * 1_000;
        await AsyncStorage.multiSet([
          [_K_TOKEN, d.idToken],
          [_K_EXP,   String(expMs)],
          ...(d.refreshToken ? [[_K_REFRESH, d.refreshToken]] as [string, string][] : []),
        ]);
        this._scheduleRefresh(expMs - Date.now());
        return d.idToken;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise<void>(r => setTimeout(r, 1_000 * 2 ** attempt));
        }
      }
    }

    await this.signOut();
    throw lastErr ?? new Error('Session expired — please sign in again.');
  }

  private _scheduleRefresh(msUntilExpiry: number): void {
    this._cancelRefresh();
    const delay = Math.max(0, msUntilExpiry - 5 * 60_000); // 5 min before expiry
    this._refreshTimer = setTimeout(() => {
      this._doRefresh()
        .then(() => {
          console.debug('[Auth] Token refreshed successfully');
        })
        .catch(err => {
          console.error('[Auth] Token refresh failed:', err);
          // Sign out user if refresh fails — prevents auth state inconsistency
          this.signOut();
        });
    }, delay);
  }

  private _cancelRefresh(): void {
    if (this._refreshTimer !== null) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  private _emit(user: AuthUser | null): void {
    this.currentUser = user;
    this._listeners.forEach(l => l(user));
  }

  private async _restore(): Promise<void> {
    try {
      const [[, token], [, expStr], [, userStr]] = await AsyncStorage.multiGet([
        _K_TOKEN, _K_EXP, _K_USER,
      ]);

      if (token && userStr) {
        const { uid, email } = JSON.parse(userStr) as { uid: string; email: string };
        const expMs = parseInt(expStr ?? '0', 10);

        if (Date.now() < expMs - 60_000) {
          // Token still valid
          this.currentUser = this._buildUser(uid, email);
          this._scheduleRefresh(expMs - Date.now());
        } else {
          // Token expired — attempt silent refresh
          try {
            await this._doRefresh();
            // Re-read user if refresh succeeded (doRefresh doesn't re-emit user)
            const [[, newUserStr]] = await AsyncStorage.multiGet([_K_USER]);
            if (newUserStr) {
              const { uid: u, email: e } = JSON.parse(newUserStr) as { uid: string; email: string };
              this.currentUser = this._buildUser(u, e);
            }
          } catch {
            // Refresh failed — user stays null (signed out)
          }
        }
      }
    } catch {
      // Ignore storage errors — treat as signed out
    } finally {
      this._ready = true;
      // Fire all listeners that registered before restore completed
      this._pending.forEach(l => l(this.currentUser));
      this._pending = [];
      // Also fire currently registered listeners
      this._listeners.forEach(l => l(this.currentUser));
      // Flush any requests that were queued while the device was offline
      flushOfflineQueue().catch(() => {});
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────
export const auth = new _Auth();

/**
 * Standalone helper matching Firebase's calling convention:
 *   onAuthStateChanged(auth, callback) → unsubscribe
 *
 * The first argument is typed as `typeof auth` so callers don't need to know
 * about the private `_Auth` class.
 */
export function onAuthStateChanged(
  authInstance: Pick<typeof auth, 'onAuthStateChanged'>,
  callback: (user: AuthUser | null) => void,
): () => void {
  return authInstance.onAuthStateChanged(callback);
}

// db is no longer accessed from the mobile client.
// subscription.ts now calls backend endpoints instead of Firestore directly.
export const db   = null;
export const app  = null;
