/**
 * draftStorage.ts — Persistent draft for the Editor's text input.
 *
 * Saves the user's in-progress text to AsyncStorage so it survives:
 *   • App force-quit / OS-killed background
 *   • Crash during convert (server 500, network drop mid-request)
 *   • Accidental navigation away
 *
 * Distinct from offlineQueue.ts:
 *   - offlineQueue: a SUBMITTED conversion waiting for connectivity
 *   - draftStorage: an UNSUBMITTED text the user is still composing
 *
 * Calls are debounced inside the consumer (EditorScreen) — this module
 * just exposes simple get/set/clear primitives.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@hs_editor_draft';

export type EditorDraft = {
  text:    string;
  savedAt: number;  // unix-ms
};

/** Persist the current text. Empty/whitespace-only drafts are cleared instead. */
export async function saveDraft(text: string): Promise<void> {
  try {
    if (!text.trim()) {
      await AsyncStorage.removeItem(KEY);
      return;
    }
    const draft: EditorDraft = { text, savedAt: Date.now() };
    await AsyncStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Best-effort — never block the editor on storage errors
  }
}

/** Read the last saved draft, or null if none exists or the data is corrupt. */
export async function loadDraft(): Promise<EditorDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorDraft;
    if (typeof parsed?.text !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the saved draft (e.g. after successful conversion). */
export async function clearDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
