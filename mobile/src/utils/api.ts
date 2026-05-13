import NetInfo from '@react-native-community/netinfo';

// ── Network check ─────────────────────────────────────────────────────────────

/**
 * Returns true when the device has an active internet connection.
 * Throws never — on NetInfo errors it returns true (assume connected) so we
 * don't block the user on a bad connectivity read.
 */
export async function isNetworkAvailable(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch {
    return true;
  }
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

/**
 * Run `fn` up to `maxRetries` times, with exponential back-off between
 * attempts.  Throws the last error if every attempt fails.
 *
 * @param fn          Async function to retry (should be idempotent / safe to repeat)
 * @param maxRetries  Maximum number of attempts (default 3)
 * @param onRetry     Optional callback called before each retry, receives the
 *                    attempt index (1-based) and the error from the last attempt
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1) {
        onRetry?.(i + 1, err);
        // Exponential back-off: 1 s, 2 s, 4 s, …
        await new Promise<void>(r => setTimeout(r, 1_000 * 2 ** i));
      }
    }
  }
  throw lastError;
}

// ── Typed JSON fetch ─────────────────────────────────────────────────────────

/**
 * fetch() wrapper that:
 *  1. Checks for network connectivity first
 *  2. Parses JSON
 *  3. Throws a descriptive Error for non-2xx responses
 *
 * Throws an `OfflineError` when no network is detected so callers can
 * distinguish connectivity problems from server errors.
 */
export class OfflineError extends Error {
  constructor() {
    super('אין חיבור לאינטרנט. בדוק את החיבור ונסה שוב.');
    this.name = 'OfflineError';
  }
}

const FETCH_TIMEOUT_MS = 20_000; // 20 s — prevents the infinite hang on unreachable hosts

export async function fetchJSON<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const online = await isNetworkAvailable();
  if (!online) throw new OfflineError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json() as { detail?: string; error?: string };
        detail = body.detail ?? body.error ?? '';
      } catch {
        // ignore parse failure
      }
      throw new Error(detail || `שגיאת שרת (${res.status})`);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('פסק זמן: השרת לא ענה תוך 20 שניות. ודא שהשרת פועל ושאתה באותה רשת WiFi.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Error message normaliser ──────────────────────────────────────────────────

/**
 * Converts any thrown value into a user-facing Hebrew string.
 */
export function toErrorMessage(err: unknown, fallback = 'פעולה נכשלה. נסה שוב.'): string {
  if (err instanceof OfflineError) return err.message;
  if (err instanceof Error)        return err.message || fallback;
  return fallback;
}
