/**
 * Anchored bottom banner ad. Renders nothing in Expo Go / web, on failure, or
 * for users who shouldn't see ads — so it's always safe to drop into a screen.
 *
 * Usage: place at the bottom of a screen's root view:
 *   <View style={{ flex: 1 }}>
 *     ... screen content ...
 *     <AdBanner />
 *   </View>
 */

import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { AD_UNITS, getAdsModule, isAdsAvailable, shouldShowAds } from '../services/ads';
import { useTheme } from '../contexts/ThemeContext';

export default function AdBanner() {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);

  if (!isAdsAvailable() || !shouldShowAds() || failed) return null;

  const ads = getAdsModule();
  const BannerAd = ads?.BannerAd;
  const BannerAdSize = ads?.BannerAdSize;
  if (!BannerAd || !BannerAdSize) return null;

  return (
    <View
      style={[styles.wrap, { backgroundColor: colors.bgPage, borderTopColor: colors.borderFaint }]}
    >
      <BannerAd
        unitId={AD_UNITS.banner}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: false }}
        onAdFailedToLoad={() => setFailed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
