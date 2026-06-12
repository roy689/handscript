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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useExitInterstitial }         from '../src/hooks/useExitInterstitial';

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
  const timer = setTimeout(() => controller.abort(), 300_000); // 300s (5min) — large documents need more time

  // Debug: log exactly what we're sending so sync issues can be diagnosed from Railway logs
  console.log('[FinalView] fetchBothModes → background=%s inkColor=%s', background, inkColor);

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
          letter_spacing:  style.letterSpacing * 0.30 - 8,       // -8..22 px (negative = overlap at min)
          word_spacing:    Math.round(style.wordSpacing * 0.85),  // 0–85 px (0 = words touch)
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

interface FinalizeResult {
  ok: boolean;
  expired: boolean;
  cleanUrls: string[];
  photoUrls: string[];
}

/**
 * Promote an already-rendered preview to a permanent deliverable.
 *
 * Sends the temporary static page URLs back to the server, which copies the
 * EXACT same bytes to Firebase Storage (no re-render → pixel-identical to what
 * the user approved) and counts the conversion against the daily limit.
 *
 * Returns ok=false, expired=true when the source files are gone (container
 * restart / cleanup) so the caller can fall back to a full re-render.
 */
async function finalizeRender(
  cleanUrls: string[],
  photoUrls: string[],
): Promise<FinalizeResult> {
  const token  = await getAuthToken();
  const userId = getCurrentUserId();
  if (!userId) throw new Error('משתמש לא מחובר');

  const res = await fetch(`${BACKEND_URL}/finalize`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user_id: userId, clean_urls: cleanUrls, photo_urls: photoUrls }),
  });

  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? 'הגעת למגבלת ההמרות היומית');
  }
  if (!res.ok) throw new Error(`שגיאת שרת (${res.status})`);

  const data = await res.json() as {
    ok: boolean; expired?: boolean;
    clean_urls?: string[]; photo_urls?: string[];
  };
  return {
    ok:        !!data.ok,
    expired:   !!data.expired,
    cleanUrls: data.clean_urls ?? [],
    photoUrls: data.photo_urls ?? [],
  };
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

/**
 * Build a PDF from already-downloaded local file URIs.
 * Callers must pre-download pages via getLocalUri() so this function
 * never hits the network — it only reads from the local file system.
 */
async function buildPdfFromLocalUris(localUris: string[]): Promise<string> {
  const base64Pages = await Promise.all(
    localUris.map(uri =>
      FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
    ),
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
    object-fit: contain;
    background: #ffffff;
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
  const { text, background, glyphMap: _glyphMap, style: gs, inkColor, previewUrls } = route.params;
  const { width: W } = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);
  useExitInterstitial(navigation);  // show interstitial when leaving the result

  // If PreviewScreen already rendered this document, use those URLs directly.
  // This guarantees preview = final output with zero additional server latency.
  const hasPreviewUrls = !!previewUrls?.clean?.length && !!previewUrls?.photo?.length;

  // Both modes fetched together on mount — switching is always instant
  const [cleanUrls,  setCleanUrls]  = useState<string[]>(hasPreviewUrls ? previewUrls!.clean : []);
  const [photoUrls,  setPhotoUrls]  = useState<string[]>(hasPreviewUrls ? previewUrls!.photo : []);
  const [pageUrls,   setPageUrls]   = useState<string[]>(hasPreviewUrls ? previewUrls!.clean : []);
  const [isLoading,  setIsLoading]  = useState(!hasPreviewUrls);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0); // increment to trigger re-fetch
  const [scanMode,   setScanMode]   = useState<'clean' | 'photo'>('clean');
  const [currentPage, setCurrentPage] = useState(0);

  const [savingGallery, setSavingGallery] = useState(false);
  const [savingShare,   setSavingShare]   = useState(false);
  const [savingPdf,     setSavingPdf]     = useState(false);
  const [imageLoading,  setImageLoading]  = useState(true);

  // When the preview source files have expired server-side, we force a full
  // re-render (the slow path below) to obtain a persistent, usage-counted file.
  const [needsFullRender, setNeedsFullRender] = useState(false);

  // ── Finalize tracking ─────────────────────────────────────────────────────
  // In the fast path the screen shows the temporary preview render immediately,
  // then promotes those exact bytes to permanent Firebase URLs in the
  // background. Export actions await this so they always persist a permanent
  // file. Refs hold the freshest URL set so a handler created before the swap
  // still reads the permanent URLs after awaiting.
  const finalizePromiseRef = useRef<Promise<void> | null>(null);
  const cleanUrlsRef = useRef<string[]>(cleanUrls);
  const photoUrlsRef = useRef<string[]>(photoUrls);
  const scanModeRef  = useRef<'clean' | 'photo'>('clean');

  // ── #11 Local URI cache — avoids re-downloading pages on every export ─────
  // Maps remote Firebase URL → already-downloaded local file URI.
  // Populated lazily on first save/share/PDF action; reused on subsequent ones.
  const localUriCacheRef = useRef<Record<string, string>>({});

  const getLocalUri = useCallback(async (remoteUrl: string): Promise<string> => {
    const cached = localUriCacheRef.current[remoteUrl];
    if (cached) {
      // Verify the cached file still exists (cache dir can be cleared by the OS)
      const info = await FileSystem.getInfoAsync(cached);
      if (info.exists) return cached;
    }
    const uri = await downloadToCache(remoteUrl);
    localUriCacheRef.current[remoteUrl] = uri;
    return uri;
  }, []);

  // Cycling loading messages shown while both modes are being prepared
  const LOADING_MESSAGES = [
    'מכין את כתב היד שלך...',
    'מעבד את האותיות...',
    'מפתח סריקה נקייה...',
    'מוסיף אפקט צילום...',
    'כמעט מוכן...',
  ];
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const msgIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isLoading) {
      msgIntervalRef.current = setInterval(() => {
        setLoadingMsgIdx(i => (i + 1) % LOADING_MESSAGES.length);
      }, 2200);
    } else {
      if (msgIntervalRef.current) {
        clearInterval(msgIntervalRef.current);
        msgIntervalRef.current = null;
      }
    }
    return () => {
      if (msgIntervalRef.current) clearInterval(msgIntervalRef.current);
    };
  }, [isLoading]);

  const placeholderH = Math.round((W - 2 * FRAME_MH) * A4_RATIO);

  // When previewUrls were passed, warm the image cache so clean↔photo switching is instant.
  useEffect(() => {
    if (!hasPreviewUrls) return;
    const allUrls = [...previewUrls!.clean, ...previewUrls!.photo];
    allUrls.forEach(url => Image.prefetch(absUrl(url)).catch(() => null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep refs in sync with the freshest URL set + mode for the export handlers.
  useEffect(() => { cleanUrlsRef.current = cleanUrls; }, [cleanUrls]);
  useEffect(() => { photoUrlsRef.current = photoUrls; }, [photoUrls]);
  useEffect(() => { scanModeRef.current  = scanMode;  }, [scanMode]);

  // ── Background finalize (fast path only) ──────────────────────────────────
  // Promote the temporary preview render to permanent Firebase URLs without
  // re-rendering. Runs once on mount. The displayed image does not change
  // (identical bytes); only the underlying URLs are swapped to permanent ones.
  useEffect(() => {
    if (!hasPreviewUrls) return;   // slow path already persists + counts usage

    let cancelled = false;
    const run = (async () => {
      try {
        const result = await finalizeRender(previewUrls!.clean, previewUrls!.photo);
        if (cancelled) return;

        if (result.ok && result.cleanUrls.length && result.photoUrls.length) {
          // Warm the cache for the permanent URLs, then swap so there's no flash.
          await Promise.all(
            [...result.cleanUrls, ...result.photoUrls]
              .map(u => Image.prefetch(absUrl(u)).catch(() => null)),
          );
          if (cancelled) return;
          setCleanUrls(result.cleanUrls);
          setPhotoUrls(result.photoUrls);
          setPageUrls(scanModeRef.current === 'photo' ? result.photoUrls : result.cleanUrls);
        } else if (result.expired) {
          // Source files gone (container restart / cleanup) — re-render a fresh,
          // persistent document via the slow path below.
          if (!cancelled) setNeedsFullRender(true);
        }
      } catch {
        // Network/limit error — keep showing the temporary render. The static
        // files are still valid right now, so save/share continues to work.
      }
    })();
    finalizePromiseRef.current = run;

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch both clean and photo together — screen shows only after both are ready.
  // Skipped entirely when previewUrls were passed from PreviewScreen (fast path).
  useEffect(() => {
    // Skip while we still trust the preview render. Runs when there were no
    // preview URLs at all, OR when finalize reported them expired and we must
    // produce a fresh persistent document.
    if (hasPreviewUrls && !needsFullRender) return;

    let cancelled = false;
    // Reset on retry
    setIsLoading(true);
    setFetchError(null);

    // ── UI-level safety timeout ────────────────────────────────────────────────
    // Guarantees that the loading state resolves regardless of what happens to
    // the fetch API — catches cases where AbortError is not surfaced by certain
    // React Native / device combinations.
    // Set to 310 s (10 s more than the 300 s fetch timeout in fetchBothModes)
    // so the fetch's own more-specific timeout message appears first in the normal case.
    const uiTimeoutId = setTimeout(() => {
      if (!cancelled) {
        setFetchError('יצירת הכתב היד לוקחת יותר מדי זמן. נסה עם טקסט קצר יותר או בדוק את החיבור לאינטרנט.');
        setIsLoading(false);
      }
    }, 310_000);

    (async () => {
      try {
        const userId = getCurrentUserId();
        if (!userId) { setFetchError('יש להתחבר תחילה'); setIsLoading(false); return; }

        // Retry once on transient network errors — the operation is idempotent.
        // The server generates fresh files each call so a retry is always safe.
        let lastFetchErr: unknown;
        let fetchResult: { cleanUrls: string[]; photoUrls: string[] } | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            fetchResult = await fetchBothModes(text, background, gs, inkColor);
            break;
          } catch (e) {
            lastFetchErr = e;
            if (attempt < 1) await new Promise<void>(r => setTimeout(r, 2000));
          }
        }
        if (!fetchResult) throw lastFetchErr;
        const { cleanUrls: clean, photoUrls: photo } = fetchResult;
        if (cancelled) return;

        // Reveal the screen immediately — don't block on prefetch.
        // We fire prefetch in the background (fire-and-forget) with a per-URL
        // timeout so a stalled Firebase CDN connection never hangs the UI.
        // Previously this was `await Promise.all(prefetch...)` which caused
        // the screen to stay in the loading state indefinitely when any single
        // Firebase URL was slow to respond.
        setCleanUrls(clean);
        setPhotoUrls(photo);
        setPageUrls(clean);
        setIsLoading(false);   // ← reveal the screen NOW, prefetch runs behind

        // Background prefetch: warm the React Native image cache for instant
        // clean↔photo mode switches. Each call is guarded by a 12 s timeout
        // so a slow URL never hangs the warm-up indefinitely.
        const prefetchWithTimeout = (url: string): Promise<void> =>
          new Promise(resolve => {
            const t = setTimeout(resolve, 12_000);   // give up after 12 s
            Image.prefetch(absUrl(url))
              .then(() => { clearTimeout(t); resolve(); })
              .catch(() => { clearTimeout(t); resolve(); });
          });
        Promise.all([...clean, ...photo].map(prefetchWithTimeout)).catch(() => null);

      } catch (e: unknown) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : 'שגיאה בטעינת הדף');
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(uiTimeoutId);
    };
  }, [retryCount, needsFullRender]);

  const totalPages = pageUrls.length;

  // Toggle between modes — instant, both already pre-fetched.
  // currentPage is preserved so the user stays on the same page they were viewing.
  const handleSwitchMode = useCallback((mode: 'clean' | 'photo') => {
    if (mode === scanMode || isLoading) return;
    if (mode === 'clean') {
      setScanMode('clean');
      setPageUrls(cleanUrls);
    } else {
      setScanMode('photo');
      setPageUrls(photoUrls);
    }
  }, [scanMode, isLoading, cleanUrls, photoUrls]);

  // Resolve the URL set to export. Awaits the background finalize so the file
  // we persist is the permanent Firebase copy, then reads the freshest URLs
  // for the currently selected mode from refs (handler may have been created
  // before the swap). Falls back to the live pageUrls if finalize never ran.
  const getExportUrls = useCallback(async (): Promise<string[]> => {
    try { await finalizePromiseRef.current; } catch { /* keep temporary URLs */ }
    const urls = scanModeRef.current === 'photo' ? photoUrlsRef.current : cleanUrlsRef.current;
    return urls.length ? urls : pageUrls;
  }, [pageUrls]);

  // ── Save to gallery — what is shown = what is saved (permanent after finalize)
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
      const urls = await getExportUrls();
      for (const url of urls) {
        const localUri = await getLocalUri(url);   // cached — no re-download
        await MediaLibrary.saveToLibraryAsync(localUri);
      }
      showAlert('נשמר!', urls.length > 1 ? `${urls.length} עמודים נשמרו לגלריה` : 'התמונה נשמרה לגלריה');
    } catch (e: unknown) {
      showAlert('שגיאה', e instanceof Error ? e.message : 'שמירה נכשלה');
    } finally {
      setSavingGallery(false);
    }
  }, [pageUrls, getLocalUri, getExportUrls]);

  // ── Share — persists permanent file after finalize
  const handleShare = useCallback(async () => {
    if (!pageUrls.length) return;
    setSavingShare(true);
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) { showAlert('שיתוף לא זמין', 'המכשיר אינו תומך בשיתוף'); return; }

      const urls = await getExportUrls();
      const firstUrl = urls[0];
      if (urls.length === 1 && firstUrl) {
        const localUri = await getLocalUri(firstUrl);  // cached — no re-download
        await Sharing.shareAsync(localUri, { mimeType: 'image/png', dialogTitle: 'שתף כתב יד' });
      } else {
        // buildPdf uses getLocalUri internally — reuses already-downloaded files
        const localUris = await Promise.all(urls.map(getLocalUri));
        const pdfUri = await buildPdfFromLocalUris(localUris);
        await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf', dialogTitle: 'שתף כתב יד (PDF)' });
      }
    } catch (e: unknown) {
      showAlert('שגיאה', e instanceof Error ? e.message : 'שיתוף נכשל');
    } finally {
      setSavingShare(false);
    }
  }, [pageUrls, getLocalUri, getExportUrls]);

  // ── Export to PDF — reuses cached local URIs, no re-download
  const handleExportPdf = useCallback(async () => {
    if (!pageUrls.length) return;
    setSavingPdf(true);
    try {
      const urls = await getExportUrls();
      const localUris = await Promise.all(urls.map(getLocalUri));
      const pdfUri = await buildPdfFromLocalUris(localUris);
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
  }, [pageUrls, getLocalUri, getExportUrls]);

  // Reset imageLoading only when the page changes. Mode switches are instant
  // because both the clean and photo layers are already mounted and decoded.
  useEffect(() => { setImageLoading(true); }, [currentPage]);

  const isBusy = savingGallery || savingShare || savingPdf;

  // ── RENDER ─────────────────────────────────────────────────────────────────

  // Full-screen loading — shown while BOTH clean and photo modes are being prepared.
  // Only after both are ready does the user see the results.
  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.fullScreenLoader}>
          {/* Animated ink-drop ring */}
          <View style={styles.loaderRing}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
          <Text style={styles.loaderTitle}>{LOADING_MESSAGES[loadingMsgIdx]}</Text>
          <Text style={styles.loaderSub}>
            מכין סריקה נקייה ומראה צילום{'\n'}זה עשוי לקחת כמה שניות
          </Text>
          {/* Progress dots */}
          <View style={styles.loaderDots}>
            {LOADING_MESSAGES.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.loaderDot,
                  i === loadingMsgIdx && styles.loaderDotActive,
                ]}
              />
            ))}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* ── PAGE IMAGE ────────────────────────────────────────────────── */}
        <View style={styles.frameShadow}>
          <View style={styles.frameClip}>
            {fetchError ? (
              <View style={[styles.loadingBox, { height: placeholderH }]}>
                <Text style={styles.errorText}>{fetchError}</Text>
                <Pressable style={styles.retryBtn} onPress={() => setRetryCount(c => c + 1)}>
                  <Text style={styles.retryBtnText}>נסה שוב</Text>
                </Pressable>
                <Pressable style={[styles.retryBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border }]}
                  onPress={() => navigation.goBack()}>
                  <Text style={[styles.retryBtnText, { color: colors.inkMid }]}>חזור לעריכה</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ aspectRatio: 210 / 297 }}>
                {/* Both layers are mounted and decoded up front. Switching modes
                    only toggles opacity, so מראה צילום appears instantly with no
                    load delay. */}
                <Image
                  source={{ uri: absUrl(cleanUrls[currentPage] ?? '') }}
                  style={[StyleSheet.absoluteFill, { opacity: scanMode === 'clean' ? 1 : 0 }]}
                  resizeMode="stretch"
                  onLoadStart={() => { if (scanMode === 'clean') setImageLoading(true); }}
                  onLoadEnd={() => { if (scanMode === 'clean') setImageLoading(false); }}
                />
                <Image
                  source={{ uri: absUrl(photoUrls[currentPage] ?? '') }}
                  style={[StyleSheet.absoluteFill, { opacity: scanMode === 'photo' ? 1 : 0 }]}
                  resizeMode="stretch"
                  onLoadStart={() => { if (scanMode === 'photo') setImageLoading(true); }}
                  onLoadEnd={() => { if (scanMode === 'photo') setImageLoading(false); }}
                />
                {imageLoading && (
                  <View style={styles.imageLoadingOverlay}>
                    <ActivityIndicator size="large" color={colors.accent} />
                  </View>
                )}
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

    // ── Full-screen loading overlay ──────────────────────────────────────────
    fullScreenLoader: {
      flex:            1,
      alignItems:      'center',
      justifyContent:  'center',
      backgroundColor: colors.bgPage,
      paddingHorizontal: 36,
      gap:             20,
    },
    loaderRing: {
      width:           80,
      height:          80,
      borderRadius:    40,
      backgroundColor: colors.accentLight,
      alignItems:      'center',
      justifyContent:  'center',
    },
    loaderTitle: {
      fontSize:         20,
      fontFamily:       fonts.bold,
      color:            colors.inkDark,
      textAlign:        'center',
      writingDirection: 'rtl',
    },
    loaderSub: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      textAlign:        'center',
      writingDirection: 'rtl',
      lineHeight:       20,
    },
    loaderDots: {
      flexDirection: 'row',
      gap:           8,
      marginTop:     8,
    },
    loaderDot: {
      width:        7,
      height:       7,
      borderRadius: 3.5,
      backgroundColor: colors.border,
    },
    loaderDotActive: {
      backgroundColor: colors.accent,
      transform:       [{ scale: 1.3 }],
    },

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

    imageLoadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.bgPage,
      alignItems:      'center',
      justifyContent:  'center',
    },

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
