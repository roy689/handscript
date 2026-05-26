/**
 * FinalViewScreen — displays server-rendered handwriting pages.
 *
 * Architecture (Pipeline Synchronization Principle 5):
 *   - cleanUrls and photoUrls are fetched once and cached.
 *   - pageUrls always points to one of these caches — never a fresh fetch.
 *   - Export (save/share/PDF) uses pageUrls directly: what you see = what you export.
 *
 * Layout:
 *   ┌─────────────────────────────────────┐
 *   │  SERVER IMAGE (A4 proportions)      │
 *   ├─────────────────────────────────────┤
 *   │  PAGE NAV  (← 1/N →)               │
 *   ├─────────────────────────────────────┤
 *   │  MODE TOGGLE (סריקה נקייה | מראה צילום) │
 *   ├─────────────────────────────────────┤
 *   │  FOOTER (back | save | share | pdf) │
 *   └─────────────────────────────────────┘
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { showAlert } from '../src/utils/alert';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem   from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing      from 'expo-sharing';
import * as Print        from 'expo-print';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList }     from '../navigation/types';
import { fonts, radius }               from '../src/theme';
import { useTheme, type ThemeColors }  from '../src/contexts/ThemeContext';
import { BACKEND_URL }                 from '../src/config';
import { getCurrentUserId }            from '../src/services/auth';
import { getAuthToken }               from '../src/utils/api';
import { impactLight, impactMedium }   from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'FinalView'>;

interface GlyphStyle {
  charHeight:     number;
  letterSpacing:  number;
  wordSpacing:    number;
  baselineJitter: number;
  slant:          number;
  inkBlobs:       number;
}

const FRAME_MH = 14;
const A4_RATIO = 297 / 210;


// ── Helpers ───────────────────────────────────────────────────────────────────

function absUrl(url: string): string {
  return url.startsWith('http') ? url : `${BACKEND_URL}${url}`;
}

async function fetchBothModes(
  text: string,
  background: string,
  style: GlyphStyle,
  inkColor: string,
): Promise<{ cleanUrls: string[]; photoUrls: string[] }> {
  const token = await getAuthToken();
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error('משתמש לא מחובר — התחבר מחדש ונסה שוב');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000); // 90s — image generation is heavy

  try {
    const res = await fetch(`${BACKEND_URL}/convert-both`, {
      method:  'POST',
      headers,
      signal:  controller.signal,
      body:    JSON.stringify({
        text,
        user_id: userId,
        background,
        ink_color: inkColor,
        style: {
          char_height:     Math.round(40 + style.charHeight * 0.9),
          letter_spacing:  style.letterSpacing * 0.30,
          word_spacing:    Math.round(15 + style.wordSpacing * 0.85),
          baseline_jitter: style.baselineJitter * 0.25,
          slant:           style.slant * 0.4,
          ink_blobs:       style.inkBlobs * 0.003,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `שגיאת שרת (${res.status})`);
    }
    const data = await res.json() as {
      ok: boolean;
      clean_urls?: string[];
      photo_urls?: string[];
      error?: string;
    };
    if (!data.ok || !data.clean_urls?.length || !data.photo_urls?.length)
      throw new Error(data.error ?? 'שגיאת שרת');
    return { cleanUrls: data.clean_urls, photoUrls: data.photo_urls };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError')
      throw new Error('פסק זמן: יצירת הכתב היד לוקחת יותר מדי זמן. נסה טקסט קצר יותר.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToCache(remoteUrl: string): Promise<string> {
  const full = absUrl(remoteUrl);
  const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dest = FileSystem.cacheDirectory + `handscript_export_${uniq}.png`;
  const { uri, status } = await FileSystem.downloadAsync(full, dest);
  if (status !== 200) throw new Error(`הורדת התמונה נכשלה (${status})`);
  return uri;
}

const PDF_PAGE_W = 595;
const PDF_PAGE_H = 842;

async function buildPdf(urls: string[]): Promise<string> {
  const base64Pages = await Promise.all(
    urls.map(async url => {
      const localUri = await downloadToCache(url);
      return FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    }),
  );

  const pageDivs = base64Pages
    .map((b64, i) => {
      const breakAfter = i < base64Pages.length - 1
        ? 'page-break-after:always;'
        : 'page-break-after:avoid;';
      return (
        `<div class="page" style="${breakAfter}">` +
        `<img src="data:image/png;base64,${b64}"/>` +
        `</div>`
      );
    })
    .join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  @page { size: ${PDF_PAGE_W}pt ${PDF_PAGE_H}pt; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${PDF_PAGE_W}pt; background: #fff; }
  .page {
    width: ${PDF_PAGE_W}pt;
    height: ${PDF_PAGE_H}pt;
    overflow: hidden;
    page-break-inside: avoid;
    display: block;
  }
  .page img {
    width: ${PDF_PAGE_W}pt;
    height: ${PDF_PAGE_H}pt;
    display: block;
    object-fit: fill;
  }
</style>
</head>
<body>${pageDivs}</body>
</html>`;

  const { uri } = await Print.printToFileAsync({
    html,
    base64: false,
    width:  PDF_PAGE_W,
    height: PDF_PAGE_H,
  });
  return uri;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function FinalViewScreen({ navigation, route }: Props) {
  const { text, background, glyphMap: _glyphMap, style: gs, inkColor } = route.params;
  const { width: W } = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  // Both modes fetched together on mount — switching is always instant
  const [cleanUrls,  setCleanUrls]  = useState<string[]>([]);
  const [photoUrls,  setPhotoUrls]  = useState<string[]>([]);
  const [pageUrls,   setPageUrls]   = useState<string[]>([]);
  const [isLoading,  setIsLoading]  = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [scanMode,   setScanMode]   = useState<'clean' | 'photo'>('clean');
  const [currentPage, setCurrentPage] = useState(0);

  const [savingGallery, setSavingGallery] = useState(false);
  const [savingShare,   setSavingShare]   = useState(false);
  const [savingPdf,     setSavingPdf]     = useState(false);

  const placeholderH = Math.round((W - 2 * FRAME_MH) * A4_RATIO);

  // Fetch both clean and photo together — screen shows only after both are ready
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const userId = getCurrentUserId();
        if (!userId) { setFetchError('יש להתחבר תחילה'); setIsLoading(false); return; }
        const { cleanUrls: clean, photoUrls: photo } =
          await fetchBothModes(text, background, gs, inkColor);
        if (cancelled) return;
        setCleanUrls(clean);
        setPhotoUrls(photo);
        setPageUrls(clean);
        setIsLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : 'שגיאה בטעינת הדף');
          setIsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalPages = pageUrls.length;

  // Toggle between modes — instant, both already pre-fetched
  const handleSwitchMode = useCallback((mode: 'clean' | 'photo') => {
    if (mode === scanMode || isLoading) return;
    if (mode === 'clean') {
      setScanMode('clean');
      setPageUrls(cleanUrls);
      setCurrentPage(0);
    } else {
      setScanMode('photo');
      setPageUrls(photoUrls);
      setCurrentPage(0);
    }
  }, [scanMode, isLoading, cleanUrls, photoUrls]);

  // ── Save to gallery — uses pageUrls directly (what is shown = what is saved)
  const handleSaveGallery = useCallback(async () => {
    if (!pageUrls.length) return;
    setSavingGallery(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        showAlert('הרשאה נדרשת', 'יש לאשר גישה לגלריה בהגדרות', [
          { text: 'ביטול', style: 'cancel' },
          { text: 'פתח הגדרות', onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      for (const url of pageUrls) {
        const localUri = await downloadToCache(url);
        await MediaLibrary.saveToLibraryAsync(localUri);
      }
      showAlert('נשמר!', pageUrls.length > 1 ? `${pageUrls.length} עמודים נשמרו לגלריה` : 'התמונה נשמרה לגלריה');
    } catch (e: unknown) {
      showAlert('שגיאה', e instanceof Error ? e.message : 'שמירה נכשלה');
    } finally {
      setSavingGallery(false);
    }
  }, [pageUrls]);

  // ── Share — uses pageUrls directly
  const handleShare = useCallback(async () => {
    if (!pageUrls.length) return;
    setSavingShare(true);
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) { showAlert('שיתוף לא זמין', 'המכשיר אינו תומך בשיתוף'); return; }

      if (pageUrls.length === 1) {
        const localUri = await downloadToCache(pageUrls[0]);
        await Sharing.shareAsync(localUri, { mimeType: 'image/png', dialogTitle: 'שתף כתב יד' });
      } else {
        const pdfUri = await buildPdf(pageUrls);
        await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf', dialogTitle: 'שתף כתב יד (PDF)' });
      }
    } catch (e: unknown) {
      showAlert('שגיאה', e instanceof Error ? e.message : 'שיתוף נכשל');
    } finally {
      setSavingShare(false);
    }
  }, [pageUrls]);

  // ── Export to PDF — uses pageUrls directly
  const handleExportPdf = useCallback(async () => {
    if (!pageUrls.length) return;
    setSavingPdf(true);
    try {
      const pdfUri = await buildPdf(pageUrls);
      const isAvailable = await Sharing.isAvailableAsync();
      if (isAvailable) {
        await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf', dialogTitle: 'שתף PDF' });
      } else {
        showAlert('PDF נוצר', 'שיתוף אינו זמין במכשיר זה');
      }
    } catch (e: unknown) {
      showAlert('שגיאה', e instanceof Error ? e.message : 'ייצוא PDF נכשל');
    } finally {
      setSavingPdf(false);
    }
  }, [pageUrls]);

  const isBusy = savingGallery || savingShare || savingPdf;

  // ── RENDER ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* ── PAGE IMAGE ────────────────────────────────────────────────── */}
        <View style={styles.frameShadow}>
          <View style={styles.frameClip}>
            {isLoading ? (
              <View style={[styles.loadingBox, { height: placeholderH }]}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loadingTitle}>מייצר את כתב היד...</Text>
                <Text style={styles.loadingSub}>זה עשוי לקחת כמה שניות</Text>
              </View>
            ) : fetchError ? (
              <View style={[styles.loadingBox, { height: placeholderH }]}>
                <Text style={styles.errorText}>{fetchError}</Text>
                <Pressable style={styles.retryBtn} onPress={() => navigation.goBack()}>
                  <Text style={styles.retryBtnText}>חזור לעריכה</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ aspectRatio: 210 / 297 }}>
                <Image
                  key={absUrl(pageUrls[currentPage] ?? '')}
                  source={{ uri: absUrl(pageUrls[currentPage] ?? '') }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="stretch"
                />
              </View>
            )}
          </View>
        </View>

        {/* ── PAGE NAVIGATION ───────────────────────────────────────────── */}
        {totalPages > 1 && (
          <View style={styles.pageNav}>
            <Pressable
              style={({ pressed }) => [
                styles.pageNavBtn,
                currentPage === 0 && styles.pageNavBtnOff,
                pressed && currentPage > 0 && { opacity: 0.6, transform: [{ scale: 0.92 }] },
              ]}
              onPress={() => { impactLight(); setCurrentPage(p => Math.max(0, p - 1)); }}
              disabled={currentPage === 0}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="דף קודם"
              accessibilityState={{ disabled: currentPage === 0 }}
            >
              <Text style={styles.pageNavArrow}>‹</Text>
            </Pressable>
            <Text
              style={styles.pageNavLabel}
              accessibilityLabel={`דף ${currentPage + 1} מתוך ${totalPages}`}
            >
              {currentPage + 1} / {totalPages}
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.pageNavBtn,
                currentPage === totalPages - 1 && styles.pageNavBtnOff,
                pressed && currentPage < totalPages - 1 && { opacity: 0.6, transform: [{ scale: 0.92 }] },
              ]}
              onPress={() => { impactLight(); setCurrentPage(p => Math.min(totalPages - 1, p + 1)); }}
              disabled={currentPage === totalPages - 1}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="דף הבא"
              accessibilityState={{ disabled: currentPage === totalPages - 1 }}
            >
              <Text style={styles.pageNavArrow}>›</Text>
            </Pressable>
          </View>
        )}

        {/* ── SCAN MODE TOGGLE ─────────────────────────────────────────── */}
        <View style={styles.modeToggleRow}>
          <Pressable
            style={({ pressed }) => [
              styles.modeBtn,
              scanMode === 'clean' && styles.modeBtnActive,
              pressed && scanMode !== 'clean' && { opacity: 0.7 },
            ]}
            onPress={() => { impactLight(); handleSwitchMode('clean'); }}
            disabled={isLoading || isBusy}
            accessibilityRole="button"
            accessibilityLabel="מצב סריקה נקייה"
            accessibilityState={{ selected: scanMode === 'clean', disabled: isLoading || isBusy }}
          >
            <Text style={[styles.modeBtnText, scanMode === 'clean' && styles.modeBtnTextActive]}>
              סריקה נקייה
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.modeBtn,
              scanMode === 'photo' && styles.modeBtnActive,
              pressed && scanMode !== 'photo' && { opacity: 0.7 },
            ]}
            onPress={() => { impactLight(); handleSwitchMode('photo'); }}
            disabled={isLoading || isBusy}
            accessibilityRole="button"
            accessibilityLabel="מצב מראה צילום"
            accessibilityState={{ selected: scanMode === 'photo', disabled: isLoading || isBusy }}
          >
            <Text style={[styles.modeBtnText, scanMode === 'photo' && styles.modeBtnTextActive]}>
              מראה צילום
            </Text>
          </Pressable>
        </View>

        {/* ── ACTION PANEL ─────────────────────────────────────────────── */}
        <View style={styles.panel}>

          <Pressable
            style={({ pressed }) => [styles.backRow, pressed && { opacity: 0.6, transform: [{ scale: 0.97 }] }]}
            onPress={() => { impactLight(); navigation.goBack(); }}
            disabled={isBusy}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="חזור לעריכה"
            accessibilityHint="עובר חזרה למסך התצוגה המקדימה כדי לערוך את הטקסט או הסגנון"
            accessibilityState={{ disabled: isBusy }}
          >
            <Text style={styles.backText}>← חזור לעריכה</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed, (isBusy || !pageUrls.length) && styles.btnDisabled]}
            onPress={() => { impactMedium(); handleSaveGallery(); }}
            disabled={isBusy || !pageUrls.length}
            accessibilityRole="button"
            accessibilityLabel={savingGallery ? 'שומר לגלריה...' : 'שמור לגלריה'}
            accessibilityHint="שומר את הדפים שיצרת כתמונות בגלריית המכשיר"
            accessibilityState={{ disabled: isBusy || !pageUrls.length, busy: savingGallery }}
          >
            {savingGallery
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.primaryBtnText}>שמור לגלריה</Text>}
          </Pressable>

          <View style={styles.secondaryRow}>
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed, (isBusy || !pageUrls.length) && styles.btnDisabled]}
              onPress={() => { impactLight(); handleShare(); }}
              disabled={isBusy || !pageUrls.length}
              accessibilityRole="button"
              accessibilityLabel={savingShare ? 'מכין שיתוף...' : 'שתף את הדף'}
              accessibilityHint="פותח חלון שיתוף לאפליקציות אחרות"
              accessibilityState={{ disabled: isBusy || !pageUrls.length, busy: savingShare }}
            >
              {savingShare
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Text style={styles.secondaryBtnText}>שתף</Text>}
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed, (isBusy || !pageUrls.length) && styles.btnDisabled]}
              onPress={() => { impactLight(); handleExportPdf(); }}
              disabled={isBusy || !pageUrls.length}
              accessibilityRole="button"
              accessibilityLabel={savingPdf ? 'מייצא PDF...' : 'ייצא כקובץ PDF'}
              accessibilityHint="יוצר קובץ PDF של כל הדפים יחד"
              accessibilityState={{ disabled: isBusy || !pageUrls.length, busy: savingPdf }}
            >
              {savingPdf
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Text style={styles.secondaryBtnText}>ייצא PDF</Text>}
            </Pressable>
          </View>

        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe:   { flex: 1, backgroundColor: colors.bgPage },
    scroll: { paddingTop: 16, paddingBottom: 32 },

    frameShadow: {
      marginHorizontal: FRAME_MH,
      marginBottom:     8,
      borderRadius:     4,
      shadowColor:      '#1B2A3B',
      shadowOffset:     { width: 0, height: 4 },
      shadowOpacity:    0.22,
      shadowRadius:     14,
      elevation:        10,
    },
    frameClip: {
      borderRadius:    4,
      borderWidth:     1,
      borderColor:     'rgba(0,0,0,0.09)',
      overflow:        'hidden' as const,
      backgroundColor: '#fff',
    },

    loadingBox: {
      alignItems:        'center',
      justifyContent:    'center',
      gap:               14,
      paddingHorizontal: 24,
    },
    loadingTitle: { fontSize: 17, fontFamily: fonts.bold,    color: colors.inkDark,  writingDirection: 'rtl', textAlign: 'center' },
    loadingSub:   { fontSize: 12, fontFamily: fonts.regular, color: colors.inkLight, writingDirection: 'rtl', textAlign: 'center' },

    errorText: {
      fontSize:         14,
      fontFamily:       fonts.semiBold,
      color:            colors.danger,
      textAlign:        'center',
      writingDirection: 'rtl',
    },
    retryBtn: {
      marginTop:         8,
      paddingVertical:   10,
      paddingHorizontal: 20,
      backgroundColor:   colors.accent,
      borderRadius:      radius.sm,
    },
    retryBtnText: { fontSize: 14, fontFamily: fonts.bold, color: '#fff' },

    pageNav: {
      flexDirection:   'row',
      alignItems:      'center',
      justifyContent:  'center',
      paddingVertical: 12,
      gap:             18,
    },
    pageNavBtn: {
      width:           38,
      height:          38,
      borderRadius:    19,
      backgroundColor: colors.bgSurface,
      borderWidth:     1,
      borderColor:     colors.border,
      alignItems:      'center',
      justifyContent:  'center',
    },
    pageNavBtnOff: { opacity: 0.35 },
    pageNavArrow:  { fontSize: 22, color: colors.inkDark, fontFamily: fonts.bold, lineHeight: 28 },
    pageNavLabel:  { fontSize: 15, fontFamily: fonts.semiBold, color: colors.inkMid },

    panel: {
      width:             '100%',
      backgroundColor:   colors.bgSurface,
      borderTopWidth:    StyleSheet.hairlineWidth,
      borderTopColor:    colors.border,
      paddingHorizontal: 16,
      paddingTop:        12,
      paddingBottom:     20,
      gap:               10,
      marginTop:         8,
    },

    backRow: { alignItems: 'flex-start' },
    backText: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.inkLight,
      writingDirection: 'rtl',
    },

    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius:    radius.md,
      paddingVertical: 15,
      alignItems:      'center',
      shadowColor:     colors.accent,
      shadowOffset:    { width: 0, height: 3 },
      shadowOpacity:   0.28,
      shadowRadius:    8,
      elevation:       5,
    },
    primaryBtnText: { fontSize: 16, fontFamily: fonts.bold, color: '#fff', writingDirection: 'rtl' },

    secondaryRow: { flexDirection: 'row', gap: 10 },
    secondaryBtn: {
      flex:            1,
      paddingVertical: 13,
      borderRadius:    radius.md,
      borderWidth:     1.5,
      borderColor:     colors.border,
      alignItems:      'center',
      backgroundColor: colors.bgSurface,
    },
    secondaryBtnText: { fontSize: 14, fontFamily: fonts.semiBold, color: colors.inkDark, writingDirection: 'rtl' },

    btnPressed:  { opacity: 0.75, transform: [{ scale: 0.97 }] },
    btnDisabled: { opacity: 0.45 },

    modeToggleRow: {
      flexDirection:   'row',
      marginHorizontal: FRAME_MH,
      marginTop:        4,
      marginBottom:     4,
      borderRadius:     radius.md,
      borderWidth:      1,
      borderColor:      colors.border,
      overflow:         'hidden' as const,
      backgroundColor:  colors.bgSurface,
    },
    modeBtn: {
      flex:            1,
      paddingVertical: 11,
      alignItems:      'center' as const,
      justifyContent:  'center' as const,
      minHeight:       42,
    },
    modeBtnActive:     { backgroundColor: colors.accent },
    modeBtnText: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.inkMid,
      writingDirection: 'rtl' as const,
    },
    modeBtnTextActive: { color: '#fff' },
  });
}
