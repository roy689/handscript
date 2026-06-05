import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fonts, radius } from '../src/theme';
import { useTheme } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { auth } from '../src/services/firebase';
import { acceptTerms } from '../src/services/auth';

export const TERMS_VERSION = '1.0';
export const TERMS_STORAGE_KEY = '@hs_terms_accepted_v1';

type Props = NativeStackScreenProps<RootStackParamList, 'TermsAcceptance'>;

const DATA_POINTS = [
  {
    icon: '✍️',
    title: 'שמירת כתב יד',
    body: 'תמונות הדגימות שלך נשמרות בשרתים מאובטחים של Google Firebase ומשמשות אך ורק ליצירת הטקסט בכתב ידך האישי.',
  },
  {
    icon: '🔍',
    title: 'עיבוד תמונה',
    body: 'אנו משתמשים ב-Google Cloud Vision לזיהוי ועיבוד הדגימות. התמונות אינן נשמרות על ידי Google לאחר העיבוד.',
  },
  {
    icon: '🔒',
    title: 'פרטיות ואבטחה',
    body: 'הנתונים שלך מוצפנים ומאובטחים. אנו לא מוכרים, לא משתפים ולא מעבירים את המידע שלך לצדדים שלישיים לשום מטרה מסחרית.',
  },
  {
    icon: '🗑️',
    title: 'מחיקת נתונים',
    body: 'תוכל למחוק את כל הנתונים שלך בכל עת מתוך הגדרות החשבון. המחיקה מיידית ומלאה — כולל כתב היד וכל הקבצים.',
  },
  {
    icon: '👤',
    title: 'גיל מינימלי',
    body: 'השימוש באפליקציה מותר מגיל 13 ומעלה. על ידי אישור תנאים אלו אתה מאשר שאתה עומד בדרישת הגיל.',
  },
];

export default function TermsAcceptanceScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [checked,   setChecked]   = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.spring(fadeAnim, {
      toValue: 1, tension: 55, friction: 9, useNativeDriver: true,
    }).start();
  }, []);

  async function handleAccept() {
    if (!checked || accepting) return;
    impactMedium();
    setError(null);
    setAccepting(true);
    try {
      // 1. Save to AsyncStorage (fast, local, checked on every launch)
      await AsyncStorage.setItem(TERMS_STORAGE_KEY, JSON.stringify({
        version:    TERMS_VERSION,
        acceptedAt: new Date().toISOString(),
      }));

      // 2. Save to backend / Firestore (for legal record)
      //    Non-blocking — if it fails the local copy is enough to proceed.
      acceptTerms(TERMS_VERSION).catch(() => {});

      // 3. Navigate based on session state and tutorial history.
      //    • Logged-in user  → Tutorial (first time) or MainTabs (returning)
      //    • New device      → Tutorial first so the user learns the app,
      //                        then Tutorial navigates to Onboarding when done.
      //    • Returning guest → Onboarding directly (tutorial already seen).
      const user = auth.currentUser;
      const seen = await AsyncStorage.getItem('@hs_tutorial_seen').catch(() => null);
      if (user) {
        navigation.reset({ index: 0, routes: [{ name: seen ? 'MainTabs' : 'Tutorial' }] });
      } else {
        navigation.reset({ index: 0, routes: [{ name: seen ? 'Onboarding' : 'Tutorial' }] });
      }
    } catch {
      setError('אירעה שגיאה. בדוק את החיבור ונסה שוב.');
      setAccepting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Animated.View style={[styles.root, {
        opacity:   fadeAnim,
        transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
      }]}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.logo}>✍️ HandScript</Text>
          <Text style={styles.headline}>לפני שנתחיל</Text>
          <Text style={styles.sub}>
            אנא קרא את תנאי השימוש ומדיניות הפרטיות שלנו.
            {'\n'}אנו מעריכים את שקיפות המידע.
          </Text>
        </View>

        {/* ── Scrollable body ── */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >

          {DATA_POINTS.map((pt, i) => (
            <View key={i} style={styles.point}>
              <Text style={styles.pointIcon}>{pt.icon}</Text>
              <View style={styles.pointText}>
                <Text style={styles.pointTitle}>{pt.title}</Text>
                <Text style={styles.pointBody}>{pt.body}</Text>
              </View>
            </View>
          ))}

          {/* ── Links ── */}
          <View style={styles.links}>
            <Pressable
              hitSlop={10}
              onPress={() => { impactLight(); navigation.navigate('TermsOfService'); }}
              accessibilityRole="link"
            >
              <Text style={styles.linkText}>תנאי שימוש מלאים</Text>
            </Pressable>
            <Text style={styles.linkSep}>·</Text>
            <Pressable
              hitSlop={10}
              onPress={() => { impactLight(); navigation.navigate('PrivacyPolicy'); }}
              accessibilityRole="link"
            >
              <Text style={styles.linkText}>מדיניות פרטיות</Text>
            </Pressable>
          </View>

        </ScrollView>

        {/* ── Footer ── */}
        <View style={styles.footer}>

          {/* Checkbox */}
          <Pressable
            style={styles.checkRow}
            onPress={() => { impactLight(); setChecked(v => !v); }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
          >
            <View style={[styles.checkbox, checked && styles.checkboxOn]}>
              {checked && <Text style={styles.checkMark}>✓</Text>}
            </View>
            <Text style={styles.checkLabel}>
              קראתי ואני מסכים לתנאי השימוש ולמדיניות הפרטיות
            </Text>
          </Pressable>

          {/* Error */}
          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Accept button */}
          <Pressable
            style={({ pressed }) => [
              styles.btn,
              (!checked || accepting) && styles.btnDisabled,
              checked && !accepting && pressed && { opacity: 0.88, transform: [{ scale: 0.97 }] },
            ]}
            onPress={handleAccept}
            disabled={!checked || accepting}
            accessibilityRole="button"
            accessibilityLabel={accepting ? 'מאשר...' : 'אישור וכניסה לאפליקציה'}
            accessibilityState={{ disabled: !checked || accepting }}
          >
            <Text style={styles.btnText}>
              {accepting ? 'מאשר...' : 'אישור וכניסה לאפליקציה'}
            </Text>
          </Pressable>

        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

function getStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    safe: {
      flex:            1,
      backgroundColor: colors.bgPage,
    },
    root: {
      flex: 1,
    },

    // ── Header ──
    header: {
      backgroundColor: colors.bgDark,
      paddingHorizontal: 28,
      paddingTop:        28,
      paddingBottom:     32,
      alignItems:        'center',
    },
    logo: {
      fontSize:     20,
      fontFamily:   fonts.extraBold,
      color:        '#FFFFFF',
      marginBottom: 16,
      letterSpacing: -0.3,
    },
    headline: {
      fontSize:     28,
      fontFamily:   fonts.extraBold,
      color:        '#FFFFFF',
      textAlign:    'center',
      letterSpacing: -0.5,
      marginBottom:  8,
    },
    sub: {
      fontSize:   14,
      fontFamily: fonts.regular,
      color:      'rgba(255,255,255,0.55)',
      textAlign:  'center',
      lineHeight: 21,
    },

    // ── Scroll ──
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop:        24,
      paddingBottom:     12,
      gap:               16,
    },

    point: {
      flexDirection:    'row',
      backgroundColor:  colors.bgSurface,
      borderRadius:     radius.md,
      borderWidth:      1,
      borderColor:      colors.border,
      padding:          16,
      gap:              14,
      alignItems:       'flex-start',
    },
    pointIcon: {
      fontSize:   22,
      marginTop:   1,
    },
    pointText: {
      flex: 1,
      gap:   4,
    },
    pointTitle: {
      fontSize:   14,
      fontFamily: fonts.bold,
      color:      colors.inkDark,
      writingDirection: 'rtl',
    },
    pointBody: {
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      colors.inkMid,
      lineHeight: 19,
      writingDirection: 'rtl',
    },

    links: {
      flexDirection:  'row',
      justifyContent: 'center',
      alignItems:     'center',
      gap:             6,
      paddingVertical: 4,
    },
    linkText: {
      fontSize:            13,
      fontFamily:          fonts.semiBold,
      color:               colors.accent,
      textDecorationLine:  'underline',
    },
    linkSep: {
      fontSize:   13,
      color:      colors.inkFaint,
    },

    // ── Footer ──
    footer: {
      paddingHorizontal: 20,
      paddingTop:        16,
      paddingBottom:     8,
      borderTopWidth:    1,
      borderTopColor:    colors.border,
      backgroundColor:   colors.bgSurface,
      gap:               14,
    },

    checkRow: {
      flexDirection: 'row',
      alignItems:    'flex-start',
      gap:           12,
    },
    checkbox: {
      width:           22,
      height:          22,
      borderRadius:    6,
      borderWidth:     2,
      borderColor:     colors.border,
      backgroundColor: colors.bgInput,
      alignItems:      'center',
      justifyContent:  'center',
      marginTop:        1,
      flexShrink:       0,
    },
    checkboxOn: {
      backgroundColor: colors.accent,
      borderColor:     colors.accent,
    },
    checkMark: {
      fontSize:   13,
      color:      '#FFFFFF',
      fontFamily: fonts.bold,
    },
    checkLabel: {
      flex:       1,
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      colors.inkMid,
      lineHeight: 19,
      writingDirection: 'rtl',
    },

    errorBanner: {
      backgroundColor:   'rgba(185,28,28,0.12)',
      borderRadius:      radius.sm,
      paddingHorizontal: 14,
      paddingVertical:   10,
      borderWidth:       1,
      borderColor:       'rgba(185,28,28,0.3)',
    },
    errorText: {
      fontSize:   13,
      color:      colors.danger,
      textAlign:  'center',
      fontFamily: fonts.regular,
    },

    btn: {
      backgroundColor: colors.accent,
      borderRadius:    radius.md,
      paddingVertical: 17,
      alignItems:      'center',
      shadowColor:     colors.accent,
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.30,
      shadowRadius:    10,
      elevation:       5,
    },
    btnDisabled: {
      opacity:       0.4,
      shadowOpacity: 0,
      elevation:     0,
    },
    btnText: {
      fontSize:         16,
      fontFamily:       fonts.bold,
      color:            '#FFFFFF',
      writingDirection: 'rtl',
      letterSpacing:    0.2,
    },
  });
}
