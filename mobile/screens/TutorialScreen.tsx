/**
 * TutorialScreen — מסך הדרכה לכניסה ראשונה בלבד
 *
 * מוצג פעם אחת אחרי הרישום/כניסה הראשונית.
 * כשהמשתמש סיים או דילג — נשמר @hs_tutorial_seen ב-AsyncStorage
 * ומשם ואילך לא יוצג יותר.
 */

import React, { useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { auth } from '../src/services/firebase';
import { fonts } from '../src/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Tutorial'>;

const { width } = Dimensions.get('window');

// ── תוכן השקפים ──────────────────────────────────────────────────────────────

const SLIDES = [
  {
    key:      '1',
    emoji:    '✍️',
    bg:       '#0D1117',
    accent:   '#E8C98A',
    title:    'ברוך הבא ל-HandScript!',
    body:     'האפליקציה שהופכת את כתב היד הייחודי שלך לפונט דיגיטלי אישי.',
    tip:      null,
  },
  {
    key:      '2',
    emoji:    '📷',
    bg:       '#0A1628',
    accent:   '#7EC8E3',
    title:    'שלב 1 — צלם או צייר את האותיות',
    body:     'לך למסך "מאגר" ולחץ על כל אות. תוכל לצלם אותה בכתב ידך, או לצייר אותה ישירות עם האצבע במסך. ככל שתוסיף יותר דגימות לכל אות — כך הפונט יהיה טבעי ואמין יותר.',
    tip:      '💡 מספיק 3 דגימות לאות כדי להתחיל',
  },
  {
    key:      '3',
    emoji:    '🗂️',
    bg:       '#15102A',
    accent:   '#C4A8E3',
    title:    'שלב 2 — בנה את המאגר',
    body:     'ככל שהסרגל בראש הדף מתמלא, כך המאגר שלך שלם יותר. אותיות מוכנות מסומנות בעיגול מלא.',
    tip:      '💡 אפשר להתחיל עם עברית בלבד ולהוסיף אנגלית מאוחר יותר',
  },
  {
    key:      '4',
    emoji:    '✏️',
    bg:       '#0A1E10',
    accent:   '#8AE89A',
    title:    'שלב 3 — כתוב, קבל כתב יד',
    body:     'לך לעורך הטקסט, הקלד כל מה שתרצה, ולחץ "המר לכתב יד". בתוך שניות — הטקסט שלך יופיע בכתב ידך הייחודי.',
    tip:      '🪄 אפשר לשנות גובה, רווח, ועוד בהגדרות הסגנון',
  },
  {
    key:      '5',
    emoji:    '🎉',
    bg:       '#1A0D0D',
    accent:   '#E8A08A',
    title:    'מוכן? יאללה מתחילים!',
    body:     'לך למסך המאגר ותתחיל לצלם את האותיות שלך. בהצלחה!',
    tip:      null,
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

async function markTutorialSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem('@hs_tutorial_seen', '1');
  } catch { /* best-effort */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TutorialScreen({ navigation }: Props) {
  const [index, setIndex] = useState(0);

  // Fade animation between slides
  const fadeAnim  = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current; // translateX for button enter

  const slide = SLIDES[index];
  const isLast = index === SLIDES.length - 1;

  // ── Navigate to a different slide with a crossfade ────────────────────────
  const goTo = (next: number) => {
    Animated.timing(fadeAnim, {
      toValue:         0,
      duration:        130,
      useNativeDriver: true,
    }).start(() => {
      setIndex(next);
      Animated.timing(fadeAnim, {
        toValue:         1,
        duration:        220,
        useNativeDriver: true,
      }).start();
    });
  };

  // ── Finish: save flag + navigate away (no back) ───────────────────────────
  // If the user is already logged in (returning user) → MainTabs.
  // If the user is not logged in (new user flow: Terms → Tutorial → Onboarding)
  // → Onboarding so they can create an account.
  const finish = async () => {
    await markTutorialSeen();
    if (auth.currentUser) {
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    } else {
      navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: slide.bg }]}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>

        {/* ── Skip (top-left, RTL → physical right) ──────────────────────── */}
        <View style={styles.topBar}>
          {!isLast ? (
            <Pressable
              hitSlop={16}
              onPress={finish}
              accessibilityRole="button"
              accessibilityLabel="דלג על ההדרכה"
            >
              <Text style={[styles.skipText, { color: slide.accent + 'AA' }]}>דלג</Text>
            </Pressable>
          ) : (
            <View />
          )}

          {/* Step counter */}
          <Text style={[styles.stepCounter, { color: slide.accent + '66' }]}>
            {index + 1} / {SLIDES.length}
          </Text>
        </View>

        {/* ── Slide content ────────────────────────────────────────────────── */}
        <Animated.View style={[styles.content, { opacity: fadeAnim }]}>

          {/* Big illustration emoji */}
          <View style={[styles.emojiWrap, { borderColor: slide.accent + '22', backgroundColor: slide.accent + '11' }]}>
            <Text style={styles.emoji}>{slide.emoji}</Text>
          </View>

          {/* Title */}
          <Text style={[styles.title, { color: slide.accent }]}>{slide.title}</Text>

          {/* Body */}
          <Text style={styles.body}>{slide.body}</Text>

          {/* Tip chip */}
          {slide.tip && (
            <View style={[styles.tipChip, { borderColor: slide.accent + '44', backgroundColor: slide.accent + '14' }]}>
              <Text style={[styles.tipText, { color: slide.accent }]}>{slide.tip}</Text>
            </View>
          )}

        </Animated.View>

        {/* ── Dot indicators ───────────────────────────────────────────────── */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <Pressable
              key={i}
              hitSlop={8}
              onPress={() => goTo(i)}
              accessibilityRole="button"
              accessibilityLabel={`שקף ${i + 1}`}
            >
              <Animated.View
                style={[
                  styles.dot,
                  i === index
                    ? [styles.dotActive,   { backgroundColor: slide.accent }]
                    : [styles.dotInactive, { backgroundColor: slide.accent + '33' }],
                ]}
              />
            </Pressable>
          ))}
        </View>

        {/* ── Primary action button ────────────────────────────────────────── */}
        <Pressable
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: slide.accent },
            pressed && styles.btnPressed,
          ]}
          onPress={isLast ? finish : () => goTo(index + 1)}
          accessibilityRole="button"
          accessibilityLabel={isLast ? 'התחל להשתמש באפליקציה' : 'השקף הבא'}
        >
          <Text style={styles.btnText}>{isLast ? '🚀  בוא נתחיל!' : 'הבא  ←'}</Text>
        </Pressable>

      </SafeAreaView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({

  root: { flex: 1 },

  safe: {
    flex:              1,
    alignItems:        'center',
    paddingHorizontal: 28,
  },

  // ── Top bar ────────────────────────────────────────────────────────────────
  topBar: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    width:          '100%',
    paddingTop:     8,
    paddingBottom:  4,
  },
  skipText: {
    fontSize:   15,
    fontFamily: fonts.semiBold ?? fonts.bold,
  },
  stepCounter: {
    fontSize:   13,
    fontFamily: fonts.regular,
  },

  // ── Slide content ──────────────────────────────────────────────────────────
  content: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            20,
    paddingBottom:  16,
    width:          '100%',
  },

  emojiWrap: {
    width:        140,
    height:       140,
    borderRadius: 70,
    borderWidth:  2,
    alignItems:   'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emoji: {
    fontSize: 64,
    textAlign: 'center',
  },

  title: {
    fontSize:      24,
    fontFamily:    fonts.extraBold,
    textAlign:     'center',
    letterSpacing: -0.4,
    lineHeight:    32,
  },

  body: {
    fontSize:    16,
    fontFamily:  fonts.regular,
    color:       'rgba(255,255,255,0.72)',
    textAlign:   'center',
    lineHeight:  26,
    paddingHorizontal: 4,
  },

  tipChip: {
    borderWidth:       1,
    borderRadius:      12,
    paddingHorizontal: 16,
    paddingVertical:   10,
    marginTop:         4,
  },
  tipText: {
    fontSize:   14,
    fontFamily: fonts.semiBold ?? fonts.bold,
    textAlign:  'center',
  },

  // ── Dots ───────────────────────────────────────────────────────────────────
  dots: {
    flexDirection: 'row',
    gap:           8,
    marginBottom:  20,
  },
  dot: {
    height:       8,
    borderRadius: 4,
  },
  dotActive:   { width: 28 },
  dotInactive: { width: 8 },

  // ── Button ─────────────────────────────────────────────────────────────────
  btn: {
    width:           width - 56,
    paddingVertical: 17,
    borderRadius:    16,
    alignItems:      'center',
    marginBottom:    12,
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 6 },
    shadowOpacity:   0.35,
    shadowRadius:    14,
    elevation:       7,
  },
  btnPressed: {
    opacity:   0.85,
    transform: [{ scale: 0.97 }],
  },
  btnText: {
    fontSize:   17,
    fontFamily: fonts.bold,
    color:      '#111111',
  },

});
