/**
 * offlineQueue.ts — Persist a single pending conversion across sessions.
 *
 * When the user tries to convert while offline, we save the request here.
 * EditorScreen subscribes to NetInfo and restores the text when connectivity
 * returns, prompting the user to retry.
 *
 * One slot only (latest request wins) — a queue of many unconverted items
 * would confuse users more than help them.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@hs_pending_conversion';

export type PendingConversion = {
  text:       string;
  paperStyle: 'lines' | 'grid' | 'blank';
  inkColor:   'black' | 'blue' | 'red';
  savedAt:    number;  // unix-ms
};

/** Overwrite any existing pending conversion with the new one. */
export async function savePendingConversion(
  item: Omit<PendingConversion, 'savedAt'>,
): Promise<void> {
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify({ ...item, savedAt: Date.now() }),
  );
}

/** Return the pending conversion, or null if none exists. */
export async function getPendingConversion(): Promise<PendingConversion | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingConversion) : null;
  } catch {
    return null;
  }
}

/** Remove the pending conversion from storage. */
export async function clearPendingConversion(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
