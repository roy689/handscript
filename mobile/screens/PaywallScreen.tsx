import React, { useMemo } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useTheme, ThemeColors } from '../src/contexts/ThemeContext';
import { radius, shadow } from '../src/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Paywall'>;

const TIERS = [
  {
    id: 'free',
    name: 'חינמי',
    price: '₪0',
    period: 'לתמיד',
    highlight: false,
    badge: null,
    features: [
      '5 המרות ביום',
      'סימן מים גלוי',
      'ייצוא PNG בלבד',
      'עד 500 תווים',
    ],
    cta: null,
  },
  {
    id: 'monthly',
    name: 'Pro חודשי',
    price: '₪19.90',
    period: 'לחודש',
    highlight: true,
    badge: 'הכי פופולרי',
    features: [
      'המרות ללא הגבלה',
      'ללא סימן מים',
      'ייצוא PDF + PNG',
      'עד 5,000 תווים',
      'עדיפות בשרת',
    ],
    cta: 'הירשם חודשי',
  },
  {
    id: 'yearly',
    name: 'Pro שנתי',
    price: '₪99',
    period: 'לשנה',
    highlight: false,
    badge: 'חיסכון 60%',
    features: [
      'הכל ב-Pro חודשי',
      'חיסכון של ₪140 לשנה',
      'תמיכה מועדפת',
      'גישה מוקדמת לפיצ׳רים',
    ],
    cta: 'הירשם שנתי',
  },
] as const;

export default function PaywallScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  function handlePurchase(_tierId: string) {
    Alert.alert(
      'המסלולים בדרך',
      'תכניות Pro נמצאות בפיתוח ויהיו זמינות בקרוב. בינתיים תוכל ליהנות מ-5 המרות חינם ביום.',
      [{ text: 'הבנתי', style: 'default' }],
    );
  }

  function handleRestore() {
    Alert.alert(
      'שחזור רכישות',
      'לא נמצאו רכישות קודמות. כאשר תכניות Pro יושקו, תוכל לשחזר את הרכישה כאן.',
      [{ text: 'אישור', style: 'default' }],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.crown}>👑</Text>
        <Text style={styles.title}>שדרג ל-Pro</Text>
        <Text style={styles.subtitle}>צלם ללא הגבלה, ייצא ב-PDF, ללא סימן מים</Text>
      </View>

      {/* Tier cards */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tiersRow}
      >
        {TIERS.map(tier => (
          <View
            key={tier.id}
            style={[styles.card, tier.highlight && styles.cardHL]}
          >
            {tier.badge && (
              <View style={[styles.badge, tier.highlight ? styles.badgeHL : styles.badgeSavings]}>
                <Text style={styles.badgeText}>{tier.badge}</Text>
              </View>
            )}

            <Text style={[styles.tierName, tier.highlight && styles.tierNameHL]}>
              {tier.name}
            </Text>
            <Text style={[styles.price, tier.highlight && styles.priceHL]}>
              {tier.price}
            </Text>
            <Text style={styles.period}>{tier.period}</Text>

            <View style={styles.featureList}>
              {tier.features.map(f => (
                <View key={f} style={styles.featureRow}>
                  <Text style={[styles.check, tier.highlight && styles.checkHL]}>✓</Text>
                  <Text style={styles.featureText}>{f}</Text>
                </View>
              ))}
            </View>

            {tier.cta ? (
              <Pressable
                style={({ pressed }) => [
                  styles.ctaBtn,
                  tier.highlight && styles.ctaBtnHL,
                  styles.ctaBtnComingSoon,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => handlePurchase(tier.id)}
                accessibilityRole="button"
                accessibilityLabel={`${tier.name} — בקרוב`}
                accessibilityHint="המסלולים בפיתוח, לא ניתן לרכוש כרגע"
              >
                <Text style={[
                  styles.comingSoonLabel,
                  tier.highlight ? styles.comingSoonLabelHL : styles.comingSoonLabelDim,
                ]}>בקרוב</Text>
                <Text style={[styles.ctaText, tier.highlight && styles.ctaTextHL]}>
                  {tier.cta}
                </Text>
              </Pressable>
            ) : (
              <View style={styles.currentPlan}>
                <Text style={styles.currentPlanText}>התוכנית הנוכחית שלך</Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Bottom actions */}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.restoreBtn, pressed && { opacity: 0.7 }]}
          onPress={handleRestore}
        >
          <Text style={styles.restoreBtnText}>שחזר רכישות</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.7 }]}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.dismissBtnText}>לא עכשיו</Text>
        </Pressable>

        <Text style={styles.legal}>
          הרכישה תתבצע דרך חשבון Apple/Google שלך.{'\n'}
          ניתן לבטל בכל עת בהגדרות.
        </Text>
      </View>

    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  const PRO = colors.pro;
  const PRO_LIGHT = colors.proLight;

  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.bgPage,
    },

    // ── Header ──────────────────────────────────────────────────────────────────
    header: {
      alignItems: 'center',
      paddingTop: 28,
      paddingBottom: 20,
      paddingHorizontal: 24,
      gap: 8,
    },
    crown: { fontSize: 44 },
    title: {
      fontSize: 26,
      fontWeight: '800',
      color: colors.inkDark,
      writingDirection: 'rtl',
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: 14,
      color: colors.inkLight,
      textAlign: 'center',
      writingDirection: 'rtl',
      lineHeight: 20,
    },

    // ── Tier cards ───────────────────────────────────────────────────────────────
    tiersRow: {
      gap: 12,
      paddingHorizontal: 20,
      paddingBottom: 8,
      alignItems: 'flex-start',
    },
    card: {
      width: 200,
      backgroundColor: colors.bgSurface,
      borderRadius: radius.lg,
      borderWidth: 1.5,
      borderColor: colors.border,
      padding: 20,
      alignItems: 'center',
      gap: 4,
      ...shadow.card,
    },
    cardHL: {
      backgroundColor: PRO_LIGHT,
      borderColor: PRO,
      borderWidth: 2,
    },

    // Badge
    badge: {
      position: 'absolute',
      top: -13,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    badgeHL: { backgroundColor: PRO },
    badgeSavings: { backgroundColor: colors.success },
    badgeText: {
      color: '#fff',
      fontSize: 11,
      fontWeight: '700',
      writingDirection: 'rtl',
    },

    // Tier name / price
    tierName: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.inkMid,
      writingDirection: 'rtl',
      marginTop: 10,
      marginBottom: 4,
    },
    tierNameHL: { color: PRO },
    price: {
      fontSize: 32,
      fontWeight: '800',
      color: colors.inkDark,
      letterSpacing: -1,
    },
    priceHL: { color: PRO },
    period: {
      fontSize: 13,
      color: colors.inkFaint,
      writingDirection: 'rtl',
      marginBottom: 12,
    },

    // Features
    featureList: { width: '100%', gap: 8, marginBottom: 16 },
    featureRow: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 8 },
    check: {
      fontSize: 13,
      color: colors.success,
      fontWeight: '700',
      lineHeight: 18,
      width: 16,
      textAlign: 'center',
    },
    checkHL: { color: PRO },
    featureText: {
      fontSize: 13,
      color: colors.inkMid,
      writingDirection: 'rtl',
      flex: 1,
      textAlign: 'right',
      lineHeight: 18,
    },

    // CTA button
    ctaBtn: {
      width: '100%',
      backgroundColor: colors.border,
      borderRadius: radius.md,
      paddingVertical: 13,
      alignItems: 'center',
      gap: 2,
    },
    ctaBtnHL: { backgroundColor: PRO },
    ctaBtnComingSoon: {
      // Slight visual de-emphasis to signal "not yet available"
      opacity: 0.85,
    },
    ctaText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.inkLight,
      writingDirection: 'rtl',
    },
    ctaTextHL: { color: '#fff' },
    comingSoonLabel: {
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.4,
      marginBottom: 2,
    },
    comingSoonLabelHL: { color: 'rgba(255,255,255,0.95)' },
    comingSoonLabelDim: { color: colors.inkFaint },
    currentPlan: {
      width: '100%',
      borderRadius: radius.md,
      paddingVertical: 13,
      alignItems: 'center',
      backgroundColor: colors.bgPage,
      borderWidth: 1,
      borderColor: colors.borderFaint,
    },
    currentPlanText: {
      fontSize: 13,
      color: colors.inkFaint,
      writingDirection: 'rtl',
    },

    // ── Footer ───────────────────────────────────────────────────────────────────
    footer: {
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 16,
      alignItems: 'center',
      gap: 4,
    },
    restoreBtn: { paddingVertical: 10, paddingHorizontal: 24 },
    restoreBtnText: {
      fontSize: 14,
      color: colors.accent,
      fontWeight: '600',
      writingDirection: 'rtl',
    },
    dismissBtn: { paddingVertical: 10, paddingHorizontal: 24 },
    dismissBtnText: {
      fontSize: 15,
      color: colors.inkLight,
      writingDirection: 'rtl',
    },
    legal: {
      fontSize: 10,
      color: colors.inkFaint,
      textAlign: 'center',
      writingDirection: 'rtl',
      lineHeight: 15,
      marginTop: 4,
      opacity: 0.7,
    },
  });
}
