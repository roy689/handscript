/**
 * Native ad card, styled to blend with the "Ink & Parchment" UI. Renders
 * nothing in Expo Go / web, on failure, or when ads are disabled.
 *
 * Place it inside a list (e.g. SectionList ListHeaderComponent) on the
 * character bank screen.
 *
 * NOTE: Native ads are the most version-sensitive part of
 * react-native-google-mobile-ads. If a future lib version renames an export,
 * this card simply renders null (guarded) — it will never crash the screen.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { AD_UNITS, getAdsModule, isAdsAvailable, shouldShowAds } from '../services/ads';
import { useTheme } from '../contexts/ThemeContext';
import { fonts, radius } from '../theme';

export default function NativeAdCard() {
  const { colors } = useTheme();
  const [nativeAd, setNativeAd] = useState<any>(null);

  useEffect(() => {
    if (!isAdsAvailable() || !shouldShowAds()) return;
    const ads = getAdsModule();
    const NativeAd = ads?.NativeAd;
    if (!NativeAd?.createForAdRequest) return;

    let mounted = true;
    let ad: any = null;
    NativeAd.createForAdRequest(AD_UNITS.native, { requestNonPersonalizedAdsOnly: false })
      .then((loaded: any) => {
        if (mounted) {
          ad = loaded;
          setNativeAd(loaded);
        } else {
          loaded?.destroy?.();
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
      ad?.destroy?.();
    };
  }, []);

  if (!nativeAd) return null;

  const ads = getAdsModule();
  const NativeAdView = ads?.NativeAdView;
  const NativeAsset = ads?.NativeAsset;
  const NativeMediaView = ads?.NativeMediaView;
  const NativeAssetType = ads?.NativeAssetType;
  if (!NativeAdView || !NativeAsset || !NativeAssetType) return null;

  return (
    <NativeAdView
      nativeAd={nativeAd}
      style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.border }]}
    >
      {/* "Sponsored" label is required by AdMob policy */}
      <View style={[styles.badge, { backgroundColor: colors.accentLight }]}>
        <Text style={[styles.badgeText, { color: colors.accent }]}>מודעה</Text>
      </View>

      <View style={styles.row}>
        {nativeAd.icon?.url ? (
          <NativeAsset assetType={NativeAssetType.ICON}>
            <Image source={{ uri: nativeAd.icon.url }} style={styles.icon} />
          </NativeAsset>
        ) : null}

        <View style={styles.texts}>
          <NativeAsset assetType={NativeAssetType.HEADLINE}>
            <Text numberOfLines={1} style={[styles.headline, { color: colors.inkDark }]}>
              {nativeAd.headline}
            </Text>
          </NativeAsset>
          {!!nativeAd.body && (
            <NativeAsset assetType={NativeAssetType.BODY}>
              <Text numberOfLines={2} style={[styles.body, { color: colors.inkMid }]}>
                {nativeAd.body}
              </Text>
            </NativeAsset>
          )}
        </View>
      </View>

      {NativeMediaView ? <NativeMediaView style={styles.media} resizeMode="cover" /> : null}

      {!!nativeAd.callToAction && (
        <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
          <View style={[styles.cta, { backgroundColor: colors.accent }]}>
            <Text style={[styles.ctaText, { color: colors.bgSurface }]}>
              {nativeAd.callToAction}
            </Text>
          </View>
        </NativeAsset>
      )}
    </NativeAdView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 10,
  },
  badgeText: { fontSize: 10, fontFamily: fonts.bold, letterSpacing: 0.3 },
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, borderRadius: radius.sm, marginLeft: 12 },
  texts: { flex: 1 },
  headline: { fontSize: 15, fontFamily: fonts.bold },
  body: { fontSize: 13, fontFamily: fonts.regular, marginTop: 2, lineHeight: 18 },
  media: { width: '100%', height: 140, borderRadius: radius.md, marginTop: 12 },
  cta: {
    marginTop: 12,
    borderRadius: radius.md,
    paddingVertical: 11,
    alignItems: 'center',
  },
  ctaText: { fontSize: 14, fontFamily: fonts.bold },
});
