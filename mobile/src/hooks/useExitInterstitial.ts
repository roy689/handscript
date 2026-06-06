/**
 * Shows a full-screen interstitial ad when the user leaves the screen (blur).
 * Use on natural exit points only (e.g. FinalView, sample review) — never on
 * work screens. Respects the global frequency cap in services/ads.
 *
 * Usage inside a screen component:
 *   useExitInterstitial(navigation);
 */

import { useEffect } from 'react';
import { maybeShowInterstitial } from '../services/ads';

export function useExitInterstitial(navigation: { addListener: (e: string, cb: () => void) => () => void }) {
  useEffect(() => {
    const unsub = navigation.addListener('blur', () => {
      maybeShowInterstitial();
    });
    return unsub;
  }, [navigation]);
}
