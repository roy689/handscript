/**
 * subscription.ts — Usage and subscription checks
 *
 * Previously read Firestore directly (db from firebase.ts).
 * Now calls backend endpoints — the mobile client never touches Firestore.
 * Public function signatures are unchanged.
 */

import { BACKEND_URL } from '../config';
import { auth } from './firebase';

export const FREE_DAILY_LIMIT = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Not signed in');
    return { Authorization: `Bearer ${token}` };
  } catch (err) {
    console.error('[subscription] Token fetch failed:', err);
    throw err;
  }
}

async function _get<T>(path: string): Promise<T | null> {
  // Auth errors from _authHeaders propagate up — not caught here.
  // Only network/fetch errors are swallowed and returned as null.
  const headers = await _authHeaders();
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, { headers });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkIsProUser(userId: string): Promise<boolean> {
  const data = await _get<{ isPro: boolean }>(`/subscription/${userId}`);
  return data?.isPro ?? false;
}

export async function getDailyUsageCount(userId: string): Promise<number> {
  const data = await _get<{ today_count: number }>(`/usage/${userId}`);
  return data?.today_count ?? 0;
}

export async function checkCanConvert(
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (__DEV__) return { allowed: true };
  try {
    const isPro = await checkIsProUser(userId);
    if (isPro) return { allowed: true };
    const count = await getDailyUsageCount(userId);
    if (count >= FREE_DAILY_LIMIT) {
      return {
        allowed: false,
        reason: `הגעת למגבלת ${FREE_DAILY_LIMIT} המרות יומיות. שדרג ל-Pro לגישה בלתי מוגבלת.`,
      };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

export async function incrementUsage(_userId: string): Promise<void> {
  // Usage is incremented server-side inside /convert and /convert-both.
  // This function is kept for API compatibility but is now a no-op on the client.
}
