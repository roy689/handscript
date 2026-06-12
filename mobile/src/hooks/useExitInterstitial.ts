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

// Structural type wide enough for any react-navigation prop: addListener is
// generically keyed there ('blur' | 'focus' | ...), so a `string` parameter is
// too loose to assign. Accepting `(e: 'blur', ...)` matches every navigator.
export function useExitInterstitial(navigation: { addListener: (e: 'blur', cb: () => void) => () => void }) {
  useEffect(() => {
    const unsub = navigation.addListener('blur', () => {
      maybeShowInterstitial();
    });
    return unsub;
  }, [navigation]);
}
