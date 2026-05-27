import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { showAlert } from '../src/utils/alert';
import Slider from '@react-native-community/slider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useTheme, ThemeColors } from '../src/contexts/ThemeContext';
import { fonts, radius, shadow } from '../src/theme';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';
import { getCurrentUserId } from '../src/services/auth';

type Props = NativeStackScreenProps<RootStackParamList, 'HandwritingCustomizer'>;

// ── Style params stored in AsyncStorage and sent with /convert ──────────────
export interface HandwritingStyle {
  charHeight:     number;   // 20–100
  letterSpacing:  number;   // 0–30
  wordSpacing:    number;   // 10–100
  baselineJitter: number;   // 0–10
}

export const DEFAULT_STYLE: HandwritingStyle = {
  charHeight:     80,
  letterSpacing:  8,
  wordSpacing:    32,
  baselineJitter: 2,
};

export const STYLE_STORAGE_KEY = 'handwriting_style';

// Preview words — chosen to include ascenders, descenders, small letters
const PREVIEW_WORDS = ['שלום', 'עולם', 'כתב', 'ידי'];

// ── Slider row ───────────────────────────────────────────────────────────────
interface SliderRowProps {
  label:    string;
  value:    number;
  min:      number;
  max:      number;
  step?:    number;
  unit?:    string;
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step = 1, unit = '', onChange }: SliderRowProps) {
  const { colors } = useTheme();
  const sl = useMemo(() => getSliderStyles(colors), [colors]);

  return (
    <View style={sl.wrap}>
      <View style={sl.header}>
        <Text style={sl.label}>{label}</Text>
        <Text style={sl.value}>{Math.round(value)}{unit}</Text>
      </View>
      <Slider
        style={sl.slider}
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={colors.accent}
        maximumTrackTintColor={colors.border}
        thumbTintColor={colors.accent}
      />
      <View style={sl.ticks}>
        <Text style={sl.tick}>{min}</Text>
        <Text style={sl.tick}>{max}</Text>
      </View>
    </View>
  );
}

function getSliderStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap:   { marginBottom: 24 },
    header: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 6 },
    label:  { fontSize: 15, fontFamily: fonts.semiBold, color: colors.inkDark, writingDirection: 'rtl' },
    value:  { fontSize: 15, fontFamily: fonts.bold,     color: colors.accent,  minWidth: 44, textAlign: 'left' },
    slider: { width: '100%', height: 36 },
    ticks:  { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: -4 },
    tick:   { fontSize: 10, fontFamily: fonts.regular, color: colors.inkLight },
  });
}

// ── Live preview ─────────────────────────────────────────────────────────────
interface PreviewProps {
  style: HandwritingStyle;
  bank:  Record<string, string>;   // char → variant URL
}

function LivePreview({ style: hs, bank }: PreviewProps) {
  const { colors } = useTheme();
  const pv = useMemo(() => getPreviewStyles(colors), [colors]);
  const { width: W } = useWindowDimensions();
  const previewW = W - 32;  // 16px horizontal margin each side

  // Helper: pick a random (deterministic per char) variant URL
  function urlFor(ch: string): string | null {
    return bank[ch] ?? null;
  }

  // Render one word as a row of character images
  function renderWord(word: string, wordIdx: number) {
    const chars = word.split('');
    return (
      <View
        key={wordIdx}
        style={[pv.word, { marginLeft: hs.wordSpacing }]}
      >
        {/* row-reverse so first char (rightmost in RTL) renders first */}
        {chars.map((ch, i) => {
          const url = urlFor(ch);
          // Jitter: deterministic-ish per position using sin for demo
          const jitter = Math.sin(wordIdx * 7 + i * 13) * hs.baselineJitter;
          if (!url) {
            return (
              <View
                key={i}
                style={[
                  pv.placeholder,
                  {
                    width:       hs.charHeight * 0.7,
                    height:      hs.charHeight,
                    marginLeft:  hs.letterSpacing,
                    transform:   [{ translateY: jitter }],
                  },
                ]}
              >
                <Text style={[pv.placeholderText, { fontSize: hs.charHeight * 0.5 }]}>{ch}</Text>
              </View>
            );
          }
          return (
            <Image
              key={i}
              source={{ uri: url }}
              style={{
                width:       hs.charHeight * 0.8,
                height:      hs.charHeight,
                marginLeft:  hs.letterSpacing,
                resizeMode:  'contain',
                transform:   [{ translateY: jitter }],
              }}
            />
          );
        })}
      </View>
    );
  }

  return (
    <View style={[pv.container, { width: previewW, minHeight: hs.charHeight + 32 }]}>
      <View style={pv.lineRow}>
        {PREVIEW_WORDS.map((w, i) => renderWord(w, i))}
      </View>
    </View>
  );
}

function getPreviewStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: '#FAFAFA',
      borderRadius: radius.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 16,
      overflow: 'hidden',
      alignSelf: 'center',
      ...shadow.card,
    },
    lineRow: {
      flexDirection: 'row-reverse',  // RTL: first word on right
      flexWrap: 'wrap',
      justifyContent: 'flex-start',
      alignItems: 'flex-end',        // baseline-align words
    },
    word: {
      flexDirection:  'row-reverse', // RTL letter order within word
      alignItems:     'flex-end',
      marginBottom:   8,
    },
    placeholder: {
      backgroundColor: colors.accentLight,
      borderRadius: 4,
      justifyContent: 'center',
      alignItems: 'center',
    },
    placeholderText: {
      color: colors.accent,
      fontFamily: fonts.bold,
    },
  });
}

// ── Main screen ──────────────────────────────────────────────────────────────
export default function HandwritingCustomizerScreen({ navigation: _navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const uid = getCurrentUserId() ?? 'anonymous';

  const [hs,      setHs]      = useState<HandwritingStyle>(DEFAULT_STYLE);
  const [bank,    setBank]    = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  // ── Load saved style + bank variants ───────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Restore saved style
      const raw = await AsyncStorage.getItem(STYLE_STORAGE_KEY);
      if (raw) setHs({ ...DEFAULT_STYLE, ...JSON.parse(raw) });

      // Fetch one variant URL per preview character
      const chars = Array.from(new Set(PREVIEW_WORDS.join('')));
      const bankMap: Record<string, string> = {};
      await Promise.all(chars.map(async (ch) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10000);
        try {
          const res  = await fetch(
            `${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(ch)}/variants`,
            { signal: controller.signal },
          );
          const data = await res.json() as { variants: { index: number; url: string }[] };
          if (data.variants?.length) bankMap[ch] = data.variants[0].url;
        } catch { /* char not in bank — placeholder shown */ } finally {
          clearTimeout(t);
        }
      }));
      setBank(bankMap);
    } catch {
      // Non-fatal — preview uses placeholders
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave() {
    impactMedium();
    setSaving(true);
    try {
      await AsyncStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(hs));
      showAlert('✓ נשמר', 'סגנון כתב היד עודכן בהצלחה');
    } catch {
      showAlert('שגיאה', 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    impactLight();
    showAlert('איפוס הגדרות', 'לאפס את כל הפרמטרים לברירת המחדל?', [
      { text: 'ביטול', style: 'cancel' },
      { text: 'אפס', style: 'destructive', onPress: () => setHs(DEFAULT_STYLE) },
    ]);
  }

  const update = (key: keyof HandwritingStyle) => (v: number) =>
    setHs(prev => ({ ...prev, [key]: v }));

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.title}>מכוון כתב היד</Text>
        <Text style={styles.sub}>שנה את הפרמטרים וראה את השפעתם בזמן אמת</Text>
      </View>

      {/* ── Live preview ─────────────────────────────────────────────── */}
      <View style={styles.previewSection}>
        <Text style={styles.sectionLabel}>תצוגה מקדימה</Text>
        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginVertical: 24 }} />
        ) : (
          <LivePreview style={hs} bank={bank} />
        )}
      </View>

      {/* ── Sliders ──────────────────────────────────────────────────── */}
      <View style={styles.slidersCard}>
        <SliderRow
          label="גודל הכתב"
          value={hs.charHeight}
          min={20}
          max={120}
          unit="px"
          onChange={update('charHeight')}
        />
        <SliderRow
          label="ריווח אותיות"
          value={hs.letterSpacing}
          min={0}
          max={30}
          unit="px"
          onChange={update('letterSpacing')}
        />
        <SliderRow
          label="ריווח מילים"
          value={hs.wordSpacing}
          min={10}
          max={120}
          unit="px"
          onChange={update('wordSpacing')}
        />
        <SliderRow
          label="ריקוד השורה"
          value={hs.baselineJitter}
          min={0}
          max={10}
          step={0.5}
          unit="%"
          onChange={update('baselineJitter')}
        />
      </View>

      {/* ── Actions ──────────────────────────────────────────────────── */}
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.7 }]}
          onPress={handleReset}
          accessibilityRole="button"
          accessibilityLabel="איפוס הגדרות לברירת מחדל"
          accessibilityHint="מחזיר את כל הסליידרים לערכים המומלצים"
        >
          <Text style={styles.resetBtnText}>איפוס</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.saveBtn,
            pressed && { opacity: 0.88 },
            saving && { opacity: 0.6 },
          ]}
          onPress={handleSave}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={saving ? 'שומר הגדרות...' : 'שמור הגדרות'}
          accessibilityState={{ disabled: saving, busy: saving }}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnText}>שמור הגדרות</Text>
          }
        </Pressable>
      </View>
    </ScrollView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root:    { flex: 1, backgroundColor: colors.bgPage },
    content: { paddingBottom: 40 },

    header: {
      backgroundColor: colors.bgDark,
      paddingTop: 52,
      paddingBottom: 24,
      paddingHorizontal: 20,
      alignItems: 'center',
    },
    title: { fontSize: 22, fontFamily: fonts.bold,    color: '#fff',    marginBottom: 4, writingDirection: 'rtl' },
    sub:   { fontSize: 13, fontFamily: fonts.regular,  color: '#94A3B8', textAlign: 'center', writingDirection: 'rtl' },

    previewSection: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 },
    sectionLabel:   {
      fontSize: 12,
      fontFamily: fonts.bold,
      color: colors.inkLight,
      textAlign: 'right',
      writingDirection: 'rtl',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 12,
    },

    slidersCard: {
      margin: 16,
      backgroundColor: colors.bgSurface,
      borderRadius: radius.lg,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
      ...shadow.card,
    },

    actions: {
      flexDirection: 'row-reverse',
      gap: 12,
      paddingHorizontal: 16,
      marginTop: 8,
    },
    saveBtn: {
      flex: 1,
      backgroundColor: colors.accent,
      paddingVertical: 16,
      borderRadius: radius.md,
      alignItems: 'center',
      ...shadow.btn,
    },
    saveBtnText: { color: '#fff', fontSize: 16, fontFamily: fonts.bold, writingDirection: 'rtl' },
    resetBtn: {
      paddingVertical: 16,
      paddingHorizontal: 20,
      borderRadius: radius.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      alignItems: 'center',
    },
    resetBtnText: { color: colors.inkMid, fontSize: 15, fontFamily: fonts.semiBold, writingDirection: 'rtl' },
  });
}
