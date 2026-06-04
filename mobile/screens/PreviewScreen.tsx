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

const DRAFT_KEY = 'preview_draft';

// Shared sanitize utility — same invisible Unicode ranges as EditorScreen.
// Strip the same invisible Unicode ranges as EditorScreen's INVISIBLE_RE
const PREVIEW_INVISIBLE_RE = /[​-‏‪-‮⁠-⁯﻿]/g;
const sanitizeInvisible = (s: string) => s.replace(PREVIEW_INVISIBLE_RE, '');

type Props = NativeStackScreenProps<RootStackParamList, 'Preview'>;

// ── Types ─────────────────────────────────────────────────────────────────────

type GlyphDims = Record<string, { w: number; h: number }>;
type InkColor  = 'black' | 'blue' | 'red';
type PageBg    = 'lines' | 'grid' | 'blank';

// All slider values are 0-100 (display units). Conversion to backend px happens in FinalViewScreen.
interface HandwritingStyle {
  charHeight:     number;  // 0-100 → char_height  40-130 backend px
  letterSpacing:  number;  // 0-100 → letter_spacing 0–30 backend px  (slider*0.30)
  wordSpacing:    number;  // 0-100 → word_spacing   15–100 backend px  (15+slider*0.85)
  baselineJitter: number;  // 0-100 → 0-25 % of char height
  slant:          number;  // 0-100 → 0-40 px line-tilt
  inkBlobs:       number;  // 0-100 → 0-0.30 blob probability
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN_H  = 14;   // horizontal margin around notebook on screen
const NOTEBOOK_HPAD  = 14;   // padding inside notebook (left+right)
const FALLBACK_RATIO = 0.78; // fallback glyph aspect ratio

// Server-side page geometry (A4 @ 300 DPI) — used as ratio source
const SRV_PAGE_W      = 2480;
const SRV_PAGE_H      = 3508;
const SRV_TOP_MARGIN  = 200;   // top margin — text AND background lines start here
const SRV_LINE_H      = 184;   // line pitch = _LINE_HEIGHT(180) + _LINE_GAP(4) in layout.py
const SRV_LINES_SPACING = 180; // background ruled-line interval in layout.py (_LINES_SPACING)
const SRV_SIDE_MARGIN = 200;   // left/right margin for text
// Usable text width on server: SRV_PAGE_W - 2×SRV_SIDE_MARGIN = 2080 px
const SRV_USABLE_W    = SRV_PAGE_W - 2 * SRV_SIDE_MARGIN;   // 2080

// A4 height/width ratio
const A4_RATIO = 297 / 210;

// Lines of text per page — must match render_full_page capacity:
// floor((SRV_PAGE_H - 2*SRV_TOP_MARGIN) / SRV_LINE_H) = floor(3108/184) = 16
const PAGE_LINES = 16;

// Slider (0-100) → backend px conversion factors (used in FinalViewScreen too)
// charHeight   : backend = 40 + slider * 0.9   (range 40–130 px)
// letterSpacing: backend = slider * 0.30 - 10   (range -10–+20 px)
// wordSpacing  : backend = slider * 0.85        (range   0–85 px)
// baselineJitter: backend = slider * 0.25      (range  0–25 %)
// slant        : backend = slider * 0.4        (range  0–40 px line-tilt)
// inkBlobs     : backend = slider * 0.003      (range  0–0.30)

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
  // Mulberry32-style integer hash — much better distribution than sin-based PRNG,
  // especially for seeds that differ only in one component (e.g. same li/wi, different ci).
  let s = (seed ^ 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  // IMPORTANT: the final `>>> 0` converts the XOR result to unsigned 32-bit.
  // Without it, JavaScript's ^ operator can return a signed (negative) integer
  // when bit 31 is set, causing seededRand to return values in [-1, 0) instead
  // of [0, 1). That breaks any caller that compares the result to 0 — most
  // critically the ink-blob gate `blobSeed < blobProb`, which would fire even
  // when blobProb is 0 (ink-blob slider fully off).
  return ((s ^ (s >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Pick one variant URL for a single character occurrence.
 *
 * Replicates the server's shuffled-deck selection (synthesizer.py VariantPicker)
 * so the preview matches the final output as closely as possible.
 *
 * How it works:
 *   - The N variants are conceptually arranged in a "shuffled deck" that repeats
 *     every N occurrences.  The shuffle order within each deck cycle is derived
 *     from a seed that depends on the character and the cycle number, so the same
 *     text always produces the same assignment in the preview.
 *   - Within a cycle of length N, position p gets variant deck[p].
 *   - The deck for cycle c is produced by a Fisher-Yates shuffle seeded with
 *     hash(charCode × 31 + c × 1000003), keeping things deterministic.
 *
 * This matches the server contract: every N occurrences each variant appears
 * exactly once, and no variant repeats on consecutive occurrences (because
 * consecutive deck cycles avoid starting with the same index that ended the
 * previous deck, mirroring the server's _last_used guard).
 *
 * `occurrence` is the 0-based count of how many times this character has
 * already appeared in the document before this instance.
 *
 * Accepts a plain string too, for resilience against an older server build
 * that still returns a single URL per character.
 */
function pickVariantUrl(
  variants: string[] | string | undefined,
  occurrence: number,
  charCode: number = 0,
): string | undefined {
  if (!variants) return undefined;
  const arr = (Array.isArray(variants) ? variants : [variants]).filter(Boolean);
  if (arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];

  const n         = arr.length;
  const cycle     = Math.floor(occurrence / n); // which deck repetition we're in
  const posInCycle = occurrence % n;            // position within the current deck

  // Build a deterministic shuffled deck for this (char, cycle) pair.
  // Fisher-Yates with seededRand as the RNG.
  const deck = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    // Unique seed per (char, cycle, swap-position) so each step is independent
    const swapSeed = (charCode * 31 + cycle * 1_000_003 + i * 7) >>> 0;
    const j = Math.floor(seededRand(swapSeed) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  // Mirror the server's _last_used guard: if the first card of this deck equals
  // the last card of the previous deck, swap it with the last card of this deck.
  if (cycle > 0 && n > 1) {
    // Compute the last index of the previous deck
    const prevDeck = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const swapSeed = (charCode * 31 + (cycle - 1) * 1_000_003 + i * 7) >>> 0;
      const j = Math.floor(seededRand(swapSeed) * (i + 1));
      [prevDeck[i], prevDeck[j]] = [prevDeck[j], prevDeck[i]];
    }
    const lastOfPrev = prevDeck[n - 1];
    if (deck[0] === lastOfPrev) {
      [deck[0], deck[n - 1]] = [deck[n - 1], deck[0]];
    }
  }

  return arr[deck[posInCycle]];
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
// CHAR_HEIGHT_RATIO — MUST stay in sync with _CHAR_HEIGHT_RATIO in synthesizer.py.
// Controls glyph height as a fraction of the base x-height so line-breaking in
// the preview produces the same wrapping as the server-rendered final output.
const CHAR_HEIGHT_RATIO: Record<string, number> = {
  // ── Hebrew: standard x-height (entirely above baseline) ──────────────
  'א': 0.92, 'ב': 0.92, 'ג': 0.82, 'ד': 0.82, 'ה': 0.90,
  'ו': 0.68, 'ז': 0.78, 'ח': 0.92, 'ט': 0.92, 'כ': 0.90,
  'מ': 0.92, 'נ': 0.82, 'ס': 0.92, 'ע': 0.90, 'פ': 0.90,
  'צ': 0.85, 'ר': 0.75, 'ש': 0.92, 'ת': 0.92, 'ם': 0.95,
  // ── Hebrew: yod — small mark, sits in upper portion of line ──────────
  'י': 0.35,
  // ── Hebrew: ascender ─────────────────────────────────────────────────
  'ל': 1.35,
  // ── Hebrew: descenders (top at x-height, stem below baseline) ─────────
  'ק': 1.19, 'ך': 1.56, 'ן': 1.80, 'ף': 1.38, 'ץ': 1.31,

  // ── Latin uppercase (cap-height, on baseline) ─────────────────────────
  'A': 1.10, 'B': 1.10, 'C': 1.10, 'D': 1.10, 'E': 1.10,
  'F': 1.10, 'G': 1.10, 'H': 1.10, 'I': 1.10, 'J': 1.10,
  'K': 1.10, 'L': 1.10, 'M': 1.10, 'N': 1.10, 'O': 1.10,
  'P': 1.10, 'Q': 1.10, 'R': 1.10, 'S': 1.10, 'T': 1.10,
  'U': 1.10, 'V': 1.10, 'W': 1.10, 'X': 1.10, 'Y': 1.10, 'Z': 1.10,

  // ── Latin lowercase: x-height group ──────────────────────────────────
  'a': 0.92, 'c': 0.92, 'e': 0.92, 'i': 0.92, 'm': 0.92, 'n': 0.92,
  'o': 0.92, 'r': 0.80, 's': 0.88, 'u': 0.92, 'v': 0.92,
  'w': 0.92, 'x': 0.88, 'z': 0.88,
  // ── Latin lowercase: ascenders ────────────────────────────────────────
  'b': 1.25, 'd': 1.25, 'h': 1.22, 'k': 1.22, 'l': 1.22,
  'f': 1.20, 't': 1.05,
  // ── Latin lowercase: descenders ──────────────────────────────────────
  'g': 1.38, 'j': 1.38, 'p': 1.25, 'q': 1.25, 'y': 1.30,

  // ── Digits (x-height, on baseline) ───────────────────────────────────
  '0': 0.95, '1': 0.95, '2': 0.95, '3': 0.95, '4': 0.95,
  '5': 0.95, '6': 0.95, '7': 0.95, '8': 0.95, '9': 0.95,

  // ── Punctuation ───────────────────────────────────────────────────────
  '.': 0.15, '…': 0.15,
  ',': 0.28,
  ':': 0.80, ';': 0.85,
  '!': 1.00, '?': 1.00,
  "'": 0.22, '"': 0.22, '׳': 0.22, '״': 0.22,
  '-': 0.12, '–': 0.12, '—': 0.12,
  '(': 1.10, ')': 1.10, '[': 1.10, ']': 1.10, '{': 1.10, '}': 1.10,

  // ── Math symbols ─────────────────────────────────────────────────────
  '+': 0.55, '−': 0.12, '×': 0.55, '÷': 0.55,
  '=': 0.45, '≠': 0.55,
  '<': 0.65, '>': 0.65, '≤': 0.75, '≥': 0.75,
  '±': 0.85, '%': 0.95, '√': 1.20,
  '^': 0.45, 'π': 0.90,

  // ── Currency ──────────────────────────────────────────────────────────
  '₪': 1.05, '$': 1.20, '€': 1.00, '£': 1.00, '¢': 0.85,

  // ── Arrows ────────────────────────────────────────────────────────────
  '←': 0.55, '→': 0.55, '↑': 1.00, '↓': 1.00,

  // ── Special symbols ───────────────────────────────────────────────────
  '@': 1.05, '#': 1.00, '&': 1.00,
  '*': 0.45, '/': 1.10, '\\': 1.10, '|': 1.10,
  '~': 0.35, '_': 0.10,
};

// CHAR_ASCENDER_RATIO — fraction of glyph height that sits ABOVE the baseline.
// glyphTop = baselineY - gh * ascRatio
// asc=1.0 → bottom on baseline; asc<1.0 → descender; asc>1.0 → floats above baseline.
// MUST stay in sync with _CHAR_ASCENDER_RATIO in synthesizer.py.
const CHAR_ASCENDER_RATIO: Record<string, number> = {
  // ── Hebrew: yod — upper portion of line, not pinned to very top ──────
  'י': 2.3,
  // ── Hebrew: descenders — top at x-height top, stem below baseline ─────
  'ק': 0.840, 'ך': 0.641, 'ן': 0.556, 'ף': 0.725, 'ץ': 0.763,

  // ── Latin descenders — bowl top aligns with x-height top ─────────────
  'g': 0.725, 'j': 0.725, 'p': 0.800, 'q': 0.800, 'y': 0.769,

  // ── Punctuation ───────────────────────────────────────────────────────
  '.': 1.0, '…': 1.0,
  ',': 0.82,   // dot near baseline + short tail below
  ':': 1.0, ';': 0.94,
  '!': 1.0, '?': 1.0,
  // Quotes float near top of x-height (asc = 80 / (80 × 0.22) ≈ 4.54)
  "'": 4.54, '"': 4.54, '׳': 4.54, '״': 4.54,
  // Dashes centred in x-height zone
  '-': 4.69, '–': 4.69, '—': 4.69,
  // Brackets foot on baseline
  '(': 1.0, ')': 1.0, '[': 1.0, ']': 1.0, '{': 1.0, '}': 1.0,
  '_': 0.0,   // entirely below baseline

  // ── Math symbols — centred operators (asc = 40/h + 0.5) ──────────────
  '+': 1.41, '−': 4.69, '×': 1.41, '÷': 1.41,
  '=': 1.61, '≠': 1.41,
  '<': 1.27, '>': 1.27,
  '≤': 1.17, '≥': 1.17,
  '±': 1.09,
  '%': 1.0, '√': 1.0,
  '^': 2.22, '*': 2.22,   // superscripts pinned to top of x-height
  '~': 1.93,

  // ── Currency / arrows / special — foot on baseline ───────────────────
  '₪': 1.0, '$': 1.0, '€': 1.0, '£': 1.0, '¢': 1.0,
  '←': 1.41, '→': 1.41, '↑': 1.0, '↓': 1.0,
  '@': 1.0, '#': 1.0, '&': 1.0,
  '/': 1.0, '\\': 1.0, '|': 1.0,
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

// Sentinel used to represent an explicit newline (Enter key) in the word list.
const NEWLINE_SENTINEL = '\n';

function breakLines(
  words: string[], canvasInnerW: number,
  charH: number, lsp: number, wsp: number, dims: GlyphDims,
): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  let lineW = 0;
  for (const word of words) {
    // Explicit newline — flush current line and start a new (possibly empty) one.
    if (word === NEWLINE_SENTINEL) {
      lines.push(line);
      line = [];
      lineW = 0;
      continue;
    }
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

  // Track how many times each character has appeared so far on this page,
  // so we can do strict round-robin sample selection across all occurrences.
  // Declared here so it persists across all lines/words in the page render.
  const charOccurrences: Record<string, number> = {};

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

        // Baseline at 62% from top of row — matches server's
        // `baseline_y = round(_LINE_HEIGHT * _BASELINE_Y_RATIO)` (= round(180*0.62) = 112).
        // Normal letters (asc=1.0) have bottom on baseline, upper 38% is descender space.
        // Quotes/dashes (asc>1) float near the top; descenders (asc<1) hang below.
        const baselineY = Math.round(lineH * BASELINE_Y_RATIO);

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
            // Pick variant by round-robin: count how many times this character
            // has appeared so far on the page and advance the counter.
            const occurrence = charOccurrences[ch] ?? 0;
            charOccurrences[ch] = occurrence + 1;
            const url  = pickVariantUrl(glyphMap[ch], occurrence);
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
                    {/*
                      Two-layer rendering to match the server's binary-alpha compositing.
                      When React Native downsamples a glyph from ~160 px stored height to
                      ~14 px display height it introduces sub-pixel semi-transparency along
                      stroke edges, making strokes look thinner than the server output.
                      The server binarises the alpha channel (0 or 255, no intermediate
                      values) before compositing, which produces full-opacity strokes.
                      We replicate this with a gently blurred base layer that fills in the
                      sub-pixel gaps, topped by a sharp layer that keeps edges crisp.
                      blurRadius = gh * 0.03 ≈ 0.4 px at default size — enough to fill
                      bilinear-interpolated fringe pixels without making glyphs look fuzzy.
                    */}
                    <Image
                      source={{ uri: absUrl(url) }}
                      style={{ position: 'absolute', width: cw, height: gh, tintColor: inkHex }}
                      resizeMode="contain"
                      blurRadius={Math.max(0.3, gh * 0.03)}
                    />
                    <Image
                      source={{ uri: absUrl(url) }}
                      style={{ width: cw, height: gh, tintColor: inkHex }}
                      resizeMode="contain"
                    />
                  </>
                ) : (
                  /* Character not in glyphMap — dashed border box + dim letter
                     so it's visually distinct from real handwriting but still
                     readable. Matches the upgrade described in HANDSCRIPT_HANDOFF. */
                  <View style={{
                    width: cw, height: gh,
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: INK_COLORS[inkColor],
                    borderRadius: 2,
                    opacity: 0.35,
                  }}>
                    <Text style={{
                      color: INK_COLORS[inkColor],
                      fontFamily: fonts.regular,
                      fontSize: Math.max(6, gh * 0.55),
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
  // lineH  = text-line advance pitch (180 content + 4 gap = 184 server px).
  // bgLineH = background ruled-line interval (180 server px, no gap).
  // Keeping them separate means text gradually drifts below ruled lines as
  // it does in the server render — exactly matching the final output.
  const lineH        = Math.round(pageH * SRV_LINE_H       / SRV_PAGE_H);
  const bgLineH      = Math.round(pageH * SRV_LINES_SPACING / SRV_PAGE_H);
  const topM         = Math.round(pageH * SRV_TOP_MARGIN / SRV_PAGE_H);
  const marginLineX  = Math.round(notebookW * SRV_SIDE_MARGIN / SRV_PAGE_W);
  const canvasInnerW = notebookW - 2 * NOTEBOOK_HPAD;

  // Convert initStyle (backend px units) → 0-100 slider values.
  // Inverse of FinalViewScreen formulas:
  //   letterSpacing: backend = slider*0.30-10  → slider = (backend+10)/0.30
  //   wordSpacing:   backend = slider*0.85     → slider = backend/0.85
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const [hs, setHs] = useState<HandwritingStyle>({
    charHeight:     clamp((initStyle.charHeight - 40) / 0.9),        // 85→50
    letterSpacing:  clamp((initStyle.letterSpacing + 10) / 0.30),    // 4→47 (natural)
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
  const [isLoaded,      setIsLoaded]      = useState(false);
  // isPrefetching: true only while new dims are loading for chars added in edit mode.
  // Unlike isLoaded=false, it does NOT hide the canvas — it shows a small indicator
  // so the user sees the canvas with FALLBACK_RATIO while new dims are measured.
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [glyphDims,   setGlyphDims]   = useState<GlyphDims>({});
  const [currentPage, setCurrentPage] = useState(0);

  // liveHs: drives the canvas during slider drag (throttled updates)
  const [liveHs,     setLiveHs]     = useState<HandwritingStyle>(hs);
  const [isDragging, setIsDragging] = useState(false);
  // Refs for throttle — avoids stale closures without extra renders
  const pendingHsRef  = useRef<HandwritingStyle>(hs);
  const throttleRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (draftDebounce.current)        { clearTimeout(draftDebounce.current);        draftDebounce.current = null; }
    if (serverRenderDebounceRef.current) { clearTimeout(serverRenderDebounceRef.current); }
    if (finishSafetyTimerRef.current) { clearTimeout(finishSafetyTimerRef.current); }
    serverRenderAbortRef.current?.abort();
  }, []);

  // ── Unified pixel scale ─────────────────────────────────────────────────
  //
  // pixelScale = (preview usable width) / (server usable width)
  //            = canvasInnerW / SRV_USABLE_W
  //
  // This single factor converts any server-pixel value to a preview-pixel value
  // so that character widths, letter/word spacing, and slant all maintain the
  // same PROPORTIONS as the server render.  Crucially, this makes line-breaking
  // in the preview produce the same wraps as render_full_page on the server.
  //
  // canvasInnerW = notebookW - 2*NOTEBOOK_HPAD  (preview usable width)
  // SRV_USABLE_W = SRV_PAGE_W - 2*SRV_SIDE_MARGIN = 2080  (server usable width)
  //
  const pixelScale = canvasInnerW / SRV_USABLE_W;   // e.g. 334/2080 ≈ 0.161

  // Backend char height (server pixels): slider 0→40 px, slider 100→130 px
  const charHBackend = 40 + liveHs.charHeight * 0.9;   // 40-130 server px

  // Display char height for the preview canvas.
  //
  // SYNC RULE: displayCharH must equal charHBackend * pixelScale so that
  //   displayCharH / canvasInnerW  ≡  charHBackend / SRV_USABLE_W
  //
  // This identity guarantees that word widths and letter spacings have the
  // same ratio to the usable canvas width as they do on the server, which
  // in turn ensures that line-breaking in breakLines() produces exactly the
  // same wraps as compose_paragraph() on the server.
  //
  // Previous formula (lineH-based) made glyphs ~58% larger relative to the
  // canvas, causing the preview to break lines earlier than the server.
  const displayCharH = Math.max(4, Math.round(charHBackend * pixelScale));

  // ── Spacing — both scaled by pixelScale to stay proportional to the server render ──
  // Letter spacing:  backend_px = slider * 0.30  (range 0–30 px, matches StyleParams ge=0)
  // When slider=0 the server falls back to avg_glyph_w*0.15; we mirror with lspFallback.
  const lspExplicit = Math.round(liveHs.letterSpacing * 0.30 * pixelScale);
  const lspFallback = Math.round(displayCharH * FALLBACK_RATIO * 0.15);
  const lsp         = lspExplicit > 0 ? lspExplicit : lspFallback;
  //
  // Word spacing:    backend_px = slider * 0.85          (range   0 …  +85 px)
  //   slider=0  →  0 px (words touching)  |  slider=100 → +85 px
  const wsp = Math.max(0, Math.round(liveHs.wordSpacing * 0.85 * pixelScale));
  const jitter  = Math.max(0, charHBackend * liveHs.baselineJitter * 0.0025 * pixelScale);
  // slantPx: line tilt per line in preview pixels.
  // Server sends slant = slider * 0.4 (server px), scaled by pixelScale → preview px.
  const slantPx  = liveHs.slant * 0.4 * pixelScale;
  const blobProb = liveHs.inkBlobs * 0.003; // 0-0.30
  // ── Prefetch glyph images ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    // Normalise to arrays (tolerating an older single-string response).
    const allEntries = Object.entries(liveGlyphMap)
      .map(([ch, urls]) => [ch, Array.isArray(urls) ? urls : urls ? [urls] : []] as const)
      .filter(([, urls]) => urls.length > 0);

    if (!allEntries.length) { setIsLoaded(true); return; }

    // On initial load (isLoaded=false): process every char, show full spinner.
    // On subsequent loads from edit mode (isLoaded=true): only process NEW chars
    // that have no measured dims yet, and show a small isPrefetching indicator
    // so the canvas stays visible instead of flashing back to a spinner.
    const isInitialLoad = !isLoaded;
    const entriesToProcess = isInitialLoad
      ? allEntries
      : allEntries.filter(([ch]) => !glyphDims[ch]);

    if (!isInitialLoad && entriesToProcess.length === 0) return; // nothing new to load

    if (!isInitialLoad) setIsPrefetching(true);

    const collectedDims: GlyphDims = {};
    const promises: Promise<unknown>[] = [];

    for (const [ch, urls] of entriesToProcess) {
      for (const u of urls) {
        promises.push(Image.prefetch(absUrl(u)).catch(() => null));
      }
      // Measure dimensions from the first variant only.
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
      .then(() => {
        if (!cancelled) {
          // Merge — never discard dims for previously loaded chars.
          setGlyphDims(prev => ({ ...prev, ...collectedDims }));
          setIsLoaded(true);
          setIsPrefetching(false);
        }
      })
      .catch(() => {
        if (!cancelled) { setIsLoaded(true); setIsPrefetching(false); }
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveGlyphMap]);

  // Split preserving explicit newlines as NEWLINE_SENTINEL tokens so that
  // Enter-key line breaks in the edit box produce real new lines in the canvas.
  const words = useMemo(() => {
    const result: string[] = [];
    const paragraphs = editableText.split('\n');
    paragraphs.forEach((para, i) => {
      const ws = para.split(/[ \t]+/).filter(Boolean);
      result.push(...ws);
      // Insert a sentinel for every newline between paragraphs (not after the last).
      if (i < paragraphs.length - 1) result.push(NEWLINE_SENTINEL);
    });
    return result;
  }, [editableText]);

  const allLines = useMemo(() => {
    if (!isLoaded) return [];
    return breakLines(words, canvasInnerW, displayCharH, lsp, wsp, glyphDims);
  }, [isLoaded, words, canvasInnerW, displayCharH, lsp, wsp, glyphDims]);

  // When server preview is available, use its page count as ground truth.
  // The server is authoritative — canvas line-breaking is an approximation.
  const totalPages = serverPreviewUrls
    ? serverPreviewUrls.clean.length
    : Math.max(1, Math.ceil(allLines.length / PAGE_LINES));
  const pageLines  = useMemo(
    () => allLines.slice(currentPage * PAGE_LINES, (currentPage + 1) * PAGE_LINES),
    [allLines, currentPage],
  );

  // Reset to page 0 on any style/content change, or when serverPreviewUrls arrive
  // (server page count may differ from canvas estimate — avoid out-of-bounds index).
  useEffect(() => { setCurrentPage(0); }, [liveHs, inkColor, pageBg, editableText, serverPreviewUrls]);
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
              letter_spacing:  hs.letterSpacing * 0.30,
              word_spacing:    Math.round(15 + hs.wordSpacing * 0.85),
              baseline_jitter: hs.baselineJitter * 0.25,
              slant:           hs.slant * 0.4,
              ink_blobs:       hs.inkBlobs * 0.003,
            },
          }),
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = await res.json() as {
          ok: boolean; clean_urls?: string[]; photo_urls?: string[];
        };
        if (controller.signal.aborted) return;
        if (data.ok && data.clean_urls?.length && data.photo_urls?.length) {
          setServerPreviewUrls({ clean: data.clean_urls, photo: data.photo_urls });
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
      previewUrls: urls ?? undefined,
    });
    const unsub = navigation.addListener('focus', () => {
      isFinishingRef.current = false;
      pendingFinishRef.current = false;
      setIsFinishing(false);   // reset waiting UI when the user returns to edit
      unsub();
    });
  }, [navigation, editableText, liveGlyphMap, inkColor]);

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
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
      setHs({ ...pendingHsRef.current });
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
              <Image
                source={{ uri: absUrl(serverPreviewUrls.clean[currentPage] ?? '') }}
                style={{ width: notebookW, height: pageH }}
                resizeMode="stretch"
              />
            ) : (
              /* Canvas: live approximate preview — always shown while dragging */
              <NotebookPage pageW={notebookW} pageH={pageH} lineH={lineH} bgLineH={bgLineH}
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
                    glyphMap={liveGlyphMap}
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

        {/* ── PREFETCH INDICATOR — visible only while edit-mode glyphs load ─── */}
        {isPrefetching && (
          <View style={styles.prefetchStrip}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.prefetchText}>מעדכן תווים חדשים...</Text>
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
                writingDirection="rtl"
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
                      pendingHsRef.current = { ...pendingHsRef.current, [key]: v };
                      if (!isDragging) setIsDragging(true);
                      if (!throttleRef.current) {
                        throttleRef.current = setTimeout(() => {
                          setLiveHs({ ...pendingHsRef.current });
                          throttleRef.current = null;
                        }, 80);
                      }
                    }}
                    onSlidingComplete={v => {
                      if (throttleRef.current) {
                        clearTimeout(throttleRef.current);
                        throttleRef.current = null;
                      }
                      const next = { ...pendingHsRef.current, [key]: v };
                      pendingHsRef.current = next;
                      setLiveHs(next);
                      setHs(next);
                      setIsDragging(false);
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
            style={({ pressed }) => [
              styles.finishBtn,
              pressed && !waitingFinish && styles.finishBtnPressed,
              waitingFinish && styles.finishBtnWaiting,
            ]}
            onPress={() => { impactLight(); handleFinish(); }}
            disabled={!isLoaded || waitingFinish}
            accessibilityRole="button"
            accessibilityLabel={waitingFinish ? 'ממתין לתצוגה מדויקת...' : 'סיום עריכה'}
            accessibilityHint="עובר למסך התוצאה הסופית עם אפשרויות שמירה ושיתוף"
            accessibilityState={{ disabled: !isLoaded || waitingFinish, busy: waitingFinish }}
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
