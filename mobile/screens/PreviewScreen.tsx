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
import { BACKEND_URL }                 from '../src/config';
import { impactLight }                 from '../src/utils/haptics';

const DRAFT_KEY = 'preview_draft';

type Props = NativeStackScreenProps<RootStackParamList, 'Preview'>;

// ── Types ─────────────────────────────────────────────────────────────────────

type GlyphDims = Record<string, { w: number; h: number }>;
type InkColor  = 'black' | 'blue' | 'red';
type PageBg    = 'lines' | 'grid' | 'blank';

// All slider values are 0-100 (display units). Conversion to backend px happens in FinalViewScreen.
interface HandwritingStyle {
  charHeight:     number;  // 0-100 → char_height  40-130 backend px
  letterSpacing:  number;  // 0-100 → letter_spacing 0-30 backend px
  wordSpacing:    number;  // 0-100 → word_spacing  15-100 backend px
  baselineJitter: number;  // 0-100 → 0-25 % of char height
  slant:          number;  // 0-100 → 0-15 degrees forward lean
  inkBlobs:       number;  // 0-100 → 0-0.30 blob probability
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN_H  = 14;   // horizontal margin around notebook on screen
const NOTEBOOK_HPAD  = 14;   // padding inside notebook (left+right)
const FALLBACK_RATIO = 0.78; // fallback glyph aspect ratio

// Server-side page geometry (A4 @ 300 DPI) — used as ratio source
const SRV_PAGE_W      = 2480;
const SRV_PAGE_H      = 3508;
const SRV_TOP_MARGIN  = 200;   // top padding before first line
const SRV_LINE_H      = 180;   // line pitch (= _LINES_SPACING = _LINE_HEIGHT)
const SRV_SIDE_MARGIN = 200;   // left/right margin for text

// A4 height/width ratio
const A4_RATIO = 297 / 210;

// Lines of text per page — must match render_full_page capacity:
// floor((SRV_PAGE_H - 2*SRV_TOP_MARGIN) / (SRV_LINE_H + 4)) = 16
const PAGE_LINES = 16;

// Slider (0-100) → backend px conversion factors (used in FinalViewScreen too)
// charHeight  : backend = 40 + slider * 0.9  (range 40-130 px)
// letterSpacing: backend = slider * 0.30      (range 0-30 px)
// wordSpacing  : backend = 15 + slider * 0.85 (range 15-100 px)
// baselineJitter: backend = slider * 0.25     (range 0-25 %)
// slant        : backend = slider * 0.15      (range 0-15 °)
// inkBlobs     : backend = slider * 0.003     (range 0-0.30)

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

function seededRand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/**
 * Pick one variant URL for a single character occurrence.
 *
 * `variants` is the list of all sample URLs for a character (the new /glyphs
 * response shape). We use a position-derived seed so the choice is:
 *   • varied   — different occurrences of the same character get different
 *                samples, which is the whole point of uploading multiple.
 *   • stable   — the same position always resolves to the same sample, so the
 *                preview doesn't flicker between re-renders / slider tweaks.
 *
 * Accepts a plain string too, for resilience against an older server build
 * that still returns a single URL per character.
 */
function pickVariantUrl(
  variants: string[] | string | undefined,
  seed: number,
): string | undefined {
  if (!variants) return undefined;
  const arr = Array.isArray(variants) ? variants : [variants];
  if (arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  const idx = Math.floor(seededRand(seed) * arr.length) % arr.length;
  return arr[idx];
}

// ── Per-character typography ──────────────────────────────────────────────────
// MUST stay in sync with synthesizer.py (_CHAR_HEIGHT_RATIO / _CHAR_ASCENDER_RATIO)
// so the client preview matches the server-rendered final output.
//
// heightRatio  = glyph height as a multiple of the base x-height (default 1.0)
// ascenderRatio = fraction of glyph height ABOVE the baseline (default 1.0)
//                 glyphTop = baselineY - gh * ascenderRatio
//                 ascenderRatio = 1.0   → bottom sits exactly on the baseline
//                 ascenderRatio < 1.0   → glyph hangs below the baseline (descender)
//                 ascenderRatio > 1.0   → glyph floats above the baseline
const CAP = 1.40;  // cap-height / x-height ratio (uppercase, digits)

const CHAR_HEIGHT_RATIO: Record<string, number> = {
  // ── Hebrew — normal x-height letters (omitted = 1.0): א ט מ נ ס ע פ צ ש ת ם ──
  'י': 0.45, 'ו': 0.70, 'ז': 0.75, 'ר': 0.82, 'ד': 0.85,
  'ג': 0.85, 'ח': 0.90, 'ה': 0.90, 'ב': 0.92, 'כ': 0.90,
  // Ascender — rises above x-height, bottom on baseline
  'ל': 1.32,
  // Descenders — body at x-height, stem drops below baseline
  'ן': 1.28, 'ך': 1.28, 'ק': 1.20,
  'ף': 1.30, 'ץ': 1.30,   // final pe / final tsadi are DESCENDERS in Hebrew

  // ── Latin uppercase — cap-height ──────────────────────────────────────
  'A': CAP, 'B': CAP, 'C': CAP, 'D': CAP, 'E': CAP, 'F': CAP,
  'G': CAP, 'H': CAP, 'I': CAP, 'J': CAP, 'K': CAP, 'L': CAP,
  'M': CAP, 'N': CAP, 'O': CAP, 'P': CAP, 'Q': CAP, 'R': CAP,
  'S': CAP, 'T': CAP, 'U': CAP, 'V': CAP, 'W': CAP, 'X': CAP,
  'Y': CAP, 'Z': CAP,

  // ── Latin lowercase ascenders ─────────────────────────────────────────
  'b': CAP, 'd': CAP, 'h': CAP, 'k': CAP, 'l': CAP,
  'f': 1.15, 't': 1.20,
  // Latin descenders — body at x-height, tail below baseline
  'g': 1.30, 'j': 1.30, 'p': 1.28, 'q': 1.28, 'y': 1.28,
  'i': 0.75,

  // ── Digits — cap-height ───────────────────────────────────────────────
  '0': CAP, '1': CAP, '2': CAP, '3': CAP, '4': CAP,
  '5': CAP, '6': CAP, '7': CAP, '8': CAP, '9': CAP,

  // ── Punctuation ───────────────────────────────────────────────────────
  '.': 0.15,              // period — tiny dot on baseline
  '…': 0.15,              // ellipsis — same as period
  ',': 0.30,              // comma — small body + tail below baseline
  ':': 0.90,              // colon — two dots spanning x-height
  ';': 1.05,              // semicolon — dot + descending tail
  "'": 0.30, '"': 0.30,   // apostrophe / quote — small, near cap-line
  '׳': 0.30, '״': 0.30,   // Hebrew geresh / gershayim — near cap-line
  '!': CAP, '?': CAP,     // full height, on baseline
  '–': 0.12, '—': 0.12,   // en-dash / em-dash — thin, mid-line

  // ── Brackets — span above cap-line to below baseline ──────────────────
  '(': 1.50, ')': 1.50,
  '[': 1.50, ']': 1.50,
  '{': 1.50, '}': 1.50,

  // ── Math operators ────────────────────────────────────────────────────
  '+': 0.70, '-': 0.12, '×': 0.70, '÷': 0.80,
  '=': 0.45, '≠': 0.70,
  '<': 0.80, '>': 0.80, '≤': 0.95, '≥': 0.95,
  '±': 0.95, '%': CAP, '√': CAP,

  // ── Currency ──────────────────────────────────────────────────────────
  '₪': 1.30, '$': 1.50, '€': CAP, '£': CAP, '¢': 1.05,

  // ── Arrows ────────────────────────────────────────────────────────────
  '←': 0.70, '→': 0.70, '↑': 1.20, '↓': 1.20,

  // ── Special symbols ───────────────────────────────────────────────────
  '@': CAP, '#': CAP, '&': CAP,
  '*': 0.55, '/': CAP, '\\': CAP, '|': CAP,
  '~': 0.40, '^': 0.55, '_': 0.10,
};

// Fraction of glyph height that sits ABOVE the baseline (1.0 = all above).
// glyphTop = baselineY - gh * ascRatio
const CHAR_ASCENDER_RATIO: Record<string, number> = {
  // ── Hebrew descenders — top aligns with x-height, tail below ──────────
  'ן': 1 / 1.28, 'ך': 1 / 1.28, 'ק': 1 / 1.20,
  'ף': 1 / 1.30, 'ץ': 1 / 1.30,

  // ── Latin descenders ──────────────────────────────────────────────────
  'g': 0.65, 'j': 0.62, 'p': 0.65, 'q': 0.65, 'y': 0.65,

  // ── Bottom punctuation ────────────────────────────────────────────────
  '.': 1.0,               // period sits on the baseline
  '…': 1.0,               // ellipsis on the baseline
  ',': 0.50,              // comma — body above, tail hangs below baseline
  ':': 1.0,               // colon — sits on baseline
  ';': 1 / 1.05,          // semicolon — tail dips below baseline
  '_': 0.0,               // underscore — entirely below baseline

  // ── Top-aligned punctuation (near cap-line): cap / heightRatio ────────
  "'": CAP / 0.30, '"': CAP / 0.30,
  '׳': CAP / 0.30, '״': CAP / 0.30,
  '*': CAP / 0.55, '^': CAP / 0.55,

  // ── Brackets — top at cap-line, bottom dips below baseline ────────────
  '(': CAP / 1.50, ')': CAP / 1.50,
  '[': CAP / 1.50, ']': CAP / 1.50,
  '{': CAP / 1.50, '}': CAP / 1.50,
  '$': CAP / 1.50, '¢': 0.95,

  // ── Mid-line dashes — centered between baseline and x-height ──────────
  '–': 0.5 + 0.5 / 0.12, '—': 0.5 + 0.5 / 0.12,

  // ── Math operators — centered at mid x-height: 0.5 + 0.5/heightRatio ──
  '+': 0.5 + 0.5 / 0.70,
  '-': 0.5 + 0.5 / 0.12,
  '×': 0.5 + 0.5 / 0.70,
  '÷': 0.5 + 0.5 / 0.80,
  '=': 0.5 + 0.5 / 0.45,
  '≠': 0.5 + 0.5 / 0.70,
  '<': 0.5 + 0.5 / 0.80,
  '>': 0.5 + 0.5 / 0.80,
  '≤': 0.5 + 0.5 / 0.95,
  '≥': 0.5 + 0.5 / 0.95,
  '±': 0.5 + 0.5 / 0.95,
  '~': 0.5 + 0.5 / 0.40,

  // ── Horizontal arrows — centered; vertical arrows — slightly above ────
  '←': 0.5 + 0.5 / 0.70,
  '→': 0.5 + 0.5 / 0.70,
  '↑': 0.5 + 0.5 / 1.20,
  '↓': 0.5 + 0.5 / 1.20,
};

// Baseline sits 62% from the top of each line row (matches backend _BASELINE_Y_RATIO)
const BASELINE_Y_RATIO = 0.62;

function glyphDisplayH(ch: string, baseCharH: number): number {
  return Math.max(4, Math.round(baseCharH * (CHAR_HEIGHT_RATIO[ch] ?? 1.0)));
}

function charWidthFor(ch: string, charH: number, dims: GlyphDims): number {
  const gh    = glyphDisplayH(ch, charH);
  const d     = dims[ch];
  const ratio = d && d.h > 0 ? d.w / d.h : FALLBACK_RATIO;
  return Math.round(ratio * gh);
}

function wordWidth(word: string, charH: number, lsp: number, dims: GlyphDims): number {
  const chars = word.split('');
  return chars.reduce((s, ch) => s + charWidthFor(ch, charH, dims), 0)
    + Math.max(0, chars.length - 1) * lsp;
}

function breakLines(
  words: string[], canvasInnerW: number,
  charH: number, lsp: number, wsp: number, dims: GlyphDims,
): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  let lineW = 0;
  for (const word of words) {
    const ww  = wordWidth(word, charH, lsp, dims);
    const gap = line.length > 0 ? wsp : 0;
    if (line.length > 0 && lineW + gap + ww > canvasInnerW) {
      lines.push(line); line = [word]; lineW = ww;
    } else {
      line.push(word); lineW += gap + ww;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// ── Notebook page component ────────────────────────────────────────────────────

/**
 * Renders a realistic notebook page background with:
 *  - Horizontal ruled lines  (every lineH px, starting from topM)
 *  - Vertical grid lines     (same pitch as ruled lines → square cells)
 *  - Red margin line         (at marginLineX from right edge)
 * All measurements are derived from A4 proportions matching the server.
 */
function NotebookPage({
  pageW, pageH, lineH, topM, marginLineX, pageBg, children,
}: {
  pageW: number; pageH: number;
  lineH: number; topM: number; marginLineX: number;
  pageBg: PageBg; children: React.ReactNode;
}) {
  const hLines: number[] = [];
  for (let y = topM; y < pageH; y += lineH) hLines.push(y);

  const vLines: number[] = [];
  if (pageBg === 'grid') {
    for (let x = lineH; x < pageW; x += lineH) vLines.push(x);
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

// ── Direction helpers ─────────────────────────────────────────────────────────

function isHebrewChar(ch: string): boolean {
  return ch >= 'א' && ch <= 'ת';
}

/** Returns 'rtl' if the line contains any Hebrew letter, otherwise 'ltr'. */
function lineDirection(words: string[]): 'rtl' | 'ltr' {
  for (const w of words) {
    for (const ch of w) {
      if (isHebrewChar(ch)) return 'rtl';
    }
  }
  return 'ltr';
}

// ── Handwriting canvas ────────────────────────────────────────────────────────

const HandwritingCanvas = React.memo(function HandwritingCanvas({
  pageLines, glyphMap, displayCharH, lsp, wsp, jitter,
  slantPx, blobProb,
  canvasInnerW, lineH, topM, dims, inkColor,
}: {
  pageLines:    string[][];
  glyphMap:     Record<string, string[]>;
  displayCharH: number;
  lsp:          number;
  wsp:          number;
  jitter:       number;
  slantPx:      number;
  blobProb:     number;
  canvasInnerW: number;
  lineH:        number;
  topM:         number;
  dims:         GlyphDims;
  inkColor:     InkColor;
}) {
  const { colors } = useTheme();
  const inkHex = INK_COLORS[inkColor];

  // All glyphs rendered at uniform displayCharH → consistent stroke weight
  return (
    <View style={{ paddingHorizontal: NOTEBOOK_HPAD, paddingTop: topM }}>
      {pageLines.map((line, li) => {
        const dir = lineDirection(line);
        const rtl = dir === 'rtl';
        let x = rtl ? canvasInnerW : 0;
        const cells: React.ReactElement[] = [];

        // Per-line tilt: direction alternates per line, magnitude from slantPx
        const lineSeed  = (li * 2654435761) & 0xFFFFFFFF;
        const tiltDir   = (lineSeed >> 16) & 1 ? 1 : -1;
        const tiltVar   = 0.6 + 0.8 * ((lineSeed & 0xFFFF) / 65535);
        const lineTilt  = slantPx > 0 ? tiltDir * slantPx * tiltVar : 0;

        // Baseline Y within each line row (in px from top of the row)
        const baselineY = lineH * BASELINE_Y_RATIO;

        line.forEach((word, wi) => {
          word.split('').forEach((ch, ci) => {
            const sizeJitter = 1 + (seededRand(li * 997 + wi * 97 + ci * 53 + 7) - 0.5) * 0.06;
            const gh  = Math.round(glyphDisplayH(ch, displayCharH) * sizeJitter);
            const cw  = Math.round(charWidthFor(ch, displayCharH, dims) * sizeJitter);

            // RTL: move cursor left before placing; LTR: place then move right
            if (rtl) x -= cw;
            const glyphX = x;
            if (!rtl) x += cw;

            const ascRatio = CHAR_ASCENDER_RATIO[ch] ?? 1.0;
            const glyphTop = baselineY - gh * ascRatio;
            const jit   = (seededRand(li * 997 + wi * 97 + ci * 31 + 13) - 0.5) * 2 * jitter;
            const tiltY = rtl
              ? lineTilt * (1 - glyphX / canvasInnerW)
              : lineTilt * (glyphX / canvasInnerW);
            // Pick a different sample per occurrence (seed derived from the
            // glyph's position so it stays stable across re-renders).
            const url  = pickVariantUrl(glyphMap[ch], li * 997 + wi * 97 + ci * 53 + 19);
            cells.push(
              <View
                key={`${li}_${wi}_${ci}`}
                style={{
                  position: 'absolute',
                  left:     glyphX,
                  top:      glyphTop,
                  width:    cw,
                  height:   gh,
                  overflow: 'visible',
                  transform: [{ translateY: jit + tiltY }],
                }}
              >
                {url ? (
                  <>
                    {/* Blur layer simulates normalize_stroke_width dilation */}
                    <Image
                      source={{ uri: absUrl(url) }}
                      style={{ position: 'absolute', width: cw, height: gh, tintColor: inkHex }}
                      resizeMode="contain"
                      blurRadius={gh * 0.055}
                    />
                    {/* Sharp layer on top for crisp edges */}
                    <Image
                      source={{ uri: absUrl(url) }}
                      style={{ width: cw, height: gh, tintColor: inkHex }}
                      resizeMode="contain"
                    />
                  </>
                ) : (
                  <View style={{
                    width: cw, height: gh,
                    backgroundColor: colors.accentLight, borderRadius: 3,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{
                      color: colors.accent, fontFamily: fonts.bold,
                      fontSize: Math.max(7, gh * 0.55),
                    }}>{ch}</Text>
                  </View>
                )}
              </View>,
            );
            // Ink blob dot near glyph endpoint
            const blobSeed = seededRand(li * 997 + wi * 97 + ci * 67 + 11);
            if (blobSeed < blobProb) {
              const blobSize = Math.max(2, Math.round(displayCharH * 0.09));
              const blobOffX = seededRand(li * 997 + wi * 97 + ci * 67 + 13) * cw;
              const blobOffY = seededRand(li * 997 + wi * 97 + ci * 67 + 17) * displayCharH * 0.4;
              const blobOpa  = 0.45 + seededRand(li * 997 + wi * 97 + ci * 67 + 19) * 0.45;
              cells.push(
                <View
                  key={`b_${li}_${wi}_${ci}`}
                  style={{
                    position:        'absolute',
                    left:            glyphX + blobOffX,
                    bottom:          blobOffY,
                    width:           blobSize,
                    height:          blobSize,
                    borderRadius:    blobSize / 2,
                    backgroundColor: inkHex,
                    opacity:         blobOpa,
                  }}
                />,
              );
            }
            if (ci < word.length - 1) { if (rtl) x -= lsp; else x += lsp; }
          });
          if (wi < line.length - 1) { if (rtl) x -= wsp; else x += wsp; }
        });

        return (
          <View
            key={li}
            style={{ width: canvasInnerW, height: lineH, direction: 'ltr', overflow: 'visible' }}
          >
            {cells}
          </View>
        );
      })}
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
  const lineH        = Math.round(pageH * SRV_LINE_H / SRV_PAGE_H);
  const topM         = Math.round(pageH * SRV_TOP_MARGIN / SRV_PAGE_H);
  const marginLineX  = Math.round(notebookW * SRV_SIDE_MARGIN / SRV_PAGE_W);
  const canvasInnerW = notebookW - 2 * NOTEBOOK_HPAD;

  // Convert initStyle (backend px units) → 0-100 slider values
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const [hs, setHs] = useState<HandwritingStyle>({
    charHeight:     clamp((initStyle.charHeight - 40) / 0.9),        // 85→50
    letterSpacing:  clamp(initStyle.letterSpacing / 0.30),           // 4→13
    wordSpacing:    clamp((initStyle.wordSpacing - 15) / 0.85),      // 35→24
    baselineJitter: clamp(initStyle.baselineJitter / 0.25),          // 3→12
    slant:          15,   // slight natural lean by default
    inkBlobs:       10,   // subtle blob effect by default
  });

  const [inkColor, setInkColor] = useState<InkColor>(initInkColor ?? 'black');
  const [pageBg,   setPageBg]   = useState<PageBg>((initBg as PageBg) ?? 'lines');
  const [isLoaded,    setIsLoaded]    = useState(false);
  const [glyphDims,   setGlyphDims]   = useState<GlyphDims>({});
  const [currentPage, setCurrentPage] = useState(0);

  // liveHs: drives the canvas during slider drag (throttled updates)
  const [liveHs,     setLiveHs]     = useState<HandwritingStyle>(hs);
  const [isDragging, setIsDragging] = useState(false);
  // Refs for throttle — avoids stale closures without extra renders
  const pendingHsRef  = useRef<HandwritingStyle>(hs);
  const throttleRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
    if (draftDebounce.current) { clearTimeout(draftDebounce.current); draftDebounce.current = null; }
  }, []);

  // Slider 0-100 → backend char_height → preview px (scaled to lineH)
  // pixelScale: ratio of preview px per backend px (constant for a given screen)
  // Use liveHs so the canvas responds immediately during drag
  const charHBackend = 40 + liveHs.charHeight * 0.9;                       // 40-130 backend px
  const pixelScale   = lineH * 0.72 / 85;                                  // ≈ 0.47 on typical screen
  const displayCharH = Math.max(4, Math.round(charHBackend * pixelScale));

  // Spacing proportional to backend values so preview visually matches final output
  const lsp    = Math.max(0, Math.round(liveHs.letterSpacing * 0.30 * pixelScale));
  const wsp    = Math.max(1, Math.round((15 + liveHs.wordSpacing * 0.85) * pixelScale));
  const jitter = Math.max(0, charHBackend * liveHs.baselineJitter * 0.0025 * pixelScale);
  const slantPx  = liveHs.slant * 0.4 * pixelScale; // 0-19px line tilt at preview scale
  const blobProb = liveHs.inkBlobs * 0.003; // 0-0.30

  // ── Prefetch glyph images ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // glyphMap maps each char to a LIST of variant URLs. Normalise to arrays
    // (tolerating an older single-string response) and prefetch every variant
    // so switching samples mid-render never shows a loading flash.
    const entries = Object.entries(glyphMap)
      .map(([ch, urls]) => [ch, Array.isArray(urls) ? urls : urls ? [urls] : []] as const)
      .filter(([, urls]) => urls.length > 0);
    if (!entries.length) { setIsLoaded(true); return; }

    const collectedDims: GlyphDims = {};
    const promises: Promise<unknown>[] = [];
    for (const [ch, urls] of entries) {
      // Prefetch all variants of this character.
      for (const u of urls) {
        promises.push(Image.prefetch(absUrl(u)).catch(() => null));
      }
      // Measure dimensions from the first variant only — all variants of the
      // same character are roughly the same size, and layout just needs one
      // representative measurement.
      promises.push(
        new Promise<void>(resolve => {
          Image.getSize(absUrl(urls[0]),
            (w, h) => { collectedDims[ch] = { w, h }; resolve(); },
            ()     => { resolve(); },
          );
        }),
      );
    }

    Promise.all(promises)
      .then(() => { if (!cancelled) { setGlyphDims(collectedDims); setIsLoaded(true); } })
      .catch(() => { if (!cancelled) setIsLoaded(true); });

    return () => { cancelled = true; };
  }, [glyphMap]);

  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);

  const allLines = useMemo(() => {
    if (!isLoaded) return [];
    return breakLines(words, canvasInnerW, displayCharH, lsp, wsp, glyphDims);
  }, [isLoaded, words, canvasInnerW, displayCharH, lsp, wsp, glyphDims]);

  const totalPages = Math.max(1, Math.ceil(allLines.length / PAGE_LINES));
  const pageLines  = useMemo(
    () => allLines.slice(currentPage * PAGE_LINES, (currentPage + 1) * PAGE_LINES),
    [allLines, currentPage],
  );

  useEffect(() => { setCurrentPage(0); }, [liveHs, inkColor, pageBg]);
  // Keep pendingHsRef in sync whenever hs changes from an external source
  useEffect(() => { pendingHsRef.current = hs; setLiveHs(hs); }, [hs]);

  // ── Draft persistence ──────────────────────────────────────────────────────
  // Only hs and inkColor are saved — pageBg is a document-level setting that
  // comes from the editor and must not be overridden by a stale draft.
  useEffect(() => {
    AsyncStorage.getItem(DRAFT_KEY).then(raw => {
      if (!raw) return;
      try {
        const draft = JSON.parse(raw) as { hs?: HandwritingStyle; inkColor?: InkColor };
        if (draft.hs)       { setHs(draft.hs); setLiveHs(draft.hs); pendingHsRef.current = draft.hs; }
        if (draft.inkColor) setInkColor(draft.inkColor);
      } catch {}
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft whenever style or ink color changes (debounced 800ms)
  useEffect(() => {
    if (draftDebounce.current) clearTimeout(draftDebounce.current);
    draftDebounce.current = setTimeout(() => {
      AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ hs, inkColor }));
    }, 800);
    return () => { if (draftDebounce.current) clearTimeout(draftDebounce.current); };
  }, [hs, inkColor]);

  const handleFinish = useCallback(() => {
    navigation.navigate('FinalView', {
      text,
      background: pageBg,
      glyphMap,
      style: hs,
      inkColor,
    });
  }, [navigation, text, pageBg, glyphMap, hs, inkColor]);

  // ── RENDER ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── NOTEBOOK PAGE ─────────────────────────────────────────────── */}
        <View style={styles.frameShadow}>
          <View style={styles.frameClip}>
            <NotebookPage pageW={notebookW} pageH={pageH} lineH={lineH}
              topM={topM} marginLineX={marginLineX} pageBg={pageBg}>
              {!isLoaded ? (
                <View style={[styles.loadingBox, { height: pageH }]}>
                  <ActivityIndicator size="large" color={colors.accent} />
                  <Text style={styles.loadingTitle}>מכין את כתב היד...</Text>
                  <Text style={styles.loadingSub}>טוען תמונות לתצוגה</Text>
                </View>
              ) : (
                <HandwritingCanvas
                  pageLines={pageLines}
                  glyphMap={glyphMap}
                  displayCharH={displayCharH}
                  lsp={lsp}
                  wsp={wsp}
                  jitter={jitter}
                  slantPx={slantPx}
                  blobProb={blobProb}
                  canvasInnerW={canvasInnerW}
                  lineH={lineH}
                  topM={topM}
                  dims={glyphDims}
                  inkColor={inkColor}
                />
              )}
            </NotebookPage>
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

          {/* Rows 1-3: all sliders share the same throttled live-canvas logic */}
          {([
            [['גודל', 'charHeight'], ['ריווח אות',  'letterSpacing']],
            [['ריווח מילה', 'wordSpacing'], ['ריקוד', 'baselineJitter']],
            [['נטייה', 'slant'], ['צבירת דיו', 'inkBlobs']],
          ] as [string, keyof HandwritingStyle][][]).map((row, ri) => (
            <View key={ri} style={[styles.slidersRow, ri === 2 && { marginBottom: 14 }]}>
              {row.map(([label, key]) => (
                <View key={key} style={styles.sliderHalf}>
                  <View style={styles.sliderHeader}>
                    <Text style={styles.sliderLabel}>{label}</Text>
                    <Text style={styles.sliderValue}>{Math.round(liveHs[key] as number)}</Text>
                  </View>
                  <Slider
                    style={styles.sliderControl}
                    minimumValue={0} maximumValue={100} step={1}
                    value={hs[key] as number}
                    onValueChange={v => {
                      // Update pending value and mark dragging
                      pendingHsRef.current = { ...pendingHsRef.current, [key]: v };
                      if (!isDragging) setIsDragging(true);
                      // Throttled canvas update — at most once per 80ms
                      if (!throttleRef.current) {
                        throttleRef.current = setTimeout(() => {
                          setLiveHs({ ...pendingHsRef.current });
                          throttleRef.current = null;
                        }, 80);
                      }
                    }}
                    onSlidingComplete={v => {
                      // Flush throttle immediately
                      if (throttleRef.current) {
                        clearTimeout(throttleRef.current);
                        throttleRef.current = null;
                      }
                      const next = { ...pendingHsRef.current, [key]: v };
                      pendingHsRef.current = next;
                      setLiveHs(next);
                      setHs(next);
                      setIsDragging(false);
                      // No server fetch on slider release — canvas is the live preview.
                      // Server quality is triggered only by ink/bg changes (see below).
                    }}
                    minimumTrackTintColor={colors.accent}
                    maximumTrackTintColor={colors.border}
                    thumbTintColor={colors.accent}
                  />
                </View>
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
            style={({ pressed }) => [styles.finishBtn, pressed && styles.finishBtnPressed]}
            onPress={() => { impactLight(); handleFinish(); }}
            disabled={!isLoaded}
            accessibilityRole="button"
            accessibilityLabel="סיום עריכה"
            accessibilityHint="עובר למסך התוצאה הסופית עם אפשרויות שמירה ושיתוף"
            accessibilityState={{ disabled: !isLoaded }}
          >
            <Text style={styles.finishBtnText}>סיום עריכה</Text>
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
      marginTop:        4,
      marginBottom:     10,
    },
    pickerRow: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },

    inkBtn: {
      flexDirection:     'row',
      alignItems:        'center',
      gap:               6,
      paddingHorizontal: 14,
      paddingVertical:   9,
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
  });
}
