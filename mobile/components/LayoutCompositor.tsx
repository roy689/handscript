/**
 * LayoutCompositor — Phase 4 (REWRITE_PLAN §4)
 *
 * Renders a single page's glyphs at absolute server-pixel coordinates
 * scaled to the on-screen notebook width.  Zero typography logic lives
 * here — the server's /layout response is the single source of truth.
 *
 * Usage: place inside a <View style={{ width: notebookW, height: pageH }}>
 * so position:'absolute' coordinates map correctly from page top-left.
 */

import React from 'react';
import { Image, View } from 'react-native';

// Server page constants — must match layout.py / main.py
const SRV_PAGE_W      = 2480;
const SRV_SIDE_MARGIN = 200;
const SRV_USABLE_W    = SRV_PAGE_W - 2 * SRV_SIDE_MARGIN; // 2080

const INK_HEX: Record<string, string> = {
  black: '#1C1C1E',
  blue:  '#1A4FC4',
  red:   '#C9271A',
};

// ── JSON types mirroring the /layout response ────────────────────────────────

export interface LayoutGlyph {
  ch:      string;
  url:     string;
  variant: number;
  /** Absolute server-pixel position on the page (0,0 = page top-left) */
  x: number; y: number; w: number; h: number;
}

export interface LayoutLine {
  /** Absolute top-of-line Y in server pixels */
  y:     number;
  /** X position of the left edge of the line in server pixels */
  x:     number;
  /** Width of the text run in server pixels */
  width: number;
  /**
   * Per-line tilt in server pixels (same unit as slant × pixelScale).
   * Mirrors layout.py line_tilt(): positive = upward lean on the right side.
   */
  tilt:   number;
  glyphs: LayoutGlyph[];
}

export interface LayoutPage {
  lines: LayoutLine[];
}

export interface LayoutPageGeometry {
  page_w:         number;
  page_h:         number;
  top_margin:     number;
  side_margin:    number;
  line_height:    number;
  line_gap:       number;
  baseline_ratio: number;
}

export interface LayoutJSON {
  ok:            boolean;
  seed:          number;
  bank_version:  number;
  page_geometry: LayoutPageGeometry;
  pages:         LayoutPage[];
  error?:        string;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  /**
   * One page from LayoutJSON.pages.  Pass null / undefined while waiting for
   * the first /layout response — the compositor renders nothing.
   */
  page:        LayoutPage | null | undefined;
  /** 'black' | 'blue' | 'red' — tints every glyph image */
  inkColor:    string;
  /**
   * Ratio that maps server pixels → screen pixels:
   *   screenScale = notebookW / SRV_PAGE_W   (e.g. 390 / 2480 ≈ 0.157)
   * Pass the same value as used to size the surrounding <NotebookPage>.
   */
  screenScale: number;
  /** Backend base URL — prepended to relative glyph URLs */
  backendUrl:  string;
}

/**
 * Tilt approximation — mirrors the canvas's RTL formula for Hebrew text.
 *
 * The server rotates the composited line image by `tilt` server-pixels
 * (a small angular offset applied as a height shear).  We approximate
 * this as a per-glyph translateY that linearly varies from:
 *   • 0    at the right edge of the usable page width (RTL line start)
 *   • tilt at the left  edge (RTL line end)
 *
 * Formula in server pixels:
 *   tiltOffsetServer = line.tilt × (1 − (glyph.x − SRV_SIDE_MARGIN) / SRV_USABLE_W)
 *
 * This matches the canvas HandwritingCanvas formula exactly:
 *   tiltY = lineTilt × (1 − glyphX / canvasInnerW)   [for RTL]
 * because glyphX/canvasInnerW ≡ (glyph.x − SRV_SIDE_MARGIN) / SRV_USABLE_W
 * when both are measured from the same usable-width origin.
 */
function glyphTiltY(g: LayoutGlyph, line: LayoutLine, screenScale: number): number {
  if (!line.tilt) return 0;
  const relX = Math.max(0, Math.min(1, (g.x - SRV_SIDE_MARGIN) / SRV_USABLE_W));
  return line.tilt * (1 - relX) * screenScale;
}

const LayoutCompositor = React.memo(function LayoutCompositor({
  page, inkColor, screenScale, backendUrl,
}: Props) {
  if (!page) return null;

  const inkHex = INK_HEX[inkColor] ?? '#1C1C1E';

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      pointerEvents="none"
    >
      {page.lines.flatMap((line, li) =>
        line.glyphs.map((g, gi) => {
          const sx = g.x * screenScale;
          const sy = g.y * screenScale;
          const sw = Math.max(2, g.w * screenScale);
          const sh = Math.max(2, g.h * screenScale);
          const ty = glyphTiltY(g, line, screenScale);

          const uri = g.url.startsWith('http')
            ? g.url
            : `${backendUrl}${g.url}`;

          return (
            <View
              key={`${li}_${gi}`}
              style={{
                position: 'absolute',
                left:     sx,
                top:      sy,
                width:    sw,
                height:   sh,
                transform: ty ? [{ translateY: ty }] : undefined,
              }}
            >
              {/*
                Two-layer rendering to match the server's binary-alpha compositing.
                RN downsamples glyph images from ~160 px to ~14 px display height
                which introduces sub-pixel semi-transparency along stroke edges,
                making strokes look thinner than the server output.  A gently
                blurred base layer fills the bilinear-interpolated fringe pixels;
                the sharp top layer keeps edges crisp — same technique as the old
                HandwritingCanvas.
              */}
              <Image
                source={{ uri }}
                style={{ position: 'absolute', width: sw, height: sh, tintColor: inkHex }}
                resizeMode="contain"
                blurRadius={Math.max(0.3, sh * 0.03)}
              />
              <Image
                source={{ uri }}
                style={{ width: sw, height: sh, tintColor: inkHex }}
                resizeMode="contain"
              />
            </View>
          );
        }),
      )}
    </View>
  );
});

export default LayoutCompositor;
