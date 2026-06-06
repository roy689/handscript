/**
 * App Open ad controller. Renders nothing — it just manages the lifecycle.
 *
 * Behaviour (tuned to be non-annoying):
 *   • Loads an App Open ad in the background.
 *   • Shows it when the user RETURNS to the app from the background (resume),
 *     never on the very first cold start (so first impression stays clean).
 *   • Frequency cap: at most one App Open ad every 4 minutes.
 *   • Silently no-ops in Expo Go / web / on any failure.
 *
 * Mount once near the app root (inside App.tsx).
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { AD_UNITS, getAdsModule, isAdsAvailable, shouldShowAds } from '../services/ads';

const MIN_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes between App Open ads

export default function AppOpenAdManager() {
  const adRef = useRef<any>(null);
  const loadedRef = useRef(false);
  const showingRef = useRef(false);
  const lastShownRef = useRef(0);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!isAdsAvailable()) return;
    const ads = getAdsModule();
    const AppOpenAd = ads?.AppOpenAd;
    const AdEventType = ads?.AdEventType;
    if (!AppOpenAd || !AdEventType) return;

    let mounted = true;

    const loadAd = () => {
      try {
        const ad = AppOpenAd.createForAdRequest(AD_UNITS.appOpen, {
          requestNonPersonalizedAdsOnly: false,
        });
        ad.addAdEventListener(AdEventType.LOADED, () => {
          if (mounted) loadedRef.current = true;
        });
        ad.addAdEventListener(AdEventType.ERROR, () => {
          loadedRef.current = false;
        });
        ad.addAdEventListener(AdEventType.CLOSED, () => {
          showingRef.current = false;
          loadedRef.current = false;
          loadAd(); // preload the next one
        });
        adRef.current = ad;
        ad.load();
      } catch {
        // ignore
      }
    };

    loadAd();

    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      // Only show when coming back to the foreground (resume), not first launch.
      const resumed = prev.match(/inactive|background/) && next === 'active';
      if (!resumed || !shouldShowAds()) return;
      const now = Date.now();
      if (
        loadedRef.current &&
        !showingRef.current &&
        now - lastShownRef.current > MIN_INTERVAL_MS &&
        adRef.current
      ) {
        try {
          showingRef.current = true;
          lastShownRef.current = now;
          adRef.current.show();
        } catch {
          showingRef.current = false;
        }
      }
    });

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return null;
}
