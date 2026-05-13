import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getCurrentUserId } from '../src/services/auth';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { fetchJSON, withRetry, toErrorMessage } from '../src/utils/api';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';

type Props = NativeStackScreenProps<RootStackParamList, 'Review'>;

const NUM_COLS = 5;
const H_PAD    = 16;
const CARD_GAP = 8;

const HEBREW_LETTERS = [
  { char: 'א', name: 'אלף'     },
  { char: 'ב', name: 'בית'     },
  { char: 'ג', name: 'גימל'    },
  { char: 'ד', name: 'דלת'     },
  { char: 'ה', name: 'הא'      },
  { char: 'ו', name: 'ואו'     },
  { char: 'ז', name: 'זין'     },
  { char: 'ח', name: 'חית'     },
  { char: 'ט', name: 'טית'     },
  { char: 'י', name: 'יוד'     },
  { char: 'כ', name: 'כף'      },
  { char: 'ך', name: "כף ס'"   },
  { char: 'ל', name: 'למד'     },
  { char: 'מ', name: 'מם'      },
  { char: 'ם', name: "מם ס'"   },
  { char: 'נ', name: 'נון'     },
  { char: 'ן', name: "נון ס'"  },
  { char: 'ס', name: 'סמך'     },
  { char: 'ע', name: 'עין'     },
  { char: 'פ', name: 'פא'      },
  { char: 'ף', name: "פא ס'"   },
  { char: 'צ', name: 'צדי'     },
  { char: 'ץ', name: "צדי ס'"  },
  { char: 'ק', name: 'קוף'     },
  { char: 'ר', name: 'ריש'     },
  { char: 'ש', name: 'שין'     },
  { char: 'ת', name: 'תו'      },
] as const;

const DIGITS = Array.from({ length: 10 }, (_, i) => ({
  char: String(i),
  name: String(i),
})) as Array<{ char: string; name: string }>;

const NORM_TO_CHAR: Record<string, string> = {
  alef: 'א', bet: 'ב', gimel: 'ג', dalet: 'ד', he: 'ה',
  vav: 'ו', zayin: 'ז', het: 'ח', tet: 'ט', yod: 'י',
  kaf: 'כ', kaf_sofit: 'ך', lamed: 'ל', mem: 'מ', mem_sofit: 'ם',
  nun: 'נ', nun_sofit: 'ן', samekh: 'ס', ayin: 'ע', pe: 'פ',
  pe_sofit: 'ף', tsadi: 'צ', tsadi_sofit: 'ץ', qof: 'ק',
  resh: 'ר', shin: 'ש', tav: 'ת',
};

type CharEntry = {
  char:        string;
  name:        string;
  count:       number;
  variantUrls: string[];
  status:      'ok' | 'warning' | 'missing';
};

function parseBankValue(value: unknown): { count: number; urls: string[] } {
  if (!value || typeof value !== 'object') return { count: 0, urls: [] };
  const v = value as Record<string, unknown>;

  const count =
    typeof v.count === 'number' ? v.count :
    Array.isArray(v.variants)   ? v.variants.length : 1;

  const urls: string[] = [];
  if (Array.isArray(v.variants)) {
    for (const item of v.variants) {
      const url = (item as Record<string, unknown>)?.url;
      if (typeof url === 'string') urls.push(url);
    }
  }
  return { count, urls };
}

function buildEntries(
  bank: Record<string, unknown>,
  chars: ReadonlyArray<{ char: string; name: string }>,
): CharEntry[] {
  const lookup: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bank)) {
    if (NORM_TO_CHAR[k])           lookup[NORM_TO_CHAR[k]] = v;
    else if (k.startsWith('digit_')) lookup[k.slice(6)] = v;
    else                            lookup[k] = v;
  }

  return chars.map(({ char, name }) => {
    const val = lookup[char];
    if (val === undefined || val === null) {
      return { char, name, count: 0, variantUrls: [], status: 'missing' };
    }
    const { count, urls } = parseBankValue(val);
    return {
      char, name, count, variantUrls: urls,
      status: count <= 1 ? 'warning' : 'ok',
    };
  });
}

// ── CharCard ──────────────────────────────────────────────────────────────────

type CardProps = { entry: CharEntry; size: number; onPress: () => void };

const CharCard = React.memo(function CharCard({ entry, size, onPress }: CardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const bg = entry.status === 'missing' ? colors.dangerLight
           : entry.status === 'warning' ? colors.warningLight
           : colors.bgSurface;
  const borderColor = entry.status === 'missing' ? colors.danger
                    : entry.status === 'warning'  ? colors.warning
                    : colors.border;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.card, { width: size, height: size * 1.25, backgroundColor: bg, borderColor }]}
    >
      <Text style={styles.cardChar}>{entry.char}</Text>
      <Text style={styles.cardName} numberOfLines={1}>{entry.name}</Text>
      {entry.count > 0 ? (
        <Text style={styles.cardCount}>× {entry.count}</Text>
      ) : (
        <Text style={styles.cardMissing}>חסר</Text>
      )}
    </TouchableOpacity>
  );
});

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ReviewScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const cardSize = (screenW - 2 * H_PAD - (NUM_COLS - 1) * CARD_GAP) / NUM_COLS;

  const [modalEntry,  setModalEntry]  = useState<CharEntry | null>(null);
  const [bank,        setBank]        = useState<Record<string, unknown>>(route.params.bank ?? {});
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const { photoUri } = route.params;
    if (!photoUri) return;

    let cancelled = false;
    const userId = getCurrentUserId() ?? 'anonymous';

    (async () => {
      if (cancelled) return;
      setUploading(true);
      setUploadError(null);
      try {
        const data = await withRetry(
          () => {
            const formData = new FormData();
            formData.append('file', {
              uri:  photoUri,
              name: 'sample.jpg',
              type: 'image/jpeg',
            } as unknown as Blob);
            formData.append('user_id', userId);
            return fetchJSON<Record<string, unknown>>(
              `${BACKEND_URL}/upload-sample`,
              { method: 'POST', body: formData },
            );
          },
          3,
        );
        if (!cancelled) setBank(data);
      } catch (err: unknown) {
        if (!cancelled) setUploadError(toErrorMessage(err, 'העלאה נכשלה. נסה שנית.'));
      } finally {
        if (!cancelled) setUploading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const letterEntries = useMemo(() => buildEntries(bank, HEBREW_LETTERS), [bank]);
  const digitEntries  = useMemo(() => buildEntries(bank, DIGITS),         [bank]);

  const capturedCount = letterEntries.filter(e => e.count > 0).length;
  const progress      = capturedCount / HEBREW_LETTERS.length;
  const canProceed    = capturedCount > 0;

  // ── Upload in progress ─────────────────────────────────────────────────────
  if (uploading) {
    return (
      <SafeAreaView style={[styles.safeArea, { justifyContent: 'center', alignItems: 'center', gap: 16 }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontSize: 16, color: colors.inkMid, writingDirection: 'rtl' }}>
          מעבד את כתב היד...
        </Text>
      </SafeAreaView>
    );
  }

  // ── Upload error ───────────────────────────────────────────────────────────
  if (uploadError) {
    return (
      <SafeAreaView style={[styles.safeArea, { justifyContent: 'center', alignItems: 'center', gap: 16, paddingHorizontal: 32 }]}>
        <Text style={{ fontSize: 16, color: colors.danger, textAlign: 'center', writingDirection: 'rtl' }}>
          {uploadError}
        </Text>
        <Pressable
          style={({ pressed }) => [{
            backgroundColor: colors.accent,
            paddingHorizontal: 32,
            paddingVertical: 14,
            borderRadius: radius.md,
            opacity: pressed ? 0.82 : 1,
          }]}
          onPress={() => navigation.goBack()}
        >
          <Text style={{ color: '#FDF6EC', fontWeight: '700', fontSize: 15, writingDirection: 'rtl' }}>
            חזור וצלם שוב
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>

      {/* ── Progress bar ────────────────────────────────────────────────── */}
      <View style={styles.progressSection}>
        <View style={styles.progressHeader}>
          <Text style={styles.progressLabel}>
            {capturedCount} / {HEBREW_LETTERS.length} אותיות עבריות זוהו
          </Text>
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: colors.success }]} />
            <Text style={styles.legendText}>2+</Text>
            <View style={[styles.legendDot, { backgroundColor: colors.warning }]} />
            <Text style={styles.legendText}>1</Text>
            <View style={[styles.legendDot, { backgroundColor: colors.danger }]} />
            <Text style={styles.legendText}>חסר</Text>
          </View>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      </View>

      {/* ── Character grids ─────────────────────────────────────────────── */}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Empty state ─────────────────────────────────────────────── */}
        {capturedCount === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔍</Text>
            <Text style={styles.emptyTitle}>לא זוהו אותיות</Text>
            <Text style={styles.emptySub}>
              נסה לצלם את הדף מחדש בתאורה טובה, ללא צל
            </Text>
            <TouchableOpacity
              style={styles.emptyBtn}
              onPress={() => { impactLight(); navigation.navigate('Camera'); }}
              activeOpacity={0.8}
            >
              <Text style={styles.emptyBtnText}>צלם שוב</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.sectionTitle}>אותיות עבריות</Text>
        <View style={styles.grid}>
          {letterEntries.map(entry => (
            <CharCard
              key={entry.char}
              entry={entry}
              size={cardSize}
              onPress={() => setModalEntry(entry)}
            />
          ))}
        </View>

        <Text style={styles.sectionTitle}>ספרות</Text>
        <View style={styles.grid}>
          {digitEntries.map(entry => (
            <CharCard
              key={entry.char}
              entry={entry}
              size={cardSize}
              onPress={() => setModalEntry(entry)}
            />
          ))}
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* ── Action bar ──────────────────────────────────────────────────── */}
      <View style={styles.actionBar}>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => { impactLight(); navigation.navigate('Camera'); }}
          activeOpacity={0.8}
        >
          <Text style={styles.addBtnText}>הוסף דוגמאות</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.looksGoodBtn, !canProceed && styles.looksGoodDisabled]}
          disabled={!canProceed}
          onPress={() => { impactMedium(); navigation.navigate('Editor'); }}
          activeOpacity={0.8}
        >
          <Text style={[styles.looksGoodText, !canProceed && styles.looksGoodTextDisabled]}>
            נראה טוב
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Variant images modal ─────────────────────────────────────────── */}
      <Modal
        visible={modalEntry !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setModalEntry(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setModalEntry(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            {modalEntry && (
              <>
                <Text style={styles.modalChar}>{modalEntry.char}</Text>
                <Text style={styles.modalName}>{modalEntry.name}</Text>

                {modalEntry.count === 0 ? (
                  <Text style={styles.modalMissingText}>אות זו טרם זוהתה</Text>
                ) : modalEntry.variantUrls.length > 0 ? (
                  <>
                    <Text style={styles.modalSubtitle}>
                      {modalEntry.count} דוגמאות שנשמרו
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.variantsRow}
                    >
                      {modalEntry.variantUrls.map((url) => (
                        <Image
                          key={url}
                          source={{ uri: url }}
                          style={styles.variantImage}
                          resizeMode="contain"
                        />
                      ))}
                    </ScrollView>
                  </>
                ) : (
                  <Text style={styles.modalSubtitle}>
                    {modalEntry.count} דוגמאות נשמרו
                  </Text>
                )}

                <TouchableOpacity
                  style={styles.modalCloseBtn}
                  onPress={() => setModalEntry(null)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalCloseBtnText}>סגור</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.bgPage,
    },

    // ── Progress ──────────────────────────────────────────────────────────────
    progressSection: {
      backgroundColor: colors.bgSurface,
      paddingHorizontal: H_PAD,
      paddingTop: 14,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 10,
      ...shadow.card,
    },
    progressHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    progressLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.inkDark,
      writingDirection: 'rtl',
    },
    legend: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    legendDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    legendText: {
      fontSize: 11,
      color: colors.inkLight,
      marginRight: 4,
      writingDirection: 'rtl',
    },
    progressTrack: {
      height: 8,
      backgroundColor: colors.border,
      borderRadius: 4,
      overflow: 'hidden',
    },
    progressFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: colors.success,
      borderRadius: 4,
    },

    // ── Grid ──────────────────────────────────────────────────────────────────
    scrollContent: {
      paddingHorizontal: H_PAD,
      paddingTop: 8,
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.inkDark,
      textAlign: 'right',
      writingDirection: 'rtl',
      marginTop: 16,
      marginBottom: 10,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: CARD_GAP,
    },

    // ── Card ──────────────────────────────────────────────────────────────────
    card: {
      borderWidth: 1.5,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 6,
      gap: 2,
      shadowColor: colors.inkDark,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 2,
      elevation: 1,
    },
    cardChar: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.inkDark,
    },
    cardName: {
      fontSize: 9,
      color: colors.inkLight,
      textAlign: 'center',
      writingDirection: 'rtl',
      paddingHorizontal: 2,
    },
    cardCount: {
      fontSize: 10,
      fontWeight: '600',
      color: colors.success,
    },
    cardMissing: {
      fontSize: 9,
      fontWeight: '600',
      color: colors.danger,
      writingDirection: 'rtl',
    },

    // ── Action bar ────────────────────────────────────────────────────────────
    actionBar: {
      flexDirection: 'row',
      paddingHorizontal: H_PAD,
      paddingTop: 12,
      paddingBottom: 16,
      gap: 12,
      backgroundColor: colors.bgSurface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderFaint,
    },
    addBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: radius.md,
      alignItems: 'center',
      backgroundColor: colors.bgPage,
      borderWidth: 1,
      borderColor: colors.border,
    },
    addBtnText: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.inkMid,
      writingDirection: 'rtl',
    },
    looksGoodBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: radius.md,
      alignItems: 'center',
      backgroundColor: colors.accent,
      ...shadow.btn,
    },
    looksGoodDisabled: {
      backgroundColor: colors.border,
      shadowOpacity: 0,
      elevation: 0,
    },
    looksGoodText: {
      fontSize: 15,
      fontWeight: '700',
      color: '#FDF6EC',
      writingDirection: 'rtl',
    },
    looksGoodTextDisabled: {
      color: colors.inkFaint,
    },

    // ── Empty state ───────────────────────────────────────────────────────────
    emptyState: {
      alignItems: 'center',
      paddingVertical: 32,
      paddingHorizontal: 24,
      gap: 10,
      marginBottom: 8,
    },
    emptyIcon:  { fontSize: 48, marginBottom: 4 },
    emptyTitle: {
      fontSize: 18, fontFamily: fonts.bold,
      color: colors.inkDark, writingDirection: 'rtl',
    },
    emptySub: {
      fontSize: 14, fontFamily: fonts.regular,
      color: colors.inkLight, textAlign: 'center',
      writingDirection: 'rtl', lineHeight: 21,
    },
    emptyBtn: {
      marginTop: 8, paddingHorizontal: 32, paddingVertical: 12,
      backgroundColor: colors.accent, borderRadius: radius.md,
    },
    emptyBtnText: {
      color: '#FFFFFF', fontFamily: fonts.bold,
      fontSize: 15, writingDirection: 'rtl',
    },

    // ── Modal ─────────────────────────────────────────────────────────────────
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(15,23,42,0.65)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    modalCard: {
      backgroundColor: colors.bgSurface,
      borderRadius: radius.lg,
      paddingVertical: 28,
      paddingHorizontal: 24,
      width: '100%',
      alignItems: 'center',
      gap: 12,
      ...shadow.page,
    },
    modalChar: {
      fontSize: 72,
      fontWeight: '700',
      color: colors.inkDark,
      lineHeight: 88,
    },
    modalName: {
      fontSize: 18,
      fontWeight: '500',
      color: colors.inkLight,
      writingDirection: 'rtl',
    },
    modalSubtitle: {
      fontSize: 14,
      color: colors.inkFaint,
      writingDirection: 'rtl',
    },
    modalMissingText: {
      fontSize: 16,
      color: colors.danger,
      fontWeight: '500',
      writingDirection: 'rtl',
    },
    variantsRow: {
      gap: 12,
      paddingVertical: 4,
      paddingHorizontal: 4,
    },
    variantImage: {
      width: 80,
      height: 80,
      borderRadius: radius.sm,
      backgroundColor: colors.bgPage,
      borderWidth: 1,
      borderColor: colors.border,
    },
    modalCloseBtn: {
      marginTop: 8,
      paddingHorizontal: 36,
      paddingVertical: 12,
      backgroundColor: colors.bgPage,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
    },
    modalCloseBtnText: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.inkMid,
      writingDirection: 'rtl',
    },
  });
}
