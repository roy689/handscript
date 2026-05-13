import React, { useState, useCallback, useMemo } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getCurrentUserId }        from '../src/services/auth';
import { checkCanConvert, incrementUsage } from '../src/services/subscription';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import LoadingOverlay        from '../src/components/LoadingOverlay';
import HandwritingOverlay   from '../src/components/HandwritingOverlay';
import { impactMedium } from '../src/utils/haptics';
import { fetchJSON, withRetry, toErrorMessage, OfflineError } from '../src/utils/api';
import { BACKEND_URL } from '../src/config';

type Props = NativeStackScreenProps<RootStackParamList, 'Editor'>;
type InkColor   = 'black' | 'blue' | 'red';
type PaperStyle = 'lines' | 'grid' | 'blank';

// Strip invisible Unicode characters that have no glyph in any bank:
// zero-width spaces, directional marks, bidi embeddings, BOM, soft hyphen
const INVISIBLE_RE = /[­​‌‍‎‏‪‫‬‭‮﻿]/g;
function sanitize(input: string): string {
  return input.replace(INVISIBLE_RE, '');
}

export default function EditorScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [text,          setText]          = useState('');
  const [loading,       setLoading]       = useState(false);
  const [loadingMsg,    setLoadingMsg]    = useState('');
  const [converting,    setConverting]    = useState(false); // full-screen handwriting overlay
  const [error,         setError]         = useState<string | null>(null);

  // Style settings — paper & ink live in PreviewScreen UI,
  // but we carry them through navigation so Preview pre-selects them.
  const [paperStyle,    setPaperStyle]    = useState<PaperStyle>('lines');
  const [inkColor,      setInkColor]      = useState<InkColor>('black');

  // Default style values passed to Preview (user adjusts them there via sliders)
  const textSize      = 85;
  const letterSpacing = 4;
  const wordSpacing   = 35;
  const lineJitter    = 3;

  const charCount  = text.length;
  const canConvert = text.trim().length > 0 && !loading;

  const handleConvert = useCallback(async () => {
    if (!canConvert) return;
    setError(null);
    setLoading(true);

    const userId = getCurrentUserId() ?? 'anonymous';

    try {
      setLoadingMsg('בודק הרשאות...');
      const check = await checkCanConvert(userId);
      if (!check.allowed) {
        Alert.alert(
          'מגבלת שימוש',
          check.reason,
          [
            { text: 'ביטול', style: 'cancel' },
            { text: 'שדרג עכשיו', onPress: () => navigation.navigate('Paywall') },
          ],
        );
        return;
      }

      const { auth: firebaseAuth } = await import('../src/services/firebase');
      const token = await firebaseAuth.currentUser?.getIdToken();
      const authHeaders: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};

      setLoadingMsg('מאמת תווים...');
      const vData = await withRetry(
        () => fetchJSON<{ ok: boolean; missing: string[] }>(
          `${BACKEND_URL}/validate`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body:    JSON.stringify({ text, user_id: userId }),
          },
        ),
        2,
      );
      if (!vData.ok) {
        const first = vData.missing?.[0];
        if (first) {
          Alert.alert(
            'תו חסר במאגר',
            `האות "${first}" לא קיימת במאגר שלך. רוצה לצלם אותה עכשיו?`,
            [
              { text: 'ביטול', style: 'cancel' },
              { text: 'צלם עכשיו', onPress: () => navigation.navigate('CharacterConfig', { character: first }) },
            ],
          );
        }
        return;
      }

      // Show the full-screen handwriting overlay for the heavy glyph fetch
      setConverting(true);
      setLoadingMsg('מעבד את הטקסט ומייצר כתב יד...');
      const gData = await withRetry(
        () => fetchJSON<{ glyphs: Record<string, string>; missing: string[] }>(
          `${BACKEND_URL}/glyphs`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body:    JSON.stringify({ text, user_id: userId }),
          },
        ),
        2,
      );

      await incrementUsage(userId);

      // Navigate first — the overlay unmounts with EditorScreen so no flicker
      navigation.navigate('Preview', {
        text,
        background: paperStyle,
        inkColor,
        glyphMap: gData.glyphs,
        style: {
          charHeight:     textSize,
          letterSpacing:  letterSpacing,
          wordSpacing:    wordSpacing,
          baselineJitter: lineJitter,
          slant:          0,
          inkBlobs:       0,
        },
      });

    } catch (err: unknown) {
      const msg = toErrorMessage(err);
      if (err instanceof OfflineError) {
        Alert.alert('אין חיבור לאינטרנט', msg, [{ text: 'אישור' }]);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
      setLoadingMsg('');
      setConverting(false);
    }
  }, [text, paperStyle, inkColor, canConvert, navigation]);

  return (
    <KeyboardAvoidingView
      style={styles.kav}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.safe}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.5 }]}
            onPress={() => navigation.navigate('CharacterList')}
            hitSlop={12}
          >
            <Text style={styles.backArrow}>←</Text>
          </Pressable>
          <View style={styles.headerTextBlock}>
            <Text style={styles.headerTitle}>כתוב משהו</Text>
            <Text style={styles.headerSub}>יומר לכתב היד האישי שלך</Text>
          </View>
          <View style={styles.inkDot} />
        </View>

        {/* ── Paper input ────────────────────────────────────────────────── */}
        <View style={styles.paperWrap}>
          {[0,1,2,3,4,5].map(i => (
            <View key={i} style={[styles.ruledLine, { top: 52 + i * 30 }]} pointerEvents="none" />
          ))}
          <View style={styles.marginLine} pointerEvents="none" />

          <TextInput
            style={styles.input}
            value={text}
            onChangeText={t => { setText(sanitize(t)); setError(null); }}
            placeholder={"כתוב כאן...\n\nלדוגמה: שלום, שמי ישראל"}
            placeholderTextColor={colors.inkFaint}
            multiline
            textAlign="right"
            textAlignVertical="top"
            autoCorrect={false}
            autoCapitalize="none"
          />

          <View style={styles.counterStrip}>
            <Text style={styles.counter}>{charCount}</Text>
          </View>
        </View>

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {error !== null && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={{ flex: 1 }} />

        {/* ── Convert button ──────────────────────────────────────────────── */}
        <View style={styles.actionBar}>
          <Pressable
            style={({ pressed }) => [
              styles.convertBtn,
              !canConvert && styles.convertBtnOff,
              canConvert && pressed && styles.convertBtnPressed,
            ]}
            disabled={!canConvert}
            onPress={() => { impactMedium(); handleConvert(); }}
          >
            <Text style={[styles.convertLabel, !canConvert && styles.convertLabelOff]}>
              המר לכתב יד
            </Text>
          </Pressable>
        </View>

      </SafeAreaView>

      {/* Generic overlay for quick checks (auth, validate) */}
      <LoadingOverlay
        visible={loading && !converting}
        message={loadingMsg || 'מעבד...'}
        submessage="זה עשוי לקחת כמה שניות"
      />

      {/* Full-screen animated overlay while generating handwriting */}
      <HandwritingOverlay visible={converting} />
    </KeyboardAvoidingView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    kav:  { flex: 1, backgroundColor: colors.bgPage },
    safe: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },

    // ── Header ───────────────────────────────────────────────────────────────
    header: {
      paddingVertical:  16,
      flexDirection:    'row',
      alignItems:       'center',
      justifyContent:   'space-between',
    },
    headerTextBlock: { alignItems: 'flex-end', flex: 1 },
    headerTitle: {
      fontSize:         22,
      fontFamily:       fonts.bold,
      color:            colors.inkDark,
      writingDirection: 'rtl',
    },
    headerSub: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      writingDirection: 'rtl',
      marginTop:        2,
    },
    backBtn: {
      paddingHorizontal: 4,
      paddingVertical:   4,
    },
    backArrow: {
      fontSize:   22,
      color:      colors.inkMid,
      lineHeight: 28,
    },
    inkDot: {
      width:           10,
      height:          10,
      borderRadius:    5,
      backgroundColor: colors.accent,
      opacity:         0.35,
      marginRight:     4,
    },

    // ── Paper ────────────────────────────────────────────────────────────────
    paperWrap: {
      flex:            1,
      maxHeight:       '48%',
      backgroundColor: colors.bgInput,
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     colors.border,
      overflow:        'hidden',
      ...shadow.card,
      position:        'relative',
    },
    ruledLine: {
      position:        'absolute',
      left:            0,
      right:           0,
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
    },
    marginLine: {
      position:        'absolute',
      top:             0,
      bottom:          0,
      right:           48,
      width:           StyleSheet.hairlineWidth,
      backgroundColor: 'rgba(180,90,10,0.12)',
    },
    input: {
      flex:             1,
      paddingRight:     20,
      paddingLeft:      18,
      paddingTop:       16,
      paddingBottom:    44,
      fontSize:         17,
      lineHeight:       30,
      color:            colors.inkDark,
      fontFamily:       fonts.regular,
      writingDirection: 'rtl',
      textAlign:        'right',
      zIndex:           1,
    },
    counterStrip: {
      position:          'absolute',
      bottom:            0,
      left:              0,
      right:             0,
      paddingHorizontal: 14,
      paddingVertical:   8,
      backgroundColor:   colors.bgInput,
      borderTopWidth:    StyleSheet.hairlineWidth,
      borderTopColor:    colors.borderFaint,
      alignItems:        'flex-start',
    },
    counter:     { fontSize: 11, color: colors.inkFaint, fontVariant: ['tabular-nums'], fontFamily: fonts.regular },

    // ── Error ─────────────────────────────────────────────────────────────────
    errorBanner: {
      marginTop:         10,
      backgroundColor:   colors.dangerLight,
      borderWidth:       1,
      borderColor:       colors.danger,
      borderRadius:      radius.sm,
      paddingHorizontal: 14,
      paddingVertical:   10,
    },
    errorText: {
      fontSize:         13,
      color:            colors.danger,
      textAlign:        'right',
      writingDirection: 'rtl',
      fontFamily:       fonts.regular,
    },

    // ── Action bar ────────────────────────────────────────────────────────────
    actionBar: {
      paddingTop:    12,
      paddingBottom: 16,
    },
    convertBtn: {
      backgroundColor: colors.accent,
      borderRadius:    radius.md,
      paddingVertical: 18,
      alignItems:      'center',
      ...shadow.btn,
    },
    convertBtnOff: {
      backgroundColor: colors.border,
      shadowOpacity:   0,
      elevation:       0,
    },
    convertBtnPressed: {
      transform: [{ scale: 0.97 }],
      opacity:   0.9,
    },
    convertLabel: {
      fontSize:      17,
      fontFamily:    fonts.bold,
      color:         '#FFFFFF',
      writingDirection: 'rtl',
      letterSpacing: 0.3,
    },
    convertLabelOff: { color: colors.inkLight },
  });
}
