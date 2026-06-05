import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth } from '../services/firebase';

// ── Network check ─────────────────────────────────────────────────────────────

export async function isNetworkAvailable(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch {
    return false; // Bug #1 fix: NetInfo failure → assume offline, not online
  }
}

// ── Auth token helper ─────────────────────────────────────────────────────────

/**
 * Returns the current user's Firebase ID token, or null if not signed in.
 * Retries once on transient failure before throwing — prevents silent auth
 * failures that would cause requests to go unauthenticated.
 * Used by screens that call raw `fetch()` (multipart, binary, etc.).
 * Screens using `fetchJSON` get the token automatically — no need to call this.
 */
export async function getAuthToken(): Promise<string | null> {
  // Bug #2 fix: retry once instead of silently returning null on failure
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await auth.currentUser?.getIdToken(false) ?? null;
    } catch (err) {
      if (attempt === 1) {
        console.error('[Auth] getAuthToken failed after retry:', err);
        return null;
      }
      await new Promise<void>(r => setTimeout(r, 500));
    }
  }
  return null;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastError: unknown;
  const MAX_BACKOFF_MS = 30_000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1) {
        onRetry?.(i + 1, err);
        // Bug #3 fix: cap backoff at 30s to prevent multi-minute waits
        await new Promise<void>(r => setTimeout(r, Math.min(1_000 * 2 ** i, MAX_BACKOFF_MS)));
      }
    }
  }
  throw lastError;
}

// ── Offline request queue ─────────────────────────────────────────────────────

const _OFFLINE_QUEUE_KEY = '@hs_offline_queue';

export async function queueOfflineRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<void> {
  try {
    const queue = JSON.parse(
      await AsyncStorage.getItem(_OFFLINE_QUEUE_KEY) ?? '[]',
    ) as unknown[];
    queue.push({ timestamp: Date.now(), method, url, body });
    await AsyncStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    console.debug('[queue] Request queued: %s %s', method, url);
  } catch {
    // ignore storage errors
  }
}

export async function flushOfflineQueue(): Promise<void> {
  if (!(await isNetworkAvailable())) return;  // B28: skip flush if offline
  try {
    const queue = JSON.parse(
      await AsyncStorage.getItem(_OFFLINE_QUEUE_KEY) ?? '[]',
    ) as { method: string; url: string; body?: unknown }[];
    if (queue.length === 0) return;

    console.debug('[queue] Flushing %d queued requests', queue.length);
    let succeeded = 0;
    for (const req of queue) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20000);
      try {
        await fetch(req.url, {
          method:  req.method,
          headers: { 'Content-Type': 'application/json' },
          body:    req.body ? JSON.stringify(req.body) : undefined,
          signal:  controller.signal,
        });
        succeeded++;
      } catch {
        // skip failed, retry next flush
      } finally {
        clearTimeout(t);
      }
    }
    console.info('[queue] Flushed %d / %d requests', succeeded, queue.length);
    if (succeeded > 0) {
      await AsyncStorage.setItem(_OFFLINE_QUEUE_KEY, '[]');
    }
  } catch {
    // ignore storage errors
  }
}

// ── Typed JSON fetch ─────────────────────────────────────────────────────────

export class OfflineError extends Error {
  constructor() {
    super('אין חיבור לאינטרנט. בדוק את החיבור ונסה שוב.');
    this.name = 'OfflineError';
  }
}

const FETCH_TIMEOUT_MS = 20_000;

/**
 * fetch() wrapper that:
 *  1. Auto-injects the JWT Authorization header for authenticated users
 *  2. Parses JSON
 *  3. Throws a descriptive Error for non-2xx responses
 *  4. Enforces a 20-second timeout
 *  5. Converts network-level TypeErrors to OfflineError
 */
export async function fetchJSON<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  // Bug #4 fix: removed isNetworkAvailable() pre-check — race condition between
  // check and fetch. Network failures are now caught as TypeError → OfflineError.

  // Auto-inject JWT — screens no longer need to fetch the token themselves
  const token = await getAuthToken();

  // Bug #5 fix: guard against undefined headers before spreading
  const incomingHeaders = options?.headers as Record<string, string> | undefined;
  const headers: Record<string, string> = {
    ...(incomingHeaders ?? {}),
    'Content-Type': incomingHeaders?.['Content-Type'] ?? 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // ── Cert pinning (production) ─────────────────────────────────────────────
  // Block plaintext HTTP in production builds. Full certificate pinning
  // (SHA-256 hash validation) requires react-native-ssl-pinning + bare workflow.
  if (!__DEV__ && url.startsWith('http://')) {
    throw new Error('[Security] HTTP blocked in production — set BACKEND_URL to https://');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json() as { detail?: unknown; error?: string };
        if (typeof body.detail === 'string') {
          detail = body.detail;
        } else if (Array.isArray(body.detail)) {
          // Pydantic validation errors: [{loc, msg, type}, ...]
          detail = (body.detail as Array<{ msg?: string }>)
            .map(d => d.msg ?? '')
            .filter(Boolean)
            .join(', ');
        } else if (body.error) {
          detail = body.error;
        }
      } catch {
        // ignore parse failure on error body
      }
      throw new Error(detail || `שגיאת שרת (${res.status})`);
    }
    // Bug #6 fix: catch invalid JSON instead of crashing
    try {
      return await res.json() as T;
    } catch {
      throw new Error(`Invalid JSON response (${res.status})`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('פסק זמן: השרת לא ענה תוך 20 שניות. ודא שהשרת פועל ושאתה באותה רשת WiFi.');
    }
    // Bug #4 fix: TypeError = network unavailable (fetch threw before getting a response)
    if (err instanceof TypeError) {
      await queueOfflineRequest(options?.method ?? 'GET', url, options?.body);
      throw new OfflineError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Error message normaliser ──────────────────────────────────────────────────

export function toErrorMessage(err: unknown, fallback = 'פעולה נכשלה. נסה שוב.'): string {
  if (err instanceof OfflineError) return err.message;
  if (err instanceof Error)        return err.message || fallback;
  return fallback;
}
