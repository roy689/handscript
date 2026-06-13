/**
 * PreviewScreen — live handwriting preview with A4-proportioned notebook.
 *
 * Page geometry mirrors the Python backend exactly so what you see here
 * is what the server will render:
 *   • A4 aspect ratio  (297/210)
 *   • Ruled / grid / blank backgrounds with server-proportional spacing
 *   • 16 text lines per page  (= server's render_full_page capacity)
 *   • Red margin line at the same relative position as the server margin
 */

import React, {
  useState, useCallback, useEffect, useMemo, useRef,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage    from '@react-native-async-storage/async-storage';
import Slider           from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList }     from '../navigation/types';
import { fonts, radius }               from '../src/theme';
import { useTheme, type ThemeColors }  from '../src/contexts/ThemeContext';
import { BACKEND_URL, MAX_TEXT_LEN }   from '../src/config';
import { impactLight }                 from '../src/utils/haptics';
import { fetchJSON, getAuthToken }      from '../src/utils/api';
import { getCurrentUserId }            from '../src/services/auth';
import LayoutCompositor, { type LayoutJSON, type LayoutPage } from '../components/LayoutCompositor';

const DRAFT_KEY = 'preview_draft';

// Shared sanitize utility — same invisible Unicode ranges as EditorScreen.
// Strip the same invisible Unicode ranges as EditorScreen's INVISIBLE_RE
const PREVIEW_INVISIBLE_RE = /[​-‏‪-‮⁠-⁯﻿]/g;
const sanitizeInvisible = (s: string) => s.replace(PREVIEW_INVISIBLE_RE, '');

type Props = NativeStackScreenProps<RootStackParamList, 'Preview'>;

// ── Types ─────────────────────────────────────────────────────────────────────

type InkColor  = 'black' | 'blue' | 'red';
type PageBg    = 'lines' | 'grid' | 'blank';

// All slider values are 0-100 (display units). Conversion to backend px happens in FinalViewScreen.
// SINGLE SOURCE OF TRUTH for the formulas — keep in sync with FinalViewScreen.tsx
// and this screen's own /convert-both call:
interface HandwritingStyle {
  charHeight:     number;  // 0-100 → char_height     = 40 + s*0.9   (40…130 backend px)
  letterSpacing:  number;  // 0-100 → letter_spacing  = s*0.30 - 8   (-8…+22 px, negative = overlap)
  wordSpacing:    number;  // 0-100 → word_spacing    = s*0.85       (0…85 px, 0 = words touch)
  baselineJitter: number;  // 0-100 → baseline_jitter = s*0.25       (0…25 % σ of char height)
  slant:          number;  // 0-100 → slant           = s*0.4        (0…40 px line-tilt)
  inkBlobs:       number;  // 0-100 → ink_blobs       = s*0.003      (0…0.30 blob probability)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN_H  = 14;   // horizontal margin around notebook on screen
const NOTEBOOK_HPAD  = 14;   // padding inside notebook (left+right)

// Server-side page geometry (A4 @ 300 DPI) — used as ratio source
const SRV_PAGE_W      = 2480;
const SRV_PAGE_H      = 3508;
const SRV_TOP_MARGIN  = 200;   // top margin — text AND background lines start here
const SRV_LINE_H      = 184;   // line pitch = _LINE_HEIGHT(180) + _LINE_GAP(4) in layout.py
const SRV_LINES_SPACING = 180; // background ruled-line interval in layout.py (_LINES_SPACING)
const SRV_SIDE_MARGIN = 200;   // left/right margin for text

// A4 height/width ratio
const A4_RATIO = 297 / 210;

// Slider (0-100) → backend px conversion factors (used in FinalViewScreen too)
// charHeight   : backend = 40 + slider * 0.9   (range 40–130 px)
// letterSpacing: backend = slider * 0.30 - 8   (range  -8–+22 px, negative = overlap)
// wordSpacing  : backend = slider * 0.85       (range   0–85 px)
// baselineJitter: backend = slider * 0.25      (range  0–25 %)
// slant        : backend = slider * 0.4        (range  0–40 px line-tilt)
// inkBlobs     : backend = slider * 0.003      (range  0–0.30)
//
// Server-side clamps (synthesizer.py): letter spacing floored at -25% of the
// average glyph width; the canvas applies the same clamp (see lsp below).
// Server-side threshold (layout.py): line tilt is skipped when slant_px ≤ 0.5;
// the canvas applies the same threshold (see slantPx below).

// Notebook visual colours
const NOTEBOOK_BG       = '#FAFAF8';
const RULE_COLOR        = '#BAD3E8';   // blue-grey ruled lines (Clairefontaine style)
const GRID_COLOR        = '#C8C8C8';   // slightly lighter for grid
const MARGIN_LINE_COLOR = '#F2AAAA';   // classic red margin line

const INK_COLORS: Record<InkColor, string> = {
  black: '#1C1C1E',
  blue:  '#1A4FC4',
  red:   '#C9271A',
};
const INK_LABELS: Record<InkColor, string> = {
  black: 'שחור', blue: 'כחול', red: 'אדום',
};
const BG_LABELS: Record<PageBg, string> = {
  lines: 'שורות', grid: 'משבצות', blank: 'חלק',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function absUrl(url: string): string {
  return url.startsWith('http') ? url : `${BACKEND_URL}${url}`;
}

// ── Notebook page component ────────────────────────────────────────────────────

/**
 * Renders a realistic notebook page background with:
 *  - Horizontal ruled lines  (every bgLineH px, starting from topM)
 *  - Vertical grid lines     (same pitch as ruled lines → square cells)
 *  - Red margin line         (at marginLineX from right edge)
 * All measurements are derived from A4 proportions matching the server.
 *
 * bgLineH (= SRV_LINES_SPACING scaled, 180 server px) is intentionally
 * different from lineH (= SRV_LINE_H scaled, 184 server px).  Text advances
 * every 184 server px, so it gradually drifts below ruled lines — exactly as
 * in the final server-rendered output.
 */
function NotebookPage({
  pageW, pageH, lineH, bgLineH, topM, marginLineX, pageBg, children,
}: {
  pageW: number; pageH: number;
  lineH: number; bgLineH: number; topM: number; marginLineX: number;
  pageBg: PageBg; children: React.ReactNode;
}) {
  // Background lines use bgLineH (180-based) so spacing matches layout.py.
  const hLines: number[] = [];
  for (let y = topM; y < pageH; y += bgLineH) hLines.push(y);

  // Vertical grid lines: same pitch as horizontal for square cells.
  const vLines: number[] = [];
  if (pageBg === 'grid') {
    for (let x = bgLineH; x < pageW; x += bgLineH) vLines.push(x);
  }

  return (
    <View style={{ width: pageW, height: pageH, backgroundColor: NOTEBOOK_BG }}>

      {/* Horizontal lines (rules / grid) */}
      {pageBg !== 'blank' && hLines.map((top, i) => (
        <View
          key={`h${i}`}
          style={{
            position:        'absolute',
            top,
            left:            0,
            right:           0,
            height:          1,
            backgroundColor: pageBg === 'grid' ? GRID_COLOR : RULE_COLOR,
          }}
        />
      ))}

      {/* Vertical grid lines */}
      {vLines.map((left, i) => (
        <View
          key={`v${i}`}
          style={{
            position:        'absolute',
            top:             0,
            bottom:          0,
            left,
            width:           1,
            backgroundColor: GRID_COLOR,
          }}
        />
      ))}

      {/* Red margin line — always present (even on blank) */}
      <View
        style={{
          position:        'absolute',
          top:             0,
          bottom:          0,
          right:           marginLineX,
          width:           1.5,
          backgroundColor: MARGIN_LINE_COLOR,
        }}
        pointerEvents="none"
      />

      {children}
    </View>
  );
}

// ── Slider row ────────────────────────────────────────────────────────────────

/** Field-by-field equality — used to skip no-op commits (tap without drag). */
function styleEquals(a: HandwritingStyle, b: HandwritingStyle): boolean {
  return a.charHeight     === b.charHeight
    &&   a.letterSpacing  === b.letterSpacing
    &&   a.wordSpacing    === b.wordSpacing
    &&   a.baselineJitter === b.baselineJitter
    &&   a.slant          === b.slant
    &&   a.inkBlobs       === b.inkBlobs;
}

/**
 * One labelled slider. Keeps its displayed value in LOCAL state so the number
 * tracks the thumb on every frame (no 80ms throttle lag) without re-rendering
 * the whole screen. Canvas updates still flow through the parent's throttle.
 */
const PreviewSliderRow = React.memo(function PreviewSliderRow({
  id, label, value, styles, accentColor, borderColor, onLiveChange, onComplete,
}: {
  id:           keyof HandwritingStyle;
  label:        string;
  value:        number;
  styles:       ReturnType<typeof getStyles>;
  accentColor:  string;
  borderColor:  string;
  onLiveChange: (id: keyof HandwritingStyle, v: number) => void;
  onComplete:   (id: keyof HandwritingStyle, v: number) => void;
}) {
  const [display, setDisplay] = useState(value);
  // Re-sync when the committed value changes externally (e.g. draft restore).
  useEffect(() => { setDisplay(value); }, [value]);

  return (
    <View style={styles.sliderHalf}>
      <View style={styles.sliderHeader}>
        <Text style={styles.sliderLabel}>{label}</Text>
        <Text style={styles.sliderValue}>{Math.round(display)}</Text>
      </View>
      <Slider
        style={styles.sliderControl}
        minimumValue={0} maximumValue={100} step={1}
        value={value}
        onValueChange={v => { setDisplay(v); onLiveChange(id, v); }}
        onSlidingComplete={v => { setDisplay(v); onComplete(id, v); }}
        minimumTrackTintColor={accentColor}
        maximumTrackTintColor={borderColor}
        thumbTintColor={accentColor}
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(display) }}
      />
    </View>
  );
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PreviewScreen({ navigation, route }: Props) {
  const {
    text, glyphMap, style: initStyle,
    inkColor: initInkColor, background: initBg,
  } = route.params;

  const { width: W } = useWindowDimensions();
  const { colors }   = useTheme();
  const styles       = useMemo(() => getStyles(colors), [colors]);

  // ── Page geometry (A4-proportioned, matches server) ───────────────────────
  const notebookW    = W - 2 * PAGE_MARGIN_H;
  const pageH        = Math.round(notebookW * A4_RATIO);
  // lineH  = text-line advance pitch (180 content + 4 gap = 184 server px).
  // bgLineH = background ruled-line interval (180 server px, no gap).
  // Keeping them separate means text gradually drifts below ruled lines as
  // it does in the server render — exactly matching the final output.
  const lineH        = Math.round(pageH * SRV_LINE_H       / SRV_PAGE_H);
  const bgLineH      = Math.round(pageH * SRV_LINES_SPACING / SRV_PAGE_H);
  const topM         = Math.round(pageH * SRV_TOP_MARGIN / SRV_PAGE_H);
  const marginLineX  = Math.round(notebookW * SRV_SIDE_MARGIN / SRV_PAGE_W);

  // Convert initStyle (backend px units) → 0-100 slider values.
  // Inverse of FinalViewScreen formulas:
  //   letterSpacing: backend = slider*0.30-8  → slider = (backend+8)/0.30
  //   wordSpacing:   backend = slider*0.85    → slider = backend/0.85
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const [hs, setHs] = useState<HandwritingStyle>({
    charHeight:     clamp((initStyle.charHeight - 40) / 0.9),        // 85→50
    letterSpacing:  clamp((initStyle.letterSpacing + 8) / 0.30),     // maps backend px → slider
    wordSpacing:    clamp(initStyle.wordSpacing / 0.85),              // 35→41 (natural)
    baselineJitter: clamp(initStyle.baselineJitter / 0.25),          // 3→12
    slant:          15,   // slight natural lean by default
    inkBlobs:       10,   // subtle blob effect by default
  });

  // Mutable text — all edits allowed; chars not in bank show as computer font
  const [editableText,    setEditableText]    = useState(text);
  const [editMode,        setEditMode]        = useState(false);
  // Mutable glyphMap — grows as the user types chars not in the original text
  const [liveGlyphMap,    setLiveGlyphMap]    = useState<Record<string, string[]>>(glyphMap);

  const handleEditText = useCallback((newT: string) => {
    setEditableText(sanitizeInvisible(newT));
  }, []);

  // When editableText changes, fetch glyph URLs for any characters
  // that are not yet in liveGlyphMap (e.g. newly typed characters).
  // Debounced 400 ms so rapid typing batches into a single request
  // instead of firing one /glyphs call per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      const userId = getCurrentUserId();
      if (!userId) return;

      // Collect unique non-whitespace chars that have no entry in the current map
      const missing = [...new Set(editableText.split(''))]
        .filter(ch => ch.trim() && !liveGlyphMap[ch]);

      if (missing.length === 0) return;

      let cancelled = false;
      (async () => {
        try {
          const data = await fetchJSON<{ glyphs: Record<string, string[]> }>(
            `${BACKEND_URL}/glyphs`,
            {
              method: 'POST',
              body: JSON.stringify({ text: missing.join(''), user_id: userId }),
            },
          );
          if (cancelled) return;
          // Merge new glyph URLs into the live map
          const newEntries: Record<string, string[]> = {};
          for (const [ch, urls] of Object.entries(data.glyphs ?? {})) {
            const valid = (urls ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0);
            if (valid.length > 0) newEntries[ch] = valid;
          }
          if (Object.keys(newEntries).length > 0) {
            setLiveGlyphMap(prev => ({ ...prev, ...newEntries }));
            // Prefetch newly loaded images
            Object.values(newEntries).flat().forEach(u => Image.prefetch(absUrl(u)).catch(() => null));
          }
        } catch {
          // Silently ignore — missing chars will stay as computer font
        }
      })();
      return () => { cancelled = true; };
    }, 400);
    return () => clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableText]);

  const [inkColor, setInkColor] = useState<InkColor>(initInkColor ?? 'black');
  const [pageBg,   setPageBg]   = useState<PageBg>((initBg as PageBg) ?? 'lines');
  const [currentPage, setCurrentPage] = useState(0);

  // ── Phase 4: LayoutCompositor state ─────────────────────────────────────────
  // layoutData: /layout response — drives LayoutCompositor during drag and when
  // serverPreviewUrls is absent (initial load / after style change debounce).
  const [layoutData,      setLayoutData]      = useState<LayoutJSON | null>(null);
  const [isLayoutLoading, setIsLayoutLoading] = useState(false);
  // renderHash / usedSeed: returned by /convert-both; passed to FinalViewScreen
  // so /finalize can use the Phase 3 GCS server-side copy path instead of re-upload.
  const [renderHash, setRenderHash] = useState<string | null>(null);
  const [usedSeed,   setUsedSeed]   = useState<number | null>(null);
  const layoutAbortRef    = useRef<AbortController | null>(null);
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // liveHs: drives the canvas during slider drag (throttled updates)
  const [liveHs,     setLiveHs]     = useState<HandwritingStyle>(hs);
  const [isDragging, setIsDragging] = useState(false);
  // Refs for throttle — avoids stale closures without extra renders
  const pendingHsRef  = useRef<HandwritingStyle>(hs);
  const throttleRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Safety net for cancelled gestures: if onSlidingComplete never fires
  // (gesture interrupted — happens on Android), commit after 1.5s of silence
  // so isDragging can't get stuck true (which would hide the server preview).
  const dragSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Slider handlers (stable identities so PreviewSliderRow can memo) ──────
  const handleSliderLive = useCallback((id: keyof HandwritingStyle, v: number) => {
    pendingHsRef.current = { ...pendingHsRef.current, [id]: v };
    setIsDragging(true);
    // Throttled canvas update — at most one re-render per 80ms during drag.
    if (!throttleRef.current) {
      throttleRef.current = setTimeout(() => {
        setLiveHs({ ...pendingHsRef.current });
        throttleRef.current = null;
      }, 80);
    }
    // (Re)arm the cancelled-gesture safety timer.
    if (dragSafetyRef.current) clearTimeout(dragSafetyRef.current);
    dragSafetyRef.current = setTimeout(() => {
      dragSafetyRef.current = null;
      const cur = { ...pendingHsRef.current };
      setIsDragging(false);
      setLiveHs(cur);
      setHs(prev => (styleEquals(prev, cur) ? prev : cur));
    }, 1500);
  }, []);

  const handleSliderComplete = useCallback((id: keyof HandwritingStyle, v: number) => {
    if (dragSafetyRef.current) { clearTimeout(dragSafetyRef.current); dragSafetyRef.current = null; }
    if (throttleRef.current)   { clearTimeout(throttleRef.current);   throttleRef.current = null; }
    const next = { ...pendingHsRef.current, [id]: v };
    pendingHsRef.current = next;
    setLiveHs(next);
    setIsDragging(false);
    impactLight();
    // No-op commit guard: a tap on the thumb without movement keeps the same
    // hs identity → the server-render effect does NOT fire → no flicker and
    // no wasted /convert-both call.
    setHs(prev => (styleEquals(prev, next) ? prev : next));
  }, []);

  // ── Server background render state ────────────────────────────────────────
  const [serverPreviewUrls, setServerPreviewUrls] = useState<{ clean: string[]; photo: string[] } | null>(null);
  const [isServerRendering, setIsServerRendering] = useState(false);
  // Bumped by handleFinish to force a render when the user taps Finish while
  // idle with no current render (e.g. a previous render failed) — keeps the
  // transition on the fast path instead of a full re-render on FinalView.
  const [renderNonce, setRenderNonce] = useState(0);
  // Drives the Finish button's waiting UI from the first tap, even before the
  // forced render flips isServerRendering — fixes the "nothing happens on the
  // first tap" feel.
  const [isFinishing, setIsFinishing] = useState(false);
  const serverRenderAbortRef    = useRef<AbortController | null>(null);
  const serverRenderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-resort timer: if a forced render never produces URLs, navigate anyway.
  const finishSafetyTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (throttleRef.current)          { clearTimeout(throttleRef.current);          throttleRef.current = null; }
    if (dragSafetyRef.current)        { clearTimeout(dragSafetyRef.current);        dragSafetyRef.current = null; }
    if (draftDebounce.current)        { clearTimeout(draftDebounce.current);        draftDebounce.current = null; }
    if (serverRenderDebounceRef.current) { clearTimeout(serverRenderDebounceRef.current); }
    if (finishSafetyTimerRef.current) { clearTimeout(finishSafetyTimerRef.current); }
    if (layoutDebounceRef.current)    { clearTimeout(layoutDebounceRef.current); }
    serverRenderAbortRef.current?.abort();
    layoutAbortRef.current?.abort();
  }, []);

  // screenScale: server pixels → screen pixels for LayoutCompositor
  // notebookW / SRV_PAGE_W so glyph coords map to the exact same position
  // on the screen as they do in the server-rendered image.
  const screenScale = notebookW / SRV_PAGE_W;

  // ── /layout — geometry-only render (fast, no rasterisation) ─────────────────
  // Called on every liveHs or text change (debounced 120ms) to drive the
  // LayoutCompositor during drag and during the initial-load window before the
  // first /convert-both response arrives.
  useEffect(() => {
    if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
    layoutDebounceRef.current = setTimeout(async () => {
      layoutAbortRef.current?.abort();
      const controller = new AbortController();
      layoutAbortRef.current = controller;

      const userId = getCurrentUserId();
      if (!userId) return;
      const token = await getAuthToken();
      if (controller.signal.aborted) return;

      setIsLayoutLoading(true);
      try {
        const res = await fetch(`${BACKEND_URL}/layout`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            text:    editableText,
            user_id: userId,
            preview: true,
            style: {
              char_height:     Math.round(40 + liveHs.charHeight * 0.9),
              letter_spacing:  liveHs.letterSpacing * 0.30 - 8,
              word_spacing:    Math.round(liveHs.wordSpacing * 0.85),
              baseline_jitter: liveHs.baselineJitter * 0.25,
              slant:           liveHs.slant * 0.4,
              ink_blobs:       liveHs.inkBlobs * 0.003,
            },
          }),
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = await res.json() as LayoutJSON;
        if (controller.signal.aborted) return;
        if (data.ok && data.pages?.length) setLayoutData(data);
      } catch {
        // AbortError or network error — LayoutCompositor retains previous layout
      } finally {
        if (!controller.signal.aborted) setIsLayoutLoading(false);
      }
    }, 120);

    return () => {
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      layoutAbortRef.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableText, liveHs]);

  // Page count: server preview (authoritative) > layout response > 1
  const totalPages = serverPreviewUrls
    ? serverPreviewUrls.clean.length
    : (layoutData?.pages.length ?? 1);

  // Reset to page 0 only when the TEXT changes (pagination genuinely reshuffles).
  // Style/ink/background tweaks keep the user on their current page — resetting
  // on every throttled liveHs update used to yank users back to page 1 while
  // dragging a slider on page 2+. Out-of-bounds indices are handled by the
  // clamp effect below when totalPages shrinks.
  useEffect(() => { setCurrentPage(0); }, [editableText]);
  useEffect(() => {
    setCurrentPage(p => Math.min(p, Math.max(0, totalPages - 1)));
  }, [totalPages]);
  // Keep pendingHsRef in sync whenever hs changes from an external source
  useEffect(() => { pendingHsRef.current = hs; setLiveHs(hs); }, [hs]);

  // ── Draft persistence ──────────────────────────────────────────────────────
  // Saves hs, inkColor, AND pageBg so that going back from FinalView to Preview
  // and pressing Finish again sends the exact same settings the user chose.
  useEffect(() => {
    AsyncStorage.getItem(DRAFT_KEY).then(raw => {
      if (!raw) return;
      try {
        const draft = JSON.parse(raw) as { hs?: HandwritingStyle; inkColor?: InkColor; pageBg?: PageBg };
        if (draft.hs)       { setHs(draft.hs); setLiveHs(draft.hs); pendingHsRef.current = draft.hs; }
        if (draft.inkColor) setInkColor(draft.inkColor);
        if (draft.pageBg)   setPageBg(draft.pageBg);
      } catch {}
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft whenever style, ink color, or background changes (debounced 800ms)
  useEffect(() => {
    if (draftDebounce.current) clearTimeout(draftDebounce.current);
    draftDebounce.current = setTimeout(() => {
      AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ hs, inkColor, pageBg }));
    }, 800);
    return () => { if (draftDebounce.current) clearTimeout(draftDebounce.current); };
  }, [hs, inkColor, pageBg]);

  // Use a ref so handleFinish always reads the CURRENT pageBg
  // without any risk of a stale closure.
  const pageBgRef = useRef<PageBg>(pageBg);
  useEffect(() => { pageBgRef.current = pageBg; }, [pageBg]);

  // ── Background server render (debounced) ───────────────────────────────────
  // Triggered by any committed style change (hs, not liveHs), text, ink, or bg.
  // Calls /convert-both with preview=true (no usage increment) and stores the
  // result in serverPreviewUrls. The render area then shows this exact image
  // so the user sees the REAL final output, not just the canvas approximation —
  // keeping the edit preview and the final document in sync.
  // During slider drag (isDragging) the canvas stays visible for instant feedback.
  useEffect(() => {
    // Stale the current server preview immediately so the canvas reappears
    // while we wait for the new render.
    setServerPreviewUrls(null);

    if (serverRenderDebounceRef.current) clearTimeout(serverRenderDebounceRef.current);

    serverRenderDebounceRef.current = setTimeout(async () => {
      // Cancel any previous in-flight request
      serverRenderAbortRef.current?.abort();
      const controller = new AbortController();
      serverRenderAbortRef.current = controller;

      const userId = getCurrentUserId();
      if (!userId) return;

      const token = await getAuthToken();
      if (controller.signal.aborted) return;

      setIsServerRendering(true);
      try {
        const res = await fetch(`${BACKEND_URL}/convert-both`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            text:       editableText,
            user_id:    userId,
            background: pageBgRef.current,
            ink_color:  inkColor,
            preview:    true,
            style: {
              char_height:     Math.round(40 + hs.charHeight * 0.9),
              letter_spacing:  hs.letterSpacing * 0.30 - 8,
              word_spacing:    Math.round(hs.wordSpacing * 0.85),
              baseline_jitter: hs.baselineJitter * 0.25,
              slant:           hs.slant * 0.4,
              ink_blobs:       hs.inkBlobs * 0.003,
            },
          }),
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = await res.json() as {
          ok: boolean; clean_urls?: string[]; photo_urls?: string[];
          render_hash?: string; seed?: number;
        };
        if (controller.signal.aborted) return;
        if (data.ok && data.clean_urls?.length && data.photo_urls?.length) {
          setServerPreviewUrls({ clean: data.clean_urls, photo: data.photo_urls });
          if (data.render_hash) setRenderHash(data.render_hash);
          if (data.seed != null) setUsedSeed(data.seed);
        }
      } catch {
        // AbortError or network error — canvas stays visible, no error shown
      } finally {
        if (!controller.signal.aborted) setIsServerRendering(false);
      }
    }, 600);

    return () => {
      if (serverRenderDebounceRef.current) clearTimeout(serverRenderDebounceRef.current);
      serverRenderAbortRef.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hs, editableText, inkColor, pageBg, renderNonce]);

  // Guard against double-tap: ref is set synchronously on first press so a
  // second tap within the same JS frame is ignored — no state update needed.
  const isFinishingRef = useRef(false);
  // Set when user taps Finish while a server render is in progress. The
  // auto-navigate effect below navigates as soon as the exact URLs arrive.
  const pendingFinishRef = useRef(false);

  // Mirror serverPreviewUrls into a ref so the finish safety timer reads the
  // latest value rather than the (possibly null) value captured at tap time.
  const serverPreviewUrlsRef = useRef(serverPreviewUrls);
  useEffect(() => { serverPreviewUrlsRef.current = serverPreviewUrls; }, [serverPreviewUrls]);

  // Helper shared by handleFinish and the auto-navigate effect below.
  const doNavigateToFinalView = useCallback((urls: { clean: string[]; photo: string[] } | null) => {
    if (finishSafetyTimerRef.current) { clearTimeout(finishSafetyTimerRef.current); finishSafetyTimerRef.current = null; }
    isFinishingRef.current = true;
    navigation.push('FinalView', {
      text:        editableText,
      background:  pageBgRef.current,
      glyphMap:    liveGlyphMap,
      style:       pendingHsRef.current,
      inkColor,
      previewUrls:  urls ?? undefined,
      // Phase 3 render-cache: /finalize can use GCS server-side copy when these are present.
      renderHash:  renderHash ?? undefined,
      seed:        usedSeed   ?? undefined,
    });
    const unsub = navigation.addListener('focus', () => {
      isFinishingRef.current = false;
      pendingFinishRef.current = false;
      setIsFinishing(false);   // reset waiting UI when the user returns to edit
      unsub();
    });
  }, [navigation, editableText, liveGlyphMap, inkColor, renderHash, usedSeed]);

  // Auto-navigate when the in-progress server render completes and the user
  // already tapped "Finish" while waiting.
  useEffect(() => {
    if (!pendingFinishRef.current || !serverPreviewUrls) return;
    doNavigateToFinalView(serverPreviewUrls);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPreviewUrls]);

  const handleFinish = useCallback(() => {
    if (isFinishingRef.current || pendingFinishRef.current) return;   // drop duplicate taps

    // Flush any pending throttle so hs is fully up-to-date.
    // styleEquals guard: an unchanged flush must keep the same hs identity,
    // otherwise the render effect re-fires and nulls serverPreviewUrls right
    // as we try to take the fast path with it.
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
      const cur = { ...pendingHsRef.current };
      setHs(prev => (styleEquals(prev, cur) ? prev : cur));
    }

    // Fast path: an exact server render matching the current settings is ready
    // — use it so the final document equals exactly what the user saw.
    if (serverPreviewUrls) {
      doNavigateToFinalView(serverPreviewUrls);
      return;
    }

    // No exact render yet. Wait for one instead of navigating with null (which
    // would force a slow full re-render on FinalView). The auto-navigate effect
    // fires the moment URLs arrive. Show the waiting state immediately.
    pendingFinishRef.current = true;
    setIsFinishing(true);

    // If nothing is currently rendering (e.g. a previous render failed), force
    // one immediately so the wait is bounded.
    if (!isServerRendering) setRenderNonce(n => n + 1);

    // Safety net: never hang. If no render completes within 12s (repeated
    // failure / offline), navigate with whatever we have. Guarded by
    // isFinishingRef so it can't double-navigate after the auto-navigate effect.
    if (finishSafetyTimerRef.current) clearTimeout(finishSafetyTimerRef.current);
    finishSafetyTimerRef.current = setTimeout(() => {
      if (pendingFinishRef.current && !isFinishingRef.current) {
        doNavigateToFinalView(serverPreviewUrlsRef.current);
      }
    }, 12000);
  }, [navigation, editableText, liveGlyphMap, inkColor, isServerRendering, serverPreviewUrls, doNavigateToFinalView]);

  // ── RENDER ─────────────────────────────────────────────────────────────────

  // The Finish button shows a waiting state while a server render is in flight
  // OR while a finish is pending the next render.
  const waitingFinish = isServerRendering || isFinishing;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── NOTEBOOK PAGE ─────────────────────────────────────────────── */}
        <View style={styles.frameShadow}>
          <View style={styles.frameClip}>
            {/* Server image: exact final output — shown when not dragging a slider */}
            {serverPreviewUrls && !isDragging ? (
              /* Server image: exact final output — shown when not dragging a slider */
              <Image
                source={{ uri: absUrl(serverPreviewUrls.clean[currentPage] ?? '') }}
                style={{ width: notebookW, height: pageH }}
                resizeMode="stretch"
              />
            ) : (
              /* LayoutCompositor: live preview from /layout — replaces client canvas */
              <NotebookPage pageW={notebookW} pageH={pageH} lineH={lineH} bgLineH={bgLineH}
                topM={topM} marginLineX={marginLineX} pageBg={pageBg}>
                {layoutData?.pages[currentPage] ? (
                  <LayoutCompositor
                    page={layoutData.pages[currentPage] as LayoutPage}
                    inkColor={inkColor}
                    screenScale={screenScale}
                    backendUrl={BACKEND_URL}
                  />
                ) : (
                  <View style={[styles.loadingBox, { height: pageH }]}>
                    <ActivityIndicator size="large" color={colors.accent} />
                    <Text style={styles.loadingTitle}>מכין את כתב היד...</Text>
                    <Text style={styles.loadingSub}>
                      {isLayoutLoading ? 'מחשב פריסה...' : 'טוען נתונים...'}
                    </Text>
                  </View>
                )}
              </NotebookPage>
            )}
          </View>
        </View>

        {/* ── SERVER RENDER STATUS BADGE ─────────────────────────────────── */}
        {isServerRendering && !isDragging && (
          <View style={styles.renderingBadge}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.renderingBadgeText}>מעבד תצוגה מדויקת...</Text>
          </View>
        )}
        {serverPreviewUrls && !isDragging && !isServerRendering && (
          <View style={styles.exactBadge}>
            <Text style={styles.exactBadgeText}>✓ תצוגה מדויקת</Text>
          </View>
        )}

        {/* ── LAYOUT LOADING STRIP — visible while /layout is in flight ─── */}
        {isLayoutLoading && isDragging && (
          <View style={styles.prefetchStrip}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.prefetchText}>מחשב פריסה...</Text>
          </View>
        )}

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
              accessibilityHint={`כרגע דף ${currentPage + 1} מתוך ${totalPages}`}
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
              accessibilityHint={`כרגע דף ${currentPage + 1} מתוך ${totalPages}`}
              accessibilityState={{ disabled: currentPage === totalPages - 1 }}
            >
              <Text style={styles.pageNavArrow}>›</Text>
            </Pressable>
          </View>
        )}

        {/* ── STYLE PANEL ──────────────────────────────────────────────── */}
        <View style={styles.panel}>

          {/* ── Text edit section (above sliders) ─────────────────────── */}
          <Pressable
            style={({ pressed }) => [styles.editToggleBtn, pressed && { opacity: 0.7 }]}
            onPress={() => { impactLight(); setEditMode(v => !v); }}
            accessibilityRole="button"
            accessibilityLabel={editMode ? 'סגור עריכת טקסט' : 'ערוך טקסט'}
            accessibilityHint="מאפשר מחיקת תווים ורדת שורה — לא ניתן להוסיף תווים חדשים"
          >
            <Text style={styles.editToggleIcon}>{editMode ? '✕' : '✏'}</Text>
            <Text style={styles.editToggleLabel}>{editMode ? 'סגור עריכה' : 'ערוך טקסט'}</Text>
          </Pressable>

          {editMode && (
            <View style={styles.editBox}>
              <Text style={styles.editHint}>תווים שאינם במאגר יוצגו בגופן רגיל</Text>
              <TextInput
                style={styles.editInput}
                value={editableText}
                onChangeText={handleEditText}
                multiline
                maxLength={MAX_TEXT_LEN}
                textAlign="right"
                textAlignVertical="top"
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="עריכת טקסט — תווים שאינם במאגר יוצגו בגופן רגיל"
              />
            </View>
          )}

          <View style={styles.divider} />

          {/* Rows 1-3: all sliders share the same throttled live-canvas logic */}
          {([
            [['גודל', 'charHeight'], ['ריווח אות',  'letterSpacing']],
            [['ריווח מילה', 'wordSpacing'], ['ריקוד', 'baselineJitter']],
            [['נטייה', 'slant'], ['צבירת דיו', 'inkBlobs']],
          ] as [string, keyof HandwritingStyle][][]).map((row, ri) => (
            <View key={ri} style={[styles.slidersRow, ri === 2 && { marginBottom: 14 }]}>
              {row.map(([label, key]) => (
                <PreviewSliderRow
                  key={key}
                  id={key}
                  label={label}
                  value={hs[key] as number}
                  styles={styles}
                  accentColor={colors.accent}
                  borderColor={colors.border}
                  onLiveChange={handleSliderLive}
                  onComplete={handleSliderComplete}
                />
              ))}
            </View>
          ))}

          <View style={styles.divider} />

          {/* Ink colour */}
          <Text style={styles.pickerLabel}>צבע הדיו</Text>
          <View style={styles.pickerRow}>
            {(['black', 'blue', 'red'] as InkColor[]).map(c => (
              <Pressable
                key={c}
                style={({ pressed }) => [
                  styles.inkBtn,
                  { borderColor: INK_COLORS[c] },
                  inkColor === c && { backgroundColor: INK_COLORS[c] },
                  pressed && inkColor !== c && { opacity: 0.6, transform: [{ scale: 0.96 }] },
                ]}
                onPress={() => { if (inkColor !== c) { impactLight(); setInkColor(c); } }}
                accessibilityRole="button"
                accessibilityLabel={`צבע דיו ${INK_LABELS[c]}`}
                accessibilityState={{ selected: inkColor === c }}
              >
                <View style={[
                  styles.inkDot,
                  { backgroundColor: INK_COLORS[c] },
                  inkColor === c && { backgroundColor: '#fff' },
                ]} />
                <Text style={[styles.inkLabel, { color: inkColor === c ? '#fff' : colors.inkDark }]}>
                  {INK_LABELS[c]}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Page background */}
          <Text style={styles.pickerLabel}>רקע הדף</Text>
          <View style={styles.pickerRow}>
            {(['lines', 'grid', 'blank'] as PageBg[]).map(bg => (
              <Pressable
                key={bg}
                style={({ pressed }) => [
                  styles.bgBtn,
                  pageBg === bg && { borderColor: colors.accent, backgroundColor: colors.accentLight },
                  pressed && pageBg !== bg && { opacity: 0.6, transform: [{ scale: 0.96 }] },
                ]}
                onPress={() => { if (pageBg !== bg) { impactLight(); setPageBg(bg); } }}
                accessibilityRole="button"
                accessibilityLabel={`רקע ${BG_LABELS[bg]}`}
                accessibilityState={{ selected: pageBg === bg }}
              >
                <Text style={[styles.bgLabel, { color: pageBg === bg ? colors.accent : colors.inkMid }]}>
                  {BG_LABELS[bg]}
                </Text>
              </Pressable>
            ))}
          </View>

        </View>

        {/* ── FINISH BUTTON ─────────────────────────────────────────────── */}
        <View style={styles.finishBar}>
          <Pressable
            style={({ pressed }) => [
              styles.finishBtn,
              pressed && !waitingFinish && styles.finishBtnPressed,
              waitingFinish && styles.finishBtnWaiting,
            ]}
            onPress={() => { impactLight(); handleFinish(); }}
            disabled={(!layoutData && !serverPreviewUrls) || waitingFinish}
            accessibilityRole="button"
            accessibilityLabel={waitingFinish ? 'ממתין לתצוגה מדויקת...' : 'סיום עריכה'}
            accessibilityHint="עובר למסך התוצאה הסופית עם אפשרויות שמירה ושיתוף"
            accessibilityState={{ disabled: (!layoutData && !serverPreviewUrls) || waitingFinish, busy: waitingFinish }}
          >
            {waitingFinish ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator size="small" color="#FFFFFF" />
                <Text style={styles.finishBtnText}>ממתין לתצוגה מדויקת...</Text>
              </View>
            ) : (
              <Text style={styles.finishBtnText}>סיום עריכה</Text>
            )}
          </Pressable>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bgPage },

    frameShadow: {
      marginHorizontal: PAGE_MARGIN_H,
      marginTop:        16,
      marginBottom:     8,
      borderRadius:     4,
      shadowColor:      '#1B2A3B',
      shadowOffset:     { width: 0, height: 4 },
      shadowOpacity:    0.22,
      shadowRadius:     14,
      elevation:        10,
    },
    frameClip: {
      borderRadius: 4,
      borderWidth:  1,
      borderColor:  'rgba(0,0,0,0.09)',
      overflow:     'hidden' as const,
    },

    loadingBox:   { alignItems: 'center', justifyContent: 'center', gap: 14 },
    loadingTitle: { fontSize: 17, fontFamily: fonts.bold,    color: colors.inkDark,  writingDirection: 'rtl', textAlign: 'center' },
    loadingSub:   { fontSize: 12, fontFamily: fonts.regular, color: colors.inkLight, writingDirection: 'rtl', textAlign: 'center' },

    // ── Server render status badges ──────────────────────────────────────────
    renderingBadge: {
      flexDirection:   'row',
      alignItems:      'center',
      justifyContent:  'center',
      gap:             6,
      paddingVertical: 5,
    },
    renderingBadgeText: {
      fontSize:         11,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      writingDirection: 'rtl' as const,
    },
    exactBadge: {
      alignItems:      'center',
      paddingVertical: 5,
    },
    exactBadgeText: {
      fontSize:         11,
      fontFamily:       fonts.semiBold,
      color:            colors.accent,
      writingDirection: 'rtl' as const,
    },

    // ── Edit-mode prefetch indicator ─────────────────────────────────────────
    prefetchStrip: {
      flexDirection:   'row',
      alignItems:      'center',
      justifyContent:  'center',
      gap:             8,
      paddingVertical: 6,
    },
    prefetchText: {
      fontSize:         12,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      writingDirection: 'rtl',
    },

    // ── Page navigation ───────────────────────────────────────────────────────
    pageNav: {
      flexDirection:   'row',
      alignItems:      'center',
      justifyContent:  'center',
      paddingVertical: 10,
      gap:             18,
    },
    pageNavBtn: {
      width:           36,
      height:          36,
      borderRadius:    18,
      backgroundColor: colors.bgSurface,
      borderWidth:     1,
      borderColor:     colors.border,
      alignItems:      'center',
      justifyContent:  'center',
    },
    pageNavBtnOff: { opacity: 0.35 },
    pageNavArrow:  { fontSize: 22, color: colors.inkDark, fontFamily: fonts.bold, lineHeight: 28 },
    pageNavLabel:  { fontSize: 14, fontFamily: fonts.semiBold, color: colors.inkMid },

    // ── Style panel ───────────────────────────────────────────────────────────
    panel: {
      backgroundColor:   colors.bgSurface,
      borderTopWidth:    StyleSheet.hairlineWidth,
      borderTopColor:    colors.border,
      paddingHorizontal: 16,
      paddingTop:        14,
      paddingBottom:     8,
    },

    slidersRow:    { flexDirection: 'row', gap: 14, marginBottom: 8 },
    sliderHalf:    { flex: 1 },
    sliderHeader: {
      flexDirection:  'row',
      alignItems:     'baseline',
      justifyContent: 'flex-end',
      gap:             6,
      marginBottom:   2,
    },
    sliderLabel: {
      fontSize:         11,
      fontFamily:       fonts.semiBold,
      color:            colors.inkMid,
      textAlign:        'right',
      writingDirection: 'rtl',
    },
    sliderValue: {
      fontSize:   15,
      fontFamily: fonts.extraBold,
      color:      colors.inkDark,
      textAlign:  'right',
      lineHeight: 18,
      minWidth:   28,
      textAlignVertical: 'bottom',
    },
    sliderControl: { width: '100%', height: 34 },
    divider: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginBottom:    12,
    },

    pickerLabel: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.inkDark,
      textAlign:        'right',
      writingDirection: 'rtl',
      alignSelf:        'flex-start',  // RTL: flex-start = right side
      marginTop:        4,
      marginBottom:     10,
    },
    pickerRow: { flexDirection: 'row', gap: 10, justifyContent: 'flex-start' },  // RTL: flex-start = right

    inkBtn: {
      flex:              1,
      flexDirection:     'row',
      alignItems:        'center',
      justifyContent:    'center',
      gap:               6,
      paddingVertical:   10,
      borderRadius:      radius.sm,
      borderWidth:       1.5,
    },
    inkDot:   { width: 10, height: 10, borderRadius: 5 },
    inkLabel: { fontSize: 13, fontFamily: fonts.semiBold },

    bgBtn: {
      flex:            1,
      alignItems:      'center',
      paddingVertical: 10,
      borderRadius:    radius.sm,
      borderWidth:     1.5,
      borderColor:     colors.border,
    },
    bgLabel: { fontSize: 13, fontFamily: fonts.semiBold },

    finishBar: {
      paddingHorizontal: 16,
      paddingTop:        16,
      paddingBottom:     32,
      backgroundColor:   colors.bgSurface,
      borderTopWidth:    StyleSheet.hairlineWidth,
      borderTopColor:    colors.border,
    },
    finishBtn: {
      backgroundColor: colors.accent,
      borderRadius:    radius.md,
      paddingVertical: 16,
      alignItems:      'center',
      shadowColor:     colors.accent,
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.30,
      shadowRadius:    8,
      elevation:       5,
    },
    finishBtnWaiting: {
      opacity: 0.80,
      shadowOpacity: 0.15,
    },
    finishBtnPressed: {
      transform:     [{ scale: 0.97 }],
      shadowOpacity: 0.15,
    },
    finishBtnText: {
      color:            '#FFFFFF',
      fontSize:         17,
      fontFamily:       fonts.bold,
      writingDirection: 'rtl',
      letterSpacing:    0.4,
    },

    // ── Text edit section ─────────────────────────────────────────────────────
    editToggleBtn: {
      flexDirection:  'row-reverse',
      alignItems:     'center',
      gap:            8,
      alignSelf:      'flex-start',   // RTL: flex-start = right side
      paddingVertical: 6,
    },
    editToggleIcon:  { fontSize: 14, color: colors.accent },
    editToggleLabel: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.accent,
      writingDirection: 'rtl',
    },
    editBox: {
      marginTop:       8,
      marginBottom:    4,
      borderWidth:     1,
      borderColor:     colors.border,
      borderRadius:    radius.sm,
      backgroundColor: colors.bgInput,
      overflow:        'hidden' as const,
    },
    editHint: {
      fontSize:          11,
      fontFamily:        fonts.regular,
      color:             colors.inkFaint,
      textAlign:         'right',
      writingDirection:  'rtl',
      paddingHorizontal: 10,
      paddingTop:        6,
      paddingBottom:     2,
    },
    editInput: {
      fontSize:          15,
      fontFamily:        fonts.regular,
      color:             colors.inkDark,
      paddingHorizontal: 10,
      paddingVertical:   8,
      minHeight:         80,
      maxHeight:         200,
      textAlign:         'right',
      writingDirection:  'rtl',
    },
  });
}
