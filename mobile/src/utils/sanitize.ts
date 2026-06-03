/**
 * Text sanitization utilities — shared between EditorScreen and PreviewScreen.
 *
 * Invisible Unicode characters can sneak into text via paste or autocorrect.
 * They are never in the glyph bank, so they trigger the computer-font fallback
 * in the preview canvas.  We strip them proactively at every entry point.
 *
 * Ranges stripped
 * ---------------
 * U+00AD        Soft hyphen
 * U+200B-U+200F Zero-width space, ZWNJ, ZWJ, LRM, RLM
 * U+202A-U+202E LRE, RLE, PDF, LRO, RLO (directional embedding/override)
 * U+2060-U+206F Word joiner + deprecated format characters
 * U+FEFF        BOM / zero-width no-break space
 */
const INVISIBLE_UNICODE_RE =
  /[­​-‏‪-‮⁠-⁯﻿]/g;

/**
 * Strip invisible Unicode control characters from *input*.
 * Safe to call on every keystroke — runs in O(n) with a single regex pass.
 */
export function sanitizeText(input: string): string {
  return input.replace(INVISIBLE_UNICODE_RE, '');
}
