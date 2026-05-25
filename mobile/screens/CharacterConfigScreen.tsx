import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme } from '../src/contexts/ThemeContext';
import { impactLight } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterConfig'>;

export default function CharacterConfigScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const { character } = route.params;
  const [count, setCount] = useState(3);

  function dec() { if (count > 1)  { impactLight(); setCount(c => c - 1); } }
  function inc() { if (count < 10) { impactLight(); setCount(c => c + 1); } }

  const hint =
    count === 1 ? '💡 מומלץ לפחות 3 דגימות לתוצאה ריאליסטית' :
    count <= 5  ? '✓ כמות אידיאלית לוריאציה טבעית'           :
                  '⚡ מצוין — יותר דגימות = כתב ידי יותר';

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.glyph}>{character}</Text>
        <Text style={styles.title}>כתוב את התו הזה</Text>

        <Text style={styles.question}>כמה דגימות תרצה לספק?</Text>

        <View style={styles.counter}>
          <Pressable
            style={({ pressed }) => [
              styles.counterBtn,
              count <= 1 && styles.counterBtnDisabled,
              pressed && count > 1 && { opacity: 0.7 },
            ]}
            onPress={dec}
            disabled={count <= 1}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="הקטן מספר דגימות"
            accessibilityHint={`כרגע ${count} דגימות. לחץ להקטין באחת. מינימום 1`}
            accessibilityState={{ disabled: count <= 1 }}
          >
            <Text style={[styles.counterBtnText, count <= 1 && styles.counterBtnTextDisabled]}>−</Text>
          </Pressable>

          <Text style={styles.counterVal} accessibilityLabel={`${count} דגימות נבחרו`}>
            {count}
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.counterBtn,
              count >= 10 && styles.counterBtnDisabled,
              pressed && count < 10 && { opacity: 0.7 },
            ]}
            onPress={inc}
            disabled={count >= 10}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="הגדל מספר דגימות"
            accessibilityHint={`כרגע ${count} דגימות. לחץ להגדיל באחת. מקסימום 10`}
            accessibilityState={{ disabled: count >= 10 }}
          >
            <Text style={[styles.counterBtnText, count >= 10 && styles.counterBtnTextDisabled]}>+</Text>
          </Pressable>
        </View>

        <Text style={styles.hint}>{hint}</Text>

        <View style={styles.paperTip}>
          <Text style={styles.paperTipText}>
            📄 כתוב על דף לבן חלק ללא שורות — הסרגל נספג כרקע ומקשה על הזיהוי
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.88, transform: [{ scale: 0.98 }] }]}
          onPress={() => { impactLight(); navigation.navigate('CharacterCapture', { character, totalSamples: count }); }}
          accessibilityRole="button"
          accessibilityLabel={`התחל צילום ${count} דגימות של התו ${character}`}
          accessibilityHint="עובר למסך צילום או ציור של התו"
        >
          <Text style={styles.startBtnText}>התחל צילום</Text>
        </Pressable>
      </View>
    </View>
  );
}

function getStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:   { flex: 1, backgroundColor: colors.bgPage },
    body:   { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },

    glyph: {
      fontSize: 110,
      fontFamily: fonts.extraBold,
      color: colors.accent,
      lineHeight: 130,
      marginBottom: 8,
    },
    title:    { fontSize: 20, fontFamily: fonts.bold,    color: colors.inkDark, marginBottom: 36 },
    question: { fontSize: 16, fontFamily: fonts.regular, color: colors.inkMid,  marginBottom: 20 },

    counter: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
    counterBtn: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadow.btn,
    },
    counterBtnDisabled: {
      backgroundColor: colors.border,
      shadowOpacity: 0,
      elevation: 0,
    },
    counterBtnText: { fontSize: 30, color: '#fff', fontFamily: fonts.bold, lineHeight: 34 },
    counterBtnTextDisabled: { color: colors.inkFaint },
    counterVal: {
      fontSize: 48,
      fontFamily: fonts.extraBold,
      color: colors.inkDark,
      marginHorizontal: 36,
      minWidth: 52,
      textAlign: 'center',
    },

    hint: {
      fontSize: 14,
      fontFamily: fonts.regular,
      color: colors.inkMid,
      textAlign: 'center',
      lineHeight: 20,
    },

    paperTip: {
      marginTop: 20,
      backgroundColor: colors.warningLight,
      borderRadius: radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.warning,
      alignSelf: 'stretch',
    },
    paperTipText: {
      fontSize: 13,
      fontFamily: fonts.regular,
      color: colors.inkMid,
      textAlign: 'center',
      lineHeight: 20,
    },

    footer:    { padding: 16 },
    startBtn:  {
      backgroundColor: colors.accent,
      paddingVertical: 18,
      borderRadius: radius.md,
      alignItems: 'center',
      ...shadow.btn,
    },
    startBtnText: { fontSize: 18, fontFamily: fonts.bold, color: '#fff' },
  });
}
