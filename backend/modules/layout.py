"""Page layout and compositing of synthesised glyphs onto paper backgrounds."""

import hashlib
import logging
import struct
import time
from typing import Dict, Tuple

import numpy as np
from PIL import Image, ImageChops, ImageDraw

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Page geometry constants (A4 at 300 DPI)
# ---------------------------------------------------------------------------

_PAGE_W = 2480
_PAGE_H = 3508

_LINES_SPACING = 180    # px between ruled lines — matches _LINE_HEIGHT in synthesizer
_GRID_SPACING  = 180    # px between grid lines
_TOP_MARGIN    = 200    # top margin (px) — first ruled line sits here
_LINE_GAP      = 4      # extra gap between text lines beyond _LINE_HEIGHT (px)

# Ruled-paper line colour: a muted blue-grey matching standard notebook ink
_RULE_COLOUR   = (178, 202, 217, 255)   # RGBA
# Grid line colour: very light grey, unobtrusive
_GRID_COLOUR   = (205, 205, 205, 255)   # RGBA
# Margin line colour: classic red notebook margin
_MARGIN_COLOUR = (220, 130, 130, 255)   # RGBA  (muted red, not harsh)

# Module-level cache for generated backgrounds.
# Capped at 12 entries (3 bg_types × 4 realistic sizes) — evicts oldest on overflow.
# In practice only 1 size (A4 @ 300DPI) is ever used, so the cache stays tiny.
_BG_CACHE: Dict[Tuple, np.ndarray] = {}
_BG_CACHE_MAX = 12

# Module-level cache for static lighting maps (vignette, gradient, hotspot, crease).
# Keyed by (h, w) — deterministic for a given page size, so we compute once.
# Capped at 8 entries — far more than needed in practice (usually just 1 size).
_LIGHTING_CACHE: Dict[Tuple, dict] = {}
_LIGHTING_CACHE_MAX = 8


def _evict(cache: dict, max_size: int) -> None:
    """Remove oldest entries when cache exceeds max_size (insertion-order eviction)."""
    while len(cache) > max_size:
        cache.pop(next(iter(cache)))


# ---------------------------------------------------------------------------
# Background generation
# ---------------------------------------------------------------------------

def load_background(
    bg_type: str,
    size: tuple[int, int] = (_PAGE_W, _PAGE_H),
) -> np.ndarray:
    """
    Generate a paper background as a white RGBA canvas with optional ruling.

    Parameters
    ----------
    bg_type : str
        ``"blank"``  — plain white page, no markings
        ``"lines"``  — horizontal ruled lines every 88 px (notebook paper)
        ``"grid"``   — horizontal and vertical lines every 60 px (graph paper)
    size : tuple[int, int]
        ``(width, height)`` in pixels.  Defaults to A4 at 300 DPI.

    Returns
    -------
    np.ndarray
        RGBA uint8 array of shape ``(height, width, 4)``.
    """
    cache_key = (bg_type, size)
    if cache_key in _BG_CACHE:
        return _BG_CACHE[cache_key].copy()

    w, h = size
    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))

    if bg_type == "blank":
        result = np.array(img, dtype=np.uint8)
        _BG_CACHE[cache_key] = result
        _evict(_BG_CACHE, _BG_CACHE_MAX)
        return result.copy()

    draw = ImageDraw.Draw(img)

    if bg_type == "lines":
        # Horizontal ruled lines.  Start at _TOP_MARGIN so the first line
        # aligns with the text starting position (matches PreviewScreen.tsx topM).
        # Line width: 7 px at A4-300DPI resolution ≈ 1 px when scaled to phone
        # screen (~390 pt).  Previous 2 px was sub-pixel on common devices and
        # rendered as an invisible "blank" page.
        y = _TOP_MARGIN
        while y < h:
            draw.line([(0, y), (w, y)], fill=_RULE_COLOUR, width=7)
            y += _LINES_SPACING

    elif bg_type == "grid":
        # Horizontal and vertical grid lines.
        # 4 px ≈ 0.6 px on screen — lighter than ruled lines, clearly visible.
        y = _TOP_MARGIN
        while y < h:
            draw.line([(0, y), (w, y)], fill=_GRID_COLOUR, width=4)
            y += _GRID_SPACING
        # Vertical passes (start from left margin so columns align with text area)
        x = _GRID_SPACING
        while x < w:
            draw.line([(x, 0), (x, h)], fill=_GRID_COLOUR, width=4)
            x += _GRID_SPACING

    else:
        raise ValueError(
            f"Unknown bg_type {bg_type!r}. "
            "Valid options: 'blank', 'lines', 'grid'."
        )

    result = np.array(img, dtype=np.uint8)
    _BG_CACHE[cache_key] = result
    _evict(_BG_CACHE, _BG_CACHE_MAX)
    return result.copy()


# ---------------------------------------------------------------------------
# Multiply blend compositing
# ---------------------------------------------------------------------------

def composite_text_on_background(
    text_layer: np.ndarray,
    background: np.ndarray,
) -> np.ndarray:
    """
    Composite a transparent text layer onto a background using Multiply blending.

    Multiply blend formula per channel
    ------------------------------------
    ``result = (bg * text) / 255``

    White pixels (255) in the text layer leave the background completely
    unchanged.  Dark ink pixels darken the background proportionally,
    exactly as physical ink absorbs and reflects light on paper.

    The text layer's **alpha channel** is used as the blend weight so that
    partially-transparent anti-aliased edges blend smoothly rather than
    leaving hard borders.

    Blend equation with alpha
    -------------------------
    ``final_RGB = bg_RGB  × (1 − α)  +  multiply(bg_RGB, text_RGB) × α``

    where ``α = text_alpha / 255``.

    Parameters
    ----------
    text_layer : np.ndarray
        RGBA array (H × W × 4, uint8).  Ink pixels should have low RGB values
        (near-black) and high alpha; background should be transparent (alpha=0).
    background : np.ndarray
        RGBA array with the same spatial dimensions.  Typically produced by
        ``load_background``.

    Returns
    -------
    np.ndarray
        RGBA array (H × W × 4, uint8).  Alpha is always 255 (opaque paper).
    """
    if text_layer.shape != background.shape:
        raise ValueError(
            f"text_layer shape {text_layer.shape} does not match "
            f"background shape {background.shape}"
        )

    bg_pil   = Image.fromarray(background,  "RGBA")
    text_pil = Image.fromarray(text_layer,  "RGBA")

    # Split into colour and alpha components.
    bg_r,   bg_g,   bg_b,   _       = bg_pil.split()
    txt_r,  txt_g,  txt_b,  txt_a   = text_pil.split()

    bg_rgb  = Image.merge("RGB", (bg_r,  bg_g,  bg_b))
    txt_rgb = Image.merge("RGB", (txt_r, txt_g, txt_b))

    # Multiply blend on the ink colour channels.
    # PIL's ImageChops.multiply computes (a * b) // 255 element-wise.
    multiply_rgb = ImageChops.multiply(bg_rgb, txt_rgb)

    # Blend between unmodified background and multiply result using the
    # text alpha as the interpolation weight.
    # Image.composite(a, b, mask) returns `a` where mask is black (0)
    # and `b` where mask is white (255), with linear interpolation between.
    result_rgb = Image.composite(multiply_rgb, bg_rgb, txt_a)

    # The output page is always fully opaque (physical paper is not transparent).
    opaque_alpha = Image.new("L", bg_pil.size, 255)
    result_pil   = Image.merge("RGBA", (*result_rgb.split(), opaque_alpha))

    return np.array(result_pil, dtype=np.uint8)


# ---------------------------------------------------------------------------
# Photo-scan post-processing
# ---------------------------------------------------------------------------

def _get_lighting_maps(h: int, w: int) -> dict:
    """Return cached (or freshly computed) static lighting maps for a page of size h×w."""
    key = (h, w)
    if key in _LIGHTING_CACHE:
        return _LIGHTING_CACHE[key]

    Y, X = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2.0, h / 2.0

    norm_dist = np.sqrt(((X - cx) / cx) ** 2 + ((Y - cy) / cy) ** 2)
    vignette  = 1.0 - np.clip((norm_dist - 0.50) / 0.65, 0.0, 1.0) * 0.28

    gradient = 1.04 - (X / w) * 0.04 - (Y / h) * 0.04

    crease_dist = np.abs(X - cx) / cx
    crease      = 1.0 - np.exp(-crease_dist * 10.0) * 0.04

    hotspot_dist = np.sqrt((X / w) ** 2 + (Y / h) ** 2)
    hotspot      = 1.0 + np.exp(-hotspot_dist * 2.2) * 0.18

    # Combined lighting multiplier (all four maps merged into one array)
    combined = (vignette * gradient * crease * hotspot).astype(np.float32)

    maps = {"combined": combined}
    _LIGHTING_CACHE[key] = maps
    _evict(_LIGHTING_CACHE, _LIGHTING_CACHE_MAX)
    return maps


def apply_photo_effect(page: np.ndarray) -> np.ndarray:
    """
    Apply realistic phone-scan post-processing to a fully-rendered A4 page.

    Processes at 50 % resolution for speed (4× fewer pixels), which is still
    ample quality for on-screen display and gallery export.

    Pipeline:
    1. Downscale to 50 %
    2. Off-white warm tint on background pixels
    3. Paper fiber texture overlay
    4. Non-uniform lighting (cached vignette + gradient + hotspot + crease)
    5. Ink treatment: slight opacity reduction
    6. Sensor noise
    7. Mild lens-softness blur
    """
    from PIL import ImageFilter

    orig_h, orig_w = page.shape[:2]

    # ── Downscale to 50 % for fast processing ────────────────────────────
    pil_orig = Image.fromarray(page, "RGBA")
    half_w, half_h = orig_w // 2, orig_h // 2
    pil_small = pil_orig.resize((half_w, half_h), Image.BILINEAR)
    arr = np.array(pil_small, dtype=np.float32)
    h, w = arr.shape[:2]

    # ── 1. Off-white warm tint ────────────────────────────────────────────
    is_bg = (arr[..., :3].min(axis=2) > 230) & (arr[..., 3] > 200)
    arr[is_bg, 1] *= 0.985   # G: -1.5 %
    arr[is_bg, 2] *= 0.930   # B: -7 %  → warm cream

    # ── 2. Paper fiber texture ────────────────────────────────────────────
    # Use a fresh, truly random seed each call so every document gets a unique
    # paper texture — previously seed=42 made every scan identical.
    rng   = np.random.default_rng()
    fiber = rng.normal(0.0, 12.0, (h, w)).astype(np.float32)
    arr[..., :3] += fiber[..., np.newaxis] * (0.08 * 255.0 / 12.0)

    # ── 3. Non-uniform lighting (cached maps) ─────────────────────────────
    maps     = _get_lighting_maps(h, w)
    combined = maps["combined"]
    arr[..., :3] *= combined[..., np.newaxis]

    # ── 4. Ink treatment ──────────────────────────────────────────────────
    ink_mask = arr[..., :3].max(axis=2) < 160
    arr[ink_mask, 3] *= 0.92

    # ── 5. Sensor noise ───────────────────────────────────────────────────
    noise = rng.normal(0.0, 6.0, (h, w, 3)).astype(np.float32)
    arr[..., :3] += noise

    # ── 6. Mild lens softness ─────────────────────────────────────────────
    pil_final = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
    pil_final = pil_final.filter(ImageFilter.GaussianBlur(radius=0.7))

    # ── 7. Upscale back to original resolution ────────────────────────────
    # Processing was done at 50% for speed; restore full A4 dimensions so that
    # export (PDF, gallery, share) works identically to the clean mode output.
    pil_final = pil_final.resize((orig_w, orig_h), Image.BILINEAR)

    return np.array(pil_final, dtype=np.uint8)


# ---------------------------------------------------------------------------
# Line tilt helper
# ---------------------------------------------------------------------------

def _tilt_line(arr: np.ndarray, tilt_px: float) -> tuple:
    """
    Shift each column of *arr* vertically to simulate a sloping baseline.

    tilt_px > 0 : left side drops (right side stays at y=0)
    tilt_px < 0 : left side rises (right side drops)

    Returns (tilted_array, top_offset) where top_offset is how many pixels
    above the original top the new canvas starts (for negative tilts).
    """
    if abs(tilt_px) < 1:
        return arr, 0

    lh, lw = arr.shape[:2]
    nc = arr.shape[2]
    abs_t = int(abs(tilt_px)) + 2

    # Extra rows needed at top (negative tilt) or bottom (positive tilt)
    top_pad    = abs_t if tilt_px < 0 else 0
    bottom_pad = abs_t if tilt_px >= 0 else 0
    new_h      = lh + abs_t

    result = np.zeros((new_h, lw, nc), dtype=arr.dtype)

    # t=1 at left (col=0), t=0 at right (col=lw-1)
    t = 1.0 - np.arange(lw, dtype=float) / max(lw - 1, 1)
    shifts = np.round(tilt_px * t).astype(int) + top_pad  # per-column dst row

    for s in np.unique(shifts):
        cols   = np.where(shifts == s)[0]
        copy_h = min(lh, new_h - int(s))
        if copy_h > 0:
            result[int(s) : int(s) + copy_h, cols] = arr[:copy_h, cols]

    return result, top_pad


# ---------------------------------------------------------------------------
# Full-page renderer
# ---------------------------------------------------------------------------

def render_full_page(
    lines: list[np.ndarray],
    background: np.ndarray,
    margin: int = 200,
    slant_px: float = 0.0,
    scan_mode: str = 'clean',
) -> list[np.ndarray]:
    """
    Arrange text lines on one or more page backgrounds.

    Layout rules
    ------------
    * Top margin       : 180 px (fixed — approximates a document header area)
    * Left / right margin : ``margin`` px on each side
    * Lines are **right-aligned** (correct for RTL Hebrew; also looks natural
      for centred or ragged-left LTR content on a mixed page)
    * Vertical advance  : ``line_height + 20 px`` gap between lines
    * When lines overflow the bottom margin a new page is started, copying
      the same background template.

    Parameters
    ----------
    lines : list[np.ndarray]
        Output of ``synthesizer.compose_paragraph`` — one RGBA array per line.
    background : np.ndarray
        Paper background (RGBA, full page dimensions).  Produced by
        ``load_background``.  The same template is reused for every page.
    margin : int
        Left and right margin in pixels.  Also used as the bottom margin.
    scan_mode : str
        **Deprecated** — kept for backward compatibility only.  The ``convert_both``
        endpoint always passes ``'clean'`` and applies ``apply_photo_effect``
        externally on the returned pages.  Do NOT pass ``'photo'`` here; doing so
        would apply the photo effect inside this function AND again in the caller,
        producing a double-processed result.

    Returns
    -------
    list[np.ndarray]
        One RGBA array per rendered page.  Even an empty *lines* list returns
        a single blank page so callers always get at least one array.
    """
    page_h, page_w = background.shape[:2]
    bottom_margin  = margin

    if not lines:
        return [background.copy()]

    pages: list[np.ndarray] = []

    # Current page's mutable text canvas (transparent RGBA, same size as bg).
    text_canvas: np.ndarray | None = None
    y_cursor = _TOP_MARGIN

    if scan_mode == 'photo':
        logger.warning(
            "render_full_page called with scan_mode='photo' — this path is deprecated. "
            "Call apply_photo_effect() on the returned pages instead to avoid "
            "accidental double photo-effect application."
        )

    def _flush_page(canvas: np.ndarray) -> np.ndarray:
        """Composite text canvas onto background, then draw the red margin line."""
        page = composite_text_on_background(canvas, background.copy())
        # Red margin line on the RIGHT side — Hebrew text starts from the right,
        # so the margin line marks the right edge of the writing area.
        # x = page_w - margin (right margin, mirrors PreviewScreen's `right: marginLineX`).
        # Width: 8 px ≈ 1.2 px on screen — clearly visible after downscaling.
        pil_page = Image.fromarray(page, "RGBA")
        draw     = ImageDraw.Draw(pil_page)
        draw.line([(page_w - margin, 0), (page_w - margin, page_h)], fill=_MARGIN_COLOUR, width=8)
        return np.array(pil_page, dtype=np.uint8)

    for line_idx, line_img in enumerate(lines):
        lh = line_img.shape[0]   # always _LINE_HEIGHT (120 px) from synthesiser
        lw = line_img.shape[1]   # varies with text content

        # Apply baseline tilt: each line independently slopes up or down.
        if slant_px > 0.5:
            # Alternate direction per line with small random variation
            seed      = (line_idx * 2654435761) & 0xFFFFFFFF
            direction = 1 if (seed >> 16) & 1 else -1
            variation = 0.6 + 0.8 * ((seed & 0xFFFF) / 65535.0)  # 0.6-1.4×
            this_tilt = direction * slant_px * variation
            tilted, top_offset = _tilt_line(line_img, this_tilt)
        else:
            tilted, top_offset = line_img, 0

        th = tilted.shape[0]
        tw = tilted.shape[1]

        # Check whether this line fits on the current page.
        if y_cursor + lh > page_h - bottom_margin:
            if text_canvas is not None:
                pages.append(_flush_page(text_canvas))
            text_canvas = None
            y_cursor    = _TOP_MARGIN

        if text_canvas is None:
            text_canvas = np.zeros((page_h, page_w, 4), dtype=np.uint8)

        # Right-align the line within the usable width.
        x = max(margin, page_w - tw - margin)

        # Paste position: shift up by top_offset so baseline aligns with y_cursor
        paste_y = y_cursor - top_offset
        paste_y = max(0, paste_y)

        paste_h = min(th, page_h - paste_y)
        paste_w = min(tw, page_w - x)
        if paste_h > 0 and paste_w > 0:
            text_canvas[paste_y : paste_y + paste_h, x : x + paste_w] = (
                tilted[:paste_h, :paste_w]
            )

        y_cursor += lh + _LINE_GAP

    # Flush the last (possibly only) page.
    if text_canvas is not None:
        pages.append(_flush_page(text_canvas))

    return pages


# ---------------------------------------------------------------------------
# Watermarking
# ---------------------------------------------------------------------------

def embed_watermark(image: np.ndarray, user_id: str) -> np.ndarray:
    """
    Embed an invisible watermark into *image* encoding a truncated user ID
    and a unix timestamp.

    Payload (8 bytes)
    -----------------
    Bytes 0-3 : first 4 bytes of SHA-256(user_id) — not reversible to the original ID
    Bytes 4-7 : ``int(time.time()) % 9999`` packed as a big-endian 32-bit int

    The watermark is written using the ``dwtDct`` method from the
    ``invisible-watermark`` library, which operates on the luminance of a BGR
    image.  The alpha channel (if present) is stripped before watermarking and
    re-attached afterwards so that compositing is not affected.

    Graceful fallback
    -----------------
    If ``imwatermark`` is unavailable (ImportError) or if encoding fails for
    any reason, the original image is returned unchanged and a warning is logged.

    Parameters
    ----------
    image : np.ndarray
        RGBA uint8 array (H × W × 4).
    user_id : str
        User identifier; only the first 4 characters are encoded.

    Returns
    -------
    np.ndarray
        RGBA uint8 array with the watermark embedded in the RGB channels.
    """
    try:
        from imwatermark import WatermarkEncoder  # type: ignore
    except ImportError:
        logger.warning("invisible-watermark not installed — skipping watermark")
        return image

    try:
        # Build 8-byte payload:
        #   Bytes 0-3: first 4 bytes of SHA-256(user_id) — user fingerprint
        #   Bytes 4-7: Unix timestamp (seconds since epoch, full 32-bit value)
        #              Previously was `int(time.time()) % 9999` which cycled every
        #              ~2.77 hours — useless for forensic dating.  The full timestamp
        #              fits in a uint32 until year 2106 and allows pinpointing when
        #              a page was rendered to the nearest second.
        uid_bytes = hashlib.sha256(user_id.encode()).digest()[:4]
        ts_int    = int(time.time()) & 0xFFFFFFFF   # full uint32 Unix timestamp
        payload   = uid_bytes + struct.pack(">I", ts_int)  # 4 + 4 = 8 bytes

        # Strip alpha, work on BGR (OpenCV convention expected by imwatermark)
        alpha     = image[:, :, 3:4].copy()
        bgr       = image[:, :, [2, 1, 0]].copy()   # RGBA -> BGR

        encoder   = WatermarkEncoder()
        encoder.set_watermark("bytes", payload)
        bgr_wm    = encoder.encode(bgr, "dwtDct")

        # Reconstruct RGBA
        rgba = np.concatenate(
            [bgr_wm[:, :, [2, 1, 0]], alpha], axis=2  # BGR -> RGB, reattach A
        ).astype(np.uint8)
        return rgba

    except Exception as exc:
        logger.warning("Watermark embedding failed (%s) — returning original", exc)
        return image


# ---------------------------------------------------------------------------
# Page export
# ---------------------------------------------------------------------------

def export_page(page: np.ndarray, output_format: str, output_path: str) -> str:
    """
    Save a rendered page array to disk as PNG or PDF.

    Parameters
    ----------
    page : np.ndarray
        RGBA uint8 array (H × W × 4) produced by ``render_full_page``.
    output_format : str
        ``"png"`` or ``"pdf"``.
    output_path : str
        Destination file path (including extension).

    Returns
    -------
    str
        The resolved *output_path* that was written.

    Raises
    ------
    ValueError
        If *output_format* is not ``"png"`` or ``"pdf"``.
    RuntimeError
        If ``img2pdf`` is required but not installed.
    """
    pil_img = Image.fromarray(page, "RGBA")

    if output_format == "png":
        # compress_level=1 is the fastest lossless level; optimize=True runs
        # the PNG encoder's Huffman pass for smaller files at negligible cost.
        pil_img.save(output_path, format="PNG", compress_level=1, optimize=True)
        return output_path

    if output_format == "pdf":
        try:
            import img2pdf  # type: ignore
        except ImportError as exc:
            raise RuntimeError("img2pdf is required for PDF export") from exc

        # img2pdf expects an RGB or L-mode image (no alpha).
        rgb_img = Image.new("RGB", pil_img.size, (255, 255, 255))
        rgb_img.paste(pil_img, mask=pil_img.split()[3])   # composite onto white

        import io
        buf = io.BytesIO()
        rgb_img.save(buf, format="PNG")
        buf.seek(0)

        # img2pdf.convert accepts raw image bytes; set DPI metadata to 300.
        a4_layout = img2pdf.get_layout_fun(
            (img2pdf.in_to_pt(8.27), img2pdf.in_to_pt(11.69))  # A4 in points
        )
        pdf_bytes = img2pdf.convert(buf.read(), layout_fun=a4_layout)
        with open(output_path, "wb") as fh:
            fh.write(pdf_bytes)
        return output_path

    raise ValueError(
        f"Unknown output_format {output_format!r}. Valid options: 'png', 'pdf'."
    )


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import os
    import sys

    out_dir = os.path.join(os.path.dirname(__file__), "..", "test_output_layout")
    os.makedirs(out_dir, exist_ok=True)

    # --- backgrounds ---
    for bg_type in ("blank", "lines", "grid"):
        bg = load_background(bg_type)
        assert bg.shape == (_PAGE_H, _PAGE_W, 4), f"Wrong shape for {bg_type!r}"
        assert bg.dtype == np.uint8
        out = Image.fromarray(bg, "RGBA")
        path = os.path.join(out_dir, f"bg_{bg_type}.png")
        out.save(path)
        print(f"Saved {bg_type!r} background  ({bg.shape[1]}x{bg.shape[0]})  -> {path}")

    # --- invalid bg_type raises ---
    try:
        load_background("polka")
        print("ERROR: should have raised ValueError")
        sys.exit(1)
    except ValueError:
        print("Invalid bg_type correctly raises ValueError")

    # --- composite: ink on blank ---
    # Create a tiny text layer with a few dark pixels
    bg  = load_background("blank", size=(200, 200))
    txt = np.zeros((200, 200, 4), dtype=np.uint8)
    txt[80:120, 80:120, :3] = 20    # near-black ink
    txt[80:120, 80:120,  3] = 240   # mostly opaque
    result = composite_text_on_background(txt, bg)
    assert result.shape == (200, 200, 4)
    assert result[:, :, 3].min() == 255, "Output alpha must be fully opaque"
    # Ink region should be darker than the white background
    assert result[100, 100, 0] < 255, "Multiply blend did not darken ink region"
    print("composite_text_on_background: ink region correctly darkened")

    # --- composite: white text layer leaves background unchanged ---
    bg2  = load_background("lines", size=(200, 200))
    txt2 = np.full((200, 200, 4), 255, dtype=np.uint8)   # all-white opaque layer
    res2 = composite_text_on_background(txt2, bg2)
    np.testing.assert_array_equal(
        bg2[:, :, :3], res2[:, :, :3],
        err_msg="Multiplying by white (255) must leave background unchanged",
    )
    print("composite_text_on_background: white layer leaves background unchanged")

    # --- render_full_page: empty lines returns one blank page ---
    bg3   = load_background("blank")
    pages = render_full_page([], bg3)
    assert len(pages) == 1
    assert pages[0].shape == bg3.shape
    print("render_full_page([]): returns one page")

    # --- render_full_page: overflow creates multiple pages ---
    # Synthetic lines: 120px tall, 800px wide
    synth_line = np.zeros((120, 800, 4), dtype=np.uint8)
    synth_line[:, :, :3] = 30
    synth_line[:, :,  3] = 200

    # How many lines fit on one page?
    usable_h  = _PAGE_H - _TOP_MARGIN - 120   # bottom margin = default 120
    lines_per_page = usable_h // (120 + _LINE_GAP)
    many_lines = [synth_line] * (lines_per_page + 5)   # definitely needs 2 pages
    pages = render_full_page(many_lines, bg3)
    assert len(pages) >= 2, f"Expected >= 2 pages, got {len(pages)}"
    for i, page in enumerate(pages):
        assert page.shape == bg3.shape
        path = os.path.join(out_dir, f"page_{i + 1:02d}.png")
        Image.fromarray(page, "RGBA").save(path)
    print(f"render_full_page overflow: {len(pages)} pages created")

    # --- watermark round-trip ---
    bg_wm  = load_background("blank")
    wm_out = embed_watermark(bg_wm, "test_user")
    assert wm_out.shape == bg_wm.shape, "Watermarked image shape changed"

    try:
        from imwatermark import WatermarkDecoder  # type: ignore
        decoder   = WatermarkDecoder("bytes", 8)
        bgr_check = wm_out[:, :, [2, 1, 0]].copy()  # RGBA → BGR
        extracted = decoder.decode(bgr_check, "dwtDct")
        print(f"Extracted watermark bytes : {extracted!r}")
        uid_part  = extracted[:4].decode("ascii", errors="replace").strip()
        print(f"Embedded user prefix      : {uid_part!r}  (expected 'test')")
        assert uid_part == "test", f"User prefix mismatch: {uid_part!r}"
        print("Watermark round-trip: OK — invisible to eye, recoverable programmatically")
    except ImportError:
        print("invisible-watermark not installed — skipping extraction check")

    print()
    print("All layout smoke tests passed.")
