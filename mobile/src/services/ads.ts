/**
 * AdMob configuration & helpers for HandScript.
 *
 * Placement plan (free users only — Pro users see no ads):
 *   • App Open  — on cold start / resume (frequency-capped)            → App.tsx
 *   • Native    — inside the character bank list                       → CharacterListScreen
 *   • Banner    — quiet screens: CharacterVariants, Privacy, Terms,
 *                 HandwritingCustomizer                                → <AdBanner/>
 *
 * IMPORTANT
 *  - Requires a native build (EAS dev client / production). Ads do NOT work in
 *    Expo Go.
 *  - In development (__DEV__) we always serve Google's TEST ad units, so you
 *    never risk your AdMob account during testing.
 *  - In production we use the real unit IDs from app.json -> extra. Until you
 *    paste real IDs there (replacing the REPLACE_* placeholders) we fall back to
 *    test units so nothing crashes.
 *  - The real AdMob *App ID* lives in app.json -> "react-native-google-mobile-ads".
 */

import Constants from 'expo-constants';

// The native module is only present in a real build. Requiring it lazily keeps
// Expo Go / web from crashing on import.
let _ads: typeof import('react-native-google-mobile-ads') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _ads = require('react-native-google-mobile-ads');
} catch {
  _ads = null;
}

export function isAdsAvailable(): boolean {
  return !!_ads && !!_ads.default;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

function pickUnit(prodId: string | undefined, testId: string): string {
  if (__DEV__) return testId;
  if (!prodId || prodId.includes('REPLACE')) return testId;
  return prodId;
}

// Google's public test unit fallbacks (safe to ship; show test ads only).
const TEST = {
  BANNER: 'ca-app-pub-3940256099942544/6300978111',
  INTERSTITIAL: 'ca-app-pub-3940256099942544/1033173712',
  APP_OPEN: 'ca-app-pub-3940256099942544/9257395921',
  NATIVE: 'ca-app-pub-3940256099942544/2247696110',
};

export const AD_UNITS = {
  banner: pickUnit(extra.ADMOB_BANNER_ID, _ads?.TestIds?.BANNER ?? TEST.BANNER),
  interstitial: pickUnit(extra.ADMOB_INTERSTITIAL_ID, _ads?.TestIds?.INTERSTITIAL ?? TEST.INTERSTITIAL),
  appOpen: pickUnit(extra.ADMOB_APP_OPEN_ID, _ads?.TestIds?.APP_OPEN ?? TEST.APP_OPEN),
  native: pickUnit(extra.ADMOB_NATIVE_ID, (_ads?.TestIds as any)?.NATIVE ?? TEST.NATIVE),
};

let _initialised = false;

/** Initialise the Mobile Ads SDK once. Safe to call from anywhere. */
export async function initAds(): Promise<void> {
  if (_initialised || !isAdsAvailable()) return;
  _initialised = true;
  try {
    await _ads!.default().initialize();
    preloadInterstitial();
  } catch {
    // best-effort — never block the app on ad init
  }
}

// ── Interstitial (full-screen transition ads) ───────────────────────────────
// Shown at natural exit points (leaving FinalView, finishing sample review),
// never mid-task. Global frequency cap prevents stacking.

let _interstitial: any = null;
let _interstitialLoaded = false;
let _lastInterstitialAt = 0;
const INTERSTITIAL_MIN_MS = 3 * 60 * 1000; // at most one every 3 minutes

export function preloadInterstitial(): void {
  if (!isAdsAvailable()) return;
  const ads = getAdsModule();
  const InterstitialAd = ads?.InterstitialAd;
  const AdEventType = ads?.AdEventType;
  if (!InterstitialAd || !AdEventType) return;
  try {
    const ad = InterstitialAd.createForAdRequest(AD_UNITS.interstitial, {
      requestNonPersonalizedAdsOnly: false,
    });
    ad.addAdEventListener(AdEventType.LOADED, () => { _interstitialLoaded = true; });
    ad.addAdEventListener(AdEventType.ERROR, () => { _interstitialLoaded = false; });
    ad.addAdEventListener(AdEventType.CLOSED, () => {
      _interstitialLoaded = false;
      preloadInterstitial(); // preload the next one
    });
    _interstitial = ad;
    ad.load();
  } catch {
    // ignore
  }
}

/** Show an interstitial if one is ready and the frequency cap has elapsed. */
export function maybeShowInterstitial(): void {
  if (!isAdsAvailable() || !shouldShowAds()) return;
  const now = Date.now();
  if (
    _interstitialLoaded &&
    _interstitial &&
    now - _lastInterstitialAt > INTERSTITIAL_MIN_MS
  ) {
    try {
      _lastInterstitialAt = now;
      _interstitial.show();
    } catch {
      // ignore
    }
  }
}

/**
 * Whether ads should be shown to the current user.
 * All users are free today, so this is `true`. When a real Pro tier exists,
 * gate it here (e.g. read subscription state) so paying users see no ads.
 */
export function shouldShowAds(): boolean {
  return true;
}

export function getAdsModule() {
  return _ads;
}
