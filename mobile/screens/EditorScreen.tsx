import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { showAlert } from '../src/utils/alert';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getCurrentUserId }        from '../src/services/auth';
import { checkCanConvert, incrementUsage } from '../src/services/subscription';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import LoadingOverlay        from '../src/components/LoadingOverlay';
import HandwritingOverlay   from '../src/components/HandwritingOverlay';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { fetchJSON, withRetry, toErrorMessage, OfflineError } from '../src/utils/api';
import { BACKEND_URL, MAX_TEXT_LEN, TEXT_WARN_THRESHOLD } from '../src/config';
import NetInfo from '@react-native-community/netinfo';
import { savePendingConversion, getPendingConversion, clearPendingConversion } from '../src/utils/offlineQueue';
import { saveDraft, loadDraft, clearDraft } from '../src/utils/draftStorage';
import { logError } from '../src/utils/telemetry';

type Props = NativeStackScreenProps<RootStackParamList, 'Editor'>;
type InkColor   = 'black' | 'blue' | 'red';
type PaperStyle = 'lines' | 'grid' | 'blank';

// Shared sanitize utility — strips invisible Unicode chars that have no glyph in any bank.
import { sanitizeText as sanitize } from '../src/utils/sanitize';

// MAX_TEXT_LEN and TEXT_WARN_THRESHOLD imported from config (shared with PreviewScreen)

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
  const [paperStyle] = useState<PaperStyle>('lines');
  const [inkColor]   = useState<InkColor>('black');

  const [lastConvertTime, setLastConvertTime] = useState(0);
  const MIN_INTERVAL_MS = 2000;

  // ── Keyboard height tracking ───────────────────────────────────────────────
  // KeyboardAvoidingView conflicts with SafeAreaView from react-native-safe-area-context.
  // Instead, we listen directly to keyboard events and apply paddingBottom to
  // the root View so the layout compresses naturally, keeping the button visible.
  const insets   = useSafeAreaInsets();
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvt, e => setKbHeight(e.endCoordinates.height));
    const s2 = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  // Default style values passed to Preview (user adjusts them there via sliders)
  const textSize      = 85;
  const letterSpacing = 4;
  const wordSpacing   = 35;
  const lineJitter    = 3;

  // ── Draft auto-restore: load saved text on mount ───────────────────────────
  // Runs once when the screen mounts. If a non-empty draft exists from a
  // previous session (crash, force-quit, server error), restore it silently
  // so the user can continue where they left off.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const draft = await loadDraft();
      if (mounted && draft && draft.text && !text) {
        setText(draft.text);
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Draft auto-save: debounced persist while typing ────────────────────────
  // Saves the current text 800ms after the last keystroke. Prevents storage
  // thrash on fast typing while still capturing the latest state before any
  // crash / navigation away.
  useEffect(() => {
    const handle = setTimeout(() => {
      // Fire-and-forget — saveDraft swallows its own errors.
      void saveDraft(text);
    }, 800);
    return () => clearTimeout(handle);
  }, [text]);

  // ── Offline queue: restore pending conversion when connectivity returns ──────
  useEffect(() => {
    let mounted = true;
    let alerted = false;
    const unsub = NetInfo.addEventListener(async state => {
      if (!mounted || !state.isConnected || alerted) return;
      const pending = await getPendingConversion();
      if (!mounted || !pending) return;
      alerted = true;
      showAlert(
        'החיבור חזר',
        'נמצאה המרה שנשמרה בזמן הניתוק. לשחזר את הטקסט?',
        [
          {
            text: 'מחק',
            style: 'destructive',
            onPress: async () => { await clearPendingConversion(); alerted = false; },
          },
          {
            text: 'שחזר',
            onPress: async () => {
              if (mounted) setText(pending.text);
              await clearPendingConversion();
              alerted = false;
            },
          },
        ],
      );
    });
    return () => { mounted = false; unsub(); };
  }, []);

  const charCount  = text.length;
  const canConvert = text.trim().length > 0 && !loading;

  const handleConvert = useCallback(async () => {
    const now = Date.now();
    if (now - lastConvertTime < MIN_INTERVAL_MS) {
      setError(`אנא חכה ${Math.ceil((MIN_INTERVAL_MS - (now - lastConvertTime)) / 1000)} שניות`);
      return;
    }
    setLastConvertTime(now);

    // Validation #1: Text validation
    // sanitize() strips invisible Unicode control chars (bidi marks, ZWJ, BOM,
    // directional overrides) via the INVISIBLE_RE regex defined at module level.
    // The same function already runs on every keystroke in onChangeText, so this
    // is a safety net for text arriving via other means (e.g. draft restore).
    const sanitizedText = sanitize(text.trim());
    if (sanitizedText.length === 0) {
      setError('כתוב משהו קודם');
      return;
    }
    if (sanitizedText.length > MAX_TEXT_LEN) {
      setError(`הטקסט ארוך מדי. המגבלה היא ${MAX_TEXT_LEN} תווים.`);
      return;
    }

    // Validation #2: User ID validation
    const userId = getCurrentUserId();
    if (!userId) {
      setError('עליך להתחבר תחילה');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      setLoadingMsg('בודק הרשאות...');
      const check = await checkCanConvert(userId);
      if (!check.allowed) {
        showAlert(
          'מגבלת שימוש',
          check.reason ?? 'לא ניתן להמיר כעת',
          [
            { text: 'ביטול', style: 'cancel' },
            { text: 'שדרג עכשיו', onPress: () => navigation.navigate('Paywall') },
          ],
        );
        return;
      }

      setLoadingMsg('מאמת תווים...');
      const vData = await withRetry(
        () => fetchJSON<{ ok: boolean; missing: string[] }>(
          `${BACKEND_URL}/validate`,
          {
            method: 'POST',
            body:   JSON.stringify({ text: sanitizedText, user_id: userId }),
          },
        ),
        2,
      );
      if (!vData.ok) {
        const first = vData.missing?.[0];
        if (first) {
          showAlert(
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
        () => fetchJSON<{ glyphs: Record<string, string[]>; missing: string[] }>(
          `${BACKEND_URL}/glyphs`,
          {
            method: 'POST',
            body:   JSON.stringify({ text: sanitizedText, user_id: userId }),
          },
        ),
        2,
      );

      // Usage is incremented server-side in /convert-both — do NOT increment here too.
      await clearPendingConversion(); // discard any queued item — we just succeeded
      await clearDraft();             // text successfully sent — drop saved draft

      // Sanitise the glyph map: filter out any empty/null URLs that could
      // cause the placeholder box to appear for characters that ARE in the bank.
      const cleanGlyphMap: Record<string, string[]> = {};
      for (const [ch, urls] of Object.entries(gData.glyphs)) {
        const validUrls = (urls ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0);
        if (validUrls.length > 0) cleanGlyphMap[ch] = validUrls;
      }

      // Navigate first — the overlay unmounts with EditorScreen so no flicker
      navigation.navigate('Preview', {
        text: sanitizedText,
        background: paperStyle,
        inkColor,
        glyphMap: cleanGlyphMap,
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
        // Save to offline queue — NetInfo listener will restore on reconnect
        await savePendingConversion({ text: sanitizedText, paperStyle, inkColor });
        showAlert(
          'אין חיבור לאינטרנט',
          'הטקסט נשמר ויוצג שוב כשהחיבור יחזור.',
          [{ text: 'אישור' }],
        );
      } else {
        await logError(err, 'handleConvert');
        setError(msg);
      }
    } finally {
      setLoading(false);
      setLoadingMsg('');
      setConverting(false);
    }
  }, [text, paperStyle, inkColor, navigation, lastConvertTime]);

  return (
    <View style={[styles.kav, { paddingBottom: kbHeight }]}>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          {/* Decorative dot — right side in RTL */}
          <View style={styles.inkDot} />

          {/* Title — center */}
          <View style={styles.headerTextBlock}>
            <Text style={styles.headerTitle}>כתוב משהו</Text>
            <Text style={styles.headerSub}>יומר לכתב היד האישי שלך</Text>
          </View>

          {/* Back button — left side in RTL */}
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.65, transform: [{ scale: 0.96 }] }]}
            onPress={() => { impactLight(); navigation.navigate('CharacterList'); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="חזור למאגר אותיות"
            accessibilityHint="מעבר חזרה למסך המאגר. הטקסט יישמר אוטומטית"
          >
            <Text style={styles.backArrow}>›</Text>
            <Text style={styles.backLabel}>מאגר</Text>
          </Pressable>
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
            <Text
              style={[
                styles.counter,
                charCount > MAX_TEXT_LEN && styles.counterError,
                charCount >= TEXT_WARN_THRESHOLD && charCount <= MAX_TEXT_LEN && styles.counterWarn,
              ]}
            >
              {charCount >= TEXT_WARN_THRESHOLD
                ? `${charCount} / ${MAX_TEXT_LEN}`
                : `${charCount}`}
            </Text>
          </View>
        </View>

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {error !== null && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── Convert button ──────────────────────────────────────────────── */}
        <View style={[styles.actionBar, { paddingBottom: kbHeight > 0 ? 8 : insets.bottom + 8 }]}>
          <Pressable
            style={({ pressed }) => [
              styles.convertBtn,
              !canConvert && styles.convertBtnOff,
              canConvert && pressed && styles.convertBtnPressed,
            ]}
            disabled={!canConvert}
            onPress={() => { impactMedium(); handleConvert(); }}
            accessibilityRole="button"
            accessibilityLabel={converting ? 'ממיר טקסט לכתב יד...' : 'המר לכתב יד'}
            accessibilityHint={canConvert
              ? 'שולח את הטקסט לשרת ויוצר תמונה בכתב היד האישי שלך'
              : 'נדרש לכתוב טקסט קודם'}
            accessibilityState={{ disabled: !canConvert, busy: converting }}
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
    </View>
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
    headerTextBlock: { alignItems: 'flex-start', flex: 1 },
    headerTitle: {
      fontSize:         22,
      fontFamily:       fonts.bold,
      color:            colors.inkDark,
      textAlign:        'right',
      writingDirection: 'rtl',
    },
    headerSub: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginTop:        2,
    },
    backBtn: {
      flexDirection:     'row',
      alignItems:        'center',
      gap:               4,
      backgroundColor:   colors.bgSurface,
      borderWidth:       1.5,
      borderColor:       colors.border,
      borderRadius:      22,
      paddingHorizontal: 14,
      paddingVertical:   9,
      ...shadow.card,
    },
    backArrow: {
      fontSize:   18,
      color:      colors.accent,
      fontFamily: fonts.bold,
      lineHeight: 22,
    },
    backLabel: {
      fontSize:         14,
      fontFamily:       fonts.semiBold,
      color:            colors.accent,
      writingDirection: 'rtl',
    },
    inkDot: {
      width:           10,
      height:          10,
      borderRadius:    5,
      backgroundColor: colors.accent,
      opacity:         0.35,
    },

    // ── Paper ────────────────────────────────────────────────────────────────
    paperWrap: {
      flex:            1,
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
    counter:      { fontSize: 11, color: colors.inkFaint, fontVariant: ['tabular-nums'], fontFamily: fonts.regular },
    counterWarn:  { color: '#D97706', fontFamily: fonts.semiBold },
    counterError: { color: colors.danger, fontFamily: fonts.bold },

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
      paddingTop: 12,
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
