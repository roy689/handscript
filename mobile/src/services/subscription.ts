import { doc, getDoc, setDoc, increment } from 'firebase/firestore';
import { db } from './firebase';

export const FREE_DAILY_LIMIT = 5;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function checkIsProUser(userId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'subscriptions', userId));
    if (!snap.exists()) return false;
    const data = snap.data();
    if (data.status !== 'active') return false;
    if (data.expiresAt && data.expiresAt.toDate() < new Date()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function getDailyUsageCount(userId: string): Promise<number> {
  try {
    const ref = doc(db, 'usage', userId, 'days', todayKey());
    const snap = await getDoc(ref);
    if (!snap.exists()) return 0;
    const count = snap.data()?.count;
    return typeof count === 'number' ? count : 0;
  } catch {
    return 0;
  }
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

export async function incrementUsage(userId: string): Promise<void> {
  if (__DEV__) return;
  try {
    const ref = doc(db, 'usage', userId, 'days', todayKey());
    await setDoc(ref, { count: increment(1) }, { merge: true });
  } catch { /* best-effort */ }
}
