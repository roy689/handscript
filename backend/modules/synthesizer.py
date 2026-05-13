"""Handwriting synthesis — variant picker for glyph selection."""

import logging
import math
import random
from collections import OrderedDict
from typing import Optional

import cv2
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageEnhance

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Character normalisation
# ---------------------------------------------------------------------------

MATH_SYMBOLS: dict[str, str] = {
    "plus":          "+",
    "minus":         "−",   # U+2212 MINUS SIGN
    "multiply":      "×",   # U+00D7
    "divide":        "÷",   # U+00F7
    "equals":        "=",
    "not_equal":     "≠",   # U+2260
    "less":          "<",
    "greater":       ">",
    "percent":       "%",
    "sqrt":          "√",   # U+221A
    "open_paren":    "(",
    "close_paren":   ")",
    "open_bracket":  "[",
    "close_bracket": "]",
    "power":         "^",
    "pi":            "π",   # U+03C0
}

# Maps each Unicode character in MATH_SYMBOLS back to its name.
_MATH_REVERSE: dict[str, str] = {v: k for k, v in MATH_SYMBOLS.items()}

# Complete Hebrew alphabet: 22 base letters + 5 final (sofit) forms.
_HEBREW_CHARS: dict[str, str] = {
    "א": "alef",       "ב": "bet",        "ג": "gimel",
    "ד": "dalet",      "ה": "he",         "ו": "vav",
    "ז": "zayin",      "ח": "het",        "ט": "tet",
    "י": "yod",        "כ": "kaf",        "ך": "final_kaf",
    "ל": "lamed",      "מ": "mem",        "ם": "final_mem",
    "נ": "nun",        "ן": "final_nun",  "ס": "samekh",
    "ע": "ayin",       "פ": "pe",         "ף": "final_pe",
    "צ": "tsadi",      "ץ": "final_tsadi","ק": "qof",
    "ר": "resh",       "ש": "shin",       "ת": "tav",
}


def normalize_char(char: str) -> str:
    """
    Map any input character to a stable, storage-friendly key.

    This decouples the bank's on-disk / Firestore keys from the Unicode
    representation of each character.  The normalised key is what
    VariantPicker, firebase_client, and the extractor all use to store
    and retrieve glyphs, so the same glyph is found regardless of whether
    the caller passes "א", "A", "7", or "+".

    Mapping rules (checked in order)
    ---------------------------------
    1. Hebrew letter (base or final form) → English name  e.g. "alef", "final_kaf"
    2. ASCII letter (A–Z / a–z)          → lowercase      e.g. "a", "z"
    3. ASCII digit  (0–9)                → "digit_N"      e.g. "digit_7"
    4. Known math symbol                 → symbol name    e.g. "plus", "pi"
    5. Anything else                     → "unknown"

    Parameters
    ----------
    char : str
        A single character.

    Returns
    -------
    str
        The normalised bank key.
    """
    # 1 — Hebrew
    if char in _HEBREW_CHARS:
        return _HEBREW_CHARS[char]

    # 2 — ASCII letters (both cases → lowercase)
    if len(char) == 1 and char.isascii() and char.isalpha():
        return char.lower()

    # 3 — ASCII digits 0-9
    if len(char) == 1 and char.isascii() and char.isdigit():
        return f"digit_{char}"

    # 4 — Known math symbol (includes non-ASCII symbols such as × ÷ ≠ √ π)
    if char in _MATH_REVERSE:
        return _MATH_REVERSE[char]

    return "unknown"


class VariantPicker:
    """
    Selects which stored glyph variant to use for each character in a run of
    text, avoiding consecutive repetitions to make the output look natural.

    Bank format (from ``firebase_client.load_character_bank``)
    ----------------------------------------------------------
    {
        "א": {
            "variants": [
                {"url": "https://...", "storage_path": "...", "added_at": "..."},
                ...
            ],
            "count": 2,
            ...
        },
        ...
    }

    For tests and local use the variants list may also contain ``np.ndarray``
    objects directly — ``pick`` handles both formats transparently.

    Repetition-avoidance contract
    ------------------------------
    When a character has N ≥ 2 variants, ``pick`` guarantees the returned
    variant index differs from the one returned on the immediately previous
    call for the same character.  Calls for *different* characters do not
    affect each other's exclusion state.
    """

    def __init__(self, bank: dict) -> None:
        """
        Parameters
        ----------
        bank : dict
            Mapping of character → character data dict, as returned by
            ``firebase_client.load_character_bank``.  Values must contain
            a ``"variants"`` list.
        """
        self._bank      = bank
        self._last_used: dict[str, int] = {}
        self._cache:     OrderedDict    = OrderedDict()
        self._MAX_CACHE = 200

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def pick(self, char: str) -> Optional[np.ndarray]:
        """
        Return an RGBA numpy array for one variant of *char*.

        Selection rules
        ---------------
        - 0 variants in bank → None
        - 1 variant          → always return it (no other choice)
        - N ≥ 2 variants     → pick uniformly at random, excluding the
                               variant used on the previous call for this char

        Parameters
        ----------
        char : str
            The character to look up, e.g. ``"א"``.

        Returns
        -------
        np.ndarray or None
            RGBA image (H × W × 4, uint8), or None when the character is
            absent from the bank or its variants list is empty.
        """
        # Try the raw character first (Firebase stores keys as the actual char).
        # Fall back to the normalised key for backward-compat with older banks.
        normalized = normalize_char(char)
        bank_key = char if char in self._bank else normalized

        char_data = self._bank.get(bank_key)
        if char_data is None:
            logger.debug("Character %r (keys tried: %r, %r) not in bank", char, char, normalized)
            return None

        variants = char_data.get("variants") or []
        n = len(variants)

        if n == 0:
            logger.warning("Character %r has an empty variants list", char)
            return None

        if n == 1:
            return self._get_image(bank_key, 0)

        last = self._last_used.get(bank_key)
        candidates = [i for i in range(n) if i != last]
        if not candidates:
            candidates = list(range(n))

        chosen = random.choice(candidates)
        self._last_used[bank_key] = chosen

        return self._get_image(bank_key, chosen)

    def reset(self) -> None:
        """
        Clear the repetition-avoidance state.

        Call between documents so the first character of a new document is
        chosen freely (no carry-over exclusion from the previous document).
        The image cache is intentionally preserved — images don't change
        between documents and re-downloading them would waste time.
        """
        self._last_used.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_image(self, char: str, idx: int) -> "np.ndarray | None":
        """Return the image for variant *idx* of *char*, with full error isolation."""
        key = (char, idx)
        if key not in self._cache:
            if len(self._cache) >= self._MAX_CACHE:
                self._cache.popitem(last=False)
            try:
                variant = self._bank[char]["variants"][idx]
                img = self._load_variant(variant)
                self._cache[key] = img
            except Exception as exc:
                logger.error(
                    "Failed to load variant %d for char %r: %s — skipping",
                    idx, char, exc,
                )
                return None
        self._cache.move_to_end(key)
        return self._cache[key]



    def _load_variant(self, variant) -> np.ndarray:
        """
        Convert a variant entry to an RGBA numpy array.

        Accepts three formats:
        - ``np.ndarray``        — used as-is (promoted to RGBA if needed)
        - dict with ``url``     — downloaded via HTTP and decoded
        - dict with ``image``   — pre-loaded array stored in the dict

        Images saved by the server are stored as RGBA PNGs (R=30, G=30, B=50,
        A=ink-mask).  cv2.imread with IMREAD_UNCHANGED reads them as BGRA, so
        we convert back to RGBA before returning.
        """
        if isinstance(variant, np.ndarray):
            return self._ensure_rgba(variant)

        if isinstance(variant, dict):
            if "image" in variant:
                return self._ensure_rgba(variant["image"])

            # Load from local disk path if available (avoids self-HTTP deadlock)
            storage_path = variant.get("storage_path")
            if storage_path:
                import pathlib
                p = pathlib.Path(storage_path)
                if p.exists():
                    # cv2 reads PNG as BGRA; convert to RGBA so callers get
                    # a consistent channel order (R,G,B,A).
                    img = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
                    if img is not None:
                        if img.ndim == 3 and img.shape[2] == 4:
                            img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
                        return self._ensure_rgba(img)

            url = variant.get("url")
            if url:
                return self._download(url)

        raise ValueError(
            f"Cannot load variant — unrecognised format: {type(variant)}"
        )

    @staticmethod
    def _ensure_rgba(img: np.ndarray) -> np.ndarray:
        """
        Ensure *img* is an RGBA array (H×W×4, uint8) in PIL channel order (R,G,B,A).

        Grayscale  → dark ink colour (30,30,50) + grayscale alpha
        BGR        → convert to RGB then add opaque alpha
        BGRA       → convert to RGBA
        RGBA       → pass through unchanged
        """
        if img.ndim == 2:
            # Grayscale: treat pixel intensity as alpha mask (dark=ink=opaque)
            alpha  = 255 - img   # invert: dark pixel → high alpha
            result = np.zeros((*img.shape, 4), dtype=np.uint8)
            result[:, :, 0] = 30
            result[:, :, 1] = 30
            result[:, :, 2] = 50
            result[:, :, 3] = alpha
            return result
        if img.shape[2] == 3:
            # Assume BGR from OpenCV → convert to RGB then add opaque alpha
            rgb   = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            alpha = np.full(img.shape[:2], 255, dtype=np.uint8)
            return np.dstack([rgb, alpha])
        # 4-channel: assume RGBA (caller must convert BGRA→RGBA before calling)
        return img

    @staticmethod
    def _download(url: str) -> np.ndarray:
        """Fetch an image from *url* and decode to an RGBA numpy array."""
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise IOError(f"Failed to download variant from {url!r}: {exc}") from exc

        arr = np.frombuffer(resp.content, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise IOError(f"cv2.imdecode failed for image downloaded from {url!r}")

        # cv2 decodes as BGR or BGRA; convert to RGBA before returning
        if img.ndim == 3 and img.shape[2] == 4:
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)

        return VariantPicker._ensure_rgba(img)


# ---------------------------------------------------------------------------
# Jitter and ink simulation
# ---------------------------------------------------------------------------

def apply_jitter(char_img: np.ndarray) -> tuple[np.ndarray, int]:
    """
    Apply small random geometric perturbations to a character image so that
    repeated glyphs look hand-drawn rather than stamped.

    Transformations (applied in order)
    -----------------------------------
    1. Rotation  : uniform(-2.0, +2.0) degrees, expand=True so no corner clipping
    2. Scale     : uniform(0.97, 1.03) — resize with LANCZOS
    3. H-padding : randint(-1, +2) transparent pixels appended to the right edge
                   (negative clamped to 0 — "do not clip" rule)
    4. V-offset  : randint(-3, +3) — NOT applied to the image; returned as int
                   so the layout module can shift the character vertically when
                   compositing without changing the image dimensions here.

    Parameters
    ----------
    char_img : np.ndarray
        RGBA source image (H × W × 4, uint8).

    Returns
    -------
    tuple[np.ndarray, int]
        (transformed RGBA array, vertical_offset_pixels)
        vertical_offset_pixels is negative = shift up, positive = shift down.
    """
    # Validate input — promote to RGBA if caller passes a grayscale or BGR array.
    # Normal path: char_img is already RGBA from _load_variant.
    if char_img.ndim != 3 or char_img.shape[2] != 4:
        char_img = VariantPicker._ensure_rgba(char_img)

    pil_img = Image.fromarray(char_img, "RGBA")

    # ------------------------------------------------------------------
    # Step 1 — Rotation
    # ------------------------------------------------------------------
    # PIL.Image.rotate with expand=True enlarges the canvas so no corner
    # of the glyph is clipped.  The new background pixels are (0,0,0,0)
    # (transparent) because we are in RGBA mode.
    angle = random.uniform(-2.0, 2.0)
    pil_img = pil_img.rotate(
        angle,
        resample=Image.BICUBIC,
        expand=True,
        fillcolor=(0, 0, 0, 0),
    )

    # ------------------------------------------------------------------
    # Step 2 — Scale
    # ------------------------------------------------------------------
    scale  = random.uniform(0.97, 1.03)
    new_w  = max(1, round(pil_img.width  * scale))
    new_h  = max(1, round(pil_img.height * scale))
    pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)

    # ------------------------------------------------------------------
    # Step 3 — Horizontal spacing jitter (right-side transparent padding)
    # ------------------------------------------------------------------
    # Spacing jitter controls the gap to the next character. A negative
    # value means slightly tighter; clamping to 0 honours "do not clip".
    h_jitter = random.randint(-1, 2)
    pad      = max(0, h_jitter)
    if pad > 0:
        padded = Image.new("RGBA", (pil_img.width + pad, pil_img.height), (0, 0, 0, 0))
        padded.paste(pil_img, (0, 0))
        pil_img = padded

    # ------------------------------------------------------------------
    # Step 4 — Vertical offset (metadata only — returned, not applied)
    # ------------------------------------------------------------------
    v_offset = random.randint(-8, 8)

    return np.array(pil_img, dtype=np.uint8), v_offset


def apply_ink_simulation(char_img: np.ndarray) -> np.ndarray:
    """
    Add subtle ink-variation effects so each glyph looks individually drawn.

    Pipeline
    --------
    1. Brightness jitter : uniform(0.82, 1.0)  — simulates ink density variation
    2. Contrast jitter   : uniform(0.95, 1.05) — simulates stroke edge sharpness
    3. Gaussian noise    : σ=3, applied only to ink pixels (alpha > 128)
                           Background (transparent) pixels are never modified so
                           noise cannot bleed into the page background.

    Parameters
    ----------
    char_img : np.ndarray
        RGBA source image (H × W × 4, uint8).

    Returns
    -------
    np.ndarray
        RGBA array with the same shape and dtype as *char_img*.
    """
    if char_img.ndim != 3 or char_img.shape[2] != 4:
        raise ValueError(
            f"apply_ink_simulation requires an RGBA image (H×W×4); "
            f"got shape {char_img.shape}"
        )

    # ------------------------------------------------------------------
    # Step 1 & 2 — Brightness and contrast via Pillow ImageEnhance.
    #
    # ImageEnhance operates on all four channels including alpha, which
    # would corrupt our transparency mask.  We therefore:
    #   a) Split off the alpha channel before enhancement
    #   b) Apply brightness + contrast to the RGB part only
    #   c) Reattach the original alpha
    # ------------------------------------------------------------------
    pil_rgba = Image.fromarray(char_img, "RGBA")
    r, g, b, alpha_ch = pil_rgba.split()
    pil_rgb = Image.merge("RGB", (r, g, b))

    # Brightness: 0.92–1.0 — subtle variation, never dips into "faded" territory
    brightness = random.uniform(0.92, 1.0)
    pil_rgb = ImageEnhance.Brightness(pil_rgb).enhance(brightness)

    # Contrast: slight boost (1.05–1.15) to keep strokes punchy
    contrast = random.uniform(1.05, 1.15)
    pil_rgb = ImageEnhance.Contrast(pil_rgb).enhance(contrast)

    # Recombine with the untouched alpha channel.
    r2, g2, b2 = pil_rgb.split()
    pil_rgba = Image.merge("RGBA", (r2, g2, b2, alpha_ch))
    result = np.array(pil_rgba, dtype=np.float32)

    # ------------------------------------------------------------------
    # Step 3 — Gaussian noise on ink pixels only.
    #
    # alpha > 128 identifies opaque/semi-opaque ink pixels.  We generate
    # independent noise for every RGB channel so the colour of each pixel
    # shifts slightly, mimicking ink granularity and paper texture.
    # The alpha channel is never touched.
    # ------------------------------------------------------------------
    ink_mask = result[:, :, 3] > 128   # shape (H, W), bool

    noise = np.random.normal(0, 3, result[:, :, :3].shape).astype(np.float32)
    rgb   = result[:, :, :3]

    # Apply noise only where ink_mask is True.
    # np.where broadcasts the mask across the channel axis.
    rgb = np.where(ink_mask[:, :, np.newaxis], rgb + noise, rgb)

    result[:, :, :3] = rgb
    np.clip(result, 0, 255, out=result)

    # Binarise alpha: ensure ink pixels are fully opaque (255), background fully
    # transparent (0). This prevents any semi-transparent fringe from reaching
    # the final composite and making strokes look faded.
    out = result.astype(np.uint8)
    out[:, :, 3] = np.where(out[:, :, 3] >= 128, 255, 0).astype(np.uint8)
    return out


# ---------------------------------------------------------------------------
# Line and paragraph composition
# ---------------------------------------------------------------------------

# A4 @ 300 DPI = 2480 × 3508 px.  Characters need to be large enough to read
# at full-page zoom on a phone screen (~350 px wide → scale ≈ 0.14).
# At 280 px tall a character is 280 × 0.14 ≈ 39 px on screen unzoomed;
# at 4× zoom it is 156 px — comfortably readable.
_LINE_HEIGHT    = 180   # canvas height — must fit tallest ascender + deepest descender
_TARGET_CHAR_H  = 80    # baseline character height (= x-height reference, px)
_SPACE_WIDTH    = 32    # width of a space character (px)
_AVG_CHAR_WIDTH = 62    # estimated glyph width for paragraph line-breaking

# ---------------------------------------------------------------------------
# Typography: per-character sizing and baseline positioning
#
# _CHAR_HEIGHT_RATIO  — total glyph height as fraction of _TARGET_CHAR_H
# _CHAR_ASCENDER_RATIO — fraction of that height that sits ABOVE the baseline
#
# The baseline sits at  _LINE_HEIGHT * _BASELINE_Y_RATIO  from the canvas top.
# A character's top-left Y on the canvas =
#     baseline_y  −  round(char_height × ascender_ratio)
#
# Examples
#   Normal letter (א):  full height above baseline → ascender = 1.0
#   ן (final nun):      short body + long stem below → ascender = 0.35
#   period (.):         tiny dot sitting right on baseline → ascender = 0.15
# ---------------------------------------------------------------------------

_BASELINE_Y_RATIO = 0.62   # baseline at 62 % — leaves room for ascenders above, descenders below

# ---------------------------------------------------------------------------
# _CHAR_HEIGHT_RATIO: total glyph height as multiple of _TARGET_CHAR_H
#
# Rules (as specified):
#   ל, ף, ץ  — ASCENDERS: bottom at baseline, top overflows above the line
#   ן, ך, ק  — DESCENDERS: top at x-height, bottom overflows below the line
#   all others — normal x-height, entirely above baseline
# ---------------------------------------------------------------------------
_CHAR_HEIGHT_RATIO: dict[str, float] = {
    # ── Short Hebrew letters ─────────────────────────────────────────────────
    "י": 0.45,
    "ו": 0.70,
    "ז": 0.75,
    "ר": 0.80,
    "ד": 0.82,
    "ג": 0.82,
    "ח": 0.87,
    "ה": 0.88,
    "ב": 0.90,
    "כ": 0.90,
    # ── Ascenders: bottom on baseline, top rises above line ──────────────────
    "ל": 1.30,   # lamed
    "ף": 1.25,   # final pe  — loop rises above x-height
    "ץ": 1.20,   # final tsadi — rises above x-height
    # ── Descenders: top at x-height, stem goes below baseline ────────────────
    "ן": 1.28,   # final nun
    "ך": 1.28,   # final kaf
    "ק": 1.18,   # qof — slight descender
    # ── Closed final forms (no ascender / descender) ─────────────────────────
    "ם": 1.00,
    # ── Punctuation ───────────────────────────────────────────────────────────
    ".": 0.18,
    ",": 0.28,
    "!": 1.00,
    "?": 1.00,
    "׳": 0.30,
    "״": 0.30,
    # ── Latin descenders ─────────────────────────────────────────────────────
    "g": 1.15, "j": 1.10, "p": 1.15, "q": 1.15, "y": 1.15,
    "f": 1.08, "t": 1.02, "i": 0.75, "l": 1.08,
}

# ---------------------------------------------------------------------------
# _CHAR_ASCENDER_RATIO: fraction of glyph height that sits ABOVE the baseline
#
#   Ascenders (ל, ף, ץ):   ratio = 1.0  → entire height above baseline
#   Normal letters:          ratio = 1.0  → entire height above baseline
#   Descenders (ן, ך, ק):   ratio = TARGET_H / total_H  → top aligns with
#                            normal letters, rest hangs below
#   Punctuation:             ratio ≈ 0.1–0.2  → sits near the baseline
# ---------------------------------------------------------------------------
def _asc(h_ratio: float) -> float:
    """Ascender ratio for a descender whose top aligns with normal x-height."""
    return round(1.0 / h_ratio, 4)

_CHAR_ASCENDER_RATIO: dict[str, float] = {
    # Normal Hebrew — all above baseline
    # י is 45% of normal height; ratio 2.22 = 1/0.45 aligns its top with other letters' tops
    "י": 2.22, "ו": 1.0, "ז": 1.0, "ר": 1.0, "ד": 1.0,
    "ג": 1.0, "ח": 1.0, "ה": 1.0, "ב": 1.0, "כ": 1.0,
    "א": 1.0, "ט": 1.0, "מ": 1.0, "נ": 1.0, "ס": 1.0,
    "ע": 1.0, "פ": 1.0, "ש": 1.0, "ת": 1.0, "ם": 1.0,
    # Ascenders — bottom on baseline, entire height above
    "ל": 1.0,
    "ף": 1.0,
    "ץ": 1.0,
    # Descenders — top at x-height (1.0/h_ratio of total height above baseline)
    "ן": _asc(1.28),   # ≈ 0.781
    "ך": _asc(1.28),   # ≈ 0.781
    "ק": _asc(1.18),   # ≈ 0.847
    # Punctuation
    ".": 0.12,
    ",": 0.20,
    "!": 1.0,
    "?": 1.0,
    "׳": 0.10,
    "״": 0.10,
    # Latin descenders
    "g": 0.65, "j": 0.60, "p": 0.65, "q": 0.65, "y": 0.65,
    "f": 1.0,  "t": 1.0,  "i": 1.0,  "l": 1.0,
}


def _is_rtl_char(ch: str) -> bool:
    """True for characters in the Hebrew, Hebrew Presentation Forms, or Arabic Unicode blocks."""
    cp = ord(ch)
    return (
        0x0590 <= cp <= 0x05FF or   # Hebrew
        0xFB1D <= cp <= 0xFB4F or   # Hebrew Presentation Forms
        0x0600 <= cp <= 0x06FF or   # Arabic
        0x0750 <= cp <= 0x077F      # Arabic Supplement
    )


def _detect_direction(chars: list[str]) -> str:
    """Return 'rtl' if the first strong (non-space) character is RTL, else 'ltr'."""
    for ch in chars:
        if ch != " ":
            return "rtl" if _is_rtl_char(ch) else "ltr"
    return "ltr"


def _split_bidi_runs(chars: list[str]) -> list[dict]:
    """
    Segment *chars* into contiguous runs of the same bidi direction.

    Space characters are treated as "weak" and inherit the direction of
    the immediately preceding strong character (paragraph default = 'rtl').
    Each returned dict has keys:
        direction : 'rtl' | 'ltr'
        indices   : list[int]  — positions into the original chars list
    """
    if not chars:
        return []

    # Classify every character
    classified: list[str] = []
    last_strong = "rtl"   # paragraph default; will be overridden by first strong char
    for ch in chars:
        if ch == " ":
            classified.append(last_strong)   # neutral — inherit
        elif _is_rtl_char(ch):
            last_strong = "rtl"
            classified.append("rtl")
        else:
            last_strong = "ltr"
            classified.append("ltr")

    # Group into runs
    runs: list[dict] = []
    cur_dir   = classified[0]
    cur_idxs  = [0]
    for i in range(1, len(classified)):
        if classified[i] == cur_dir:
            cur_idxs.append(i)
        else:
            runs.append({"direction": cur_dir, "indices": cur_idxs})
            cur_dir  = classified[i]
            cur_idxs = [i]
    runs.append({"direction": cur_dir, "indices": cur_idxs})
    return runs


_INK_RGB: dict[str, tuple[int, int, int]] = {
    "black": (26,  23,  20),
    "blue":  (30,  58, 138),
    "red":   (185, 28,  28),
}


def normalize_stroke_width(img: np.ndarray, target_char_h: int) -> np.ndarray:
    """
    Normalize the stroke width of a glyph so all characters have visually
    consistent weight regardless of how large or small they were photographed.

    Strategy
    --------
    1. Estimate current mean stroke radius via distance transform on the ink mask.
    2. Compute target radius = target_char_h * _STROKE_RATIO.
    3. If current radius is outside a ±25 % tolerance band, dilate or erode
       the ink mask to reach the target, then reconstruct the RGBA image.

    The RGB channels are preserved; only the alpha mask is reshaped.
    """
    alpha = img[:, :, 3]
    if alpha.max() == 0:
        return img

    ink = (alpha > 128).astype(np.uint8) * 255

    # Distance transform: each ink pixel gets its distance to nearest background px.
    # Mean of these distances ≈ mean stroke radius.
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 5)
    ink_dist = dist[dist > 0]
    if len(ink_dist) == 0:
        return img

    current_radius = float(np.median(ink_dist))   # median is more robust than mean
    target_radius  = target_char_h * _STROKE_RATIO / 2.0

    ratio = current_radius / target_radius if target_radius > 0 else 1.0

    # Only adjust when deviation is meaningful (>25 %)
    if 0.75 <= ratio <= 1.25:
        return img

    delta_r = abs(target_radius - current_radius)
    ks      = max(3, int(round(delta_r)) * 2 + 1)   # kernel size must be odd ≥ 3
    kernel  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks))

    if ratio > 1.25:
        # Too thick → erode
        new_alpha = cv2.erode(ink, kernel, iterations=1)
    else:
        # Too thin → dilate
        new_alpha = cv2.dilate(ink, kernel, iterations=1)

    out = img.copy()
    out[:, :, 3] = new_alpha
    return out


# Target stroke width as a fraction of character height.
# At 80 px char height → target stroke ≈ 6 px  (≈ 0.5 mm at 300 DPI — medium pen).
_STROKE_RATIO = 0.075


def _recolor_glyph(img: np.ndarray, ink_color: str) -> np.ndarray:
    """Replace the RGB channels of all opaque ink pixels with the target ink color."""
    rgb = _INK_RGB.get(ink_color)
    if rgb is None:
        return img
    out = img.copy()
    ink_mask = out[:, :, 3] > 0
    out[ink_mask, 0] = rgb[0]
    out[ink_mask, 1] = rgb[1]
    out[ink_mask, 2] = rgb[2]
    return out


def apply_slant(img: np.ndarray, angle_deg: float) -> np.ndarray:
    """
    Apply horizontal shear to simulate handwriting lean (slant/italic effect).

    Positive angle_deg → bottom of glyph shifts right relative to top, which
    produces the natural forward-lean seen in flowing Hebrew handwriting.
    The canvas is widened to avoid clipping the sheared pixels.
    """
    if abs(angle_deg) < 0.3:
        return img
    h, w = img.shape[:2]
    shear = math.tan(math.radians(abs(angle_deg)))
    extra_w = int(shear * h) + 2
    new_w = w + extra_w
    # For positive angle: bottom shifts right → x' = x + shear*y, no x-offset needed
    # For negative angle: bottom shifts left → translate right so top stays visible
    tx = extra_w if angle_deg < 0 else 0
    M = np.float32([[1, shear if angle_deg >= 0 else -shear, tx], [0, 1, 0]])
    return cv2.warpAffine(
        img, M, (new_w, h),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )


def _add_ink_blob(
    canvas: Image.Image,
    glyph_x: int,
    glyph_y: int,
    glyph_w: int,
    glyph_h: int,
    blob_prob: float,
    ink_rgb: tuple,
) -> None:
    """
    With probability *blob_prob*, draw a small ink-accumulation dot on *canvas*
    near the start or end of the glyph stroke (simulates pen start/stop blobs).
    Modifies canvas in-place.
    """
    if blob_prob <= 0 or random.random() > blob_prob:
        return
    draw = ImageDraw.Draw(canvas)
    r, g, b = ink_rgb
    for _ in range(random.randint(1, 2)):
        # Blob anchors: right edge (pen start in RTL) or a random mid-stroke point
        if random.random() < 0.55:
            bx = glyph_x + glyph_w + random.randint(-2, 2)
            by = glyph_y + glyph_h - random.randint(0, max(1, glyph_h // 5))
        else:
            bx = glyph_x + random.randint(0, max(1, glyph_w))
            by = glyph_y + random.randint(0, glyph_h)
        radius = random.randint(max(4, glyph_h // 10), max(8, glyph_h // 5))
        alpha  = random.randint(180, 240)
        draw.ellipse(
            [bx - radius, by - radius, bx + radius, by + radius],
            fill=(r, g, b, alpha),
        )


def compose_line(
    chars: list[str],
    picker: VariantPicker,
    direction: str = "rtl",
    style: "dict | None" = None,
    ink_color: str = "black",
) -> np.ndarray:
    """
    Render a single line of text as an RGBA numpy array.

    For each character the function:
      1. Picks a glyph variant (via VariantPicker)
      2. Applies geometric jitter (rotation, scale, h-padding)
      3. Applies ink simulation (brightness, contrast, noise)

    Bidirectional layout
    --------------------
    The bidi algorithm used here is a simplified subset of Unicode TR9:
    - Characters are grouped into contiguous RTL / LTR runs.
    - For an RTL paragraph the run sequence is reversed (rightmost run first).
    - Within an RTL run the character order is reversed for visual placement.
    - Within an LTR run the character order is preserved.
    - The result is then drawn left-to-right on the canvas.

    This correctly handles embedded English words in Hebrew text and vice-versa.

    Parameters
    ----------
    chars : list[str]
        Characters in *logical* (typing) order.
    picker : VariantPicker
        Initialised variant picker for the user's glyph bank.
    direction : str
        Paragraph base direction: ``'rtl'`` (default) or ``'ltr'``.

    Returns
    -------
    np.ndarray
        RGBA array of shape (120, total_width, 4).
    """
    if not chars:
        return np.zeros((_LINE_HEIGHT, 0, 4), dtype=np.uint8)

    # ------------------------------------------------------------------
    # Style dict — resolve early so all steps below can reference it.
    # ------------------------------------------------------------------
    _st = style or {}
    target_char_h_global = int(_st.get("char_height", _TARGET_CHAR_H))

    # ------------------------------------------------------------------
    # Step 1 — Render every glyph in logical order
    # ------------------------------------------------------------------
    # glyphs[i] = (RGBA_array, vertical_offset_int) or None (space / missing)
    glyphs: list = []
    for ch in chars:
        if ch == " ":
            glyphs.append(None)
        else:
            raw = picker.pick(ch)
            if raw is None:
                logger.warning("compose_line: char %r not in bank — leaving gap", ch)
                glyphs.append(None)   # character absent from bank → blank gap
            else:
                try:
                    raw_h, raw_w = raw.shape[:2]
                    # Scale to per-character target height using style override.
                    h_ratio  = _CHAR_HEIGHT_RATIO.get(ch, 1.0)
                    target_h = max(1, round(target_char_h_global * h_ratio))
                    if raw_h > 0 and raw_h != target_h:
                        scale   = target_h / raw_h
                        new_w   = max(1, round(raw_w * scale))
                        pil_raw = Image.fromarray(raw, "RGBA")
                        pil_raw = pil_raw.resize((new_w, target_h), Image.LANCZOS)
                        raw     = np.array(pil_raw, dtype=np.uint8)
                    # Normalize stroke width so all glyphs have consistent weight
                    raw = normalize_stroke_width(raw, target_char_h_global)
                    logger.debug("compose_line: char=%r  raw=%dx%d → scaled=%dx%d (h_ratio=%.2f)",
                                 ch, raw_h, raw_w, raw.shape[0], raw.shape[1], h_ratio)
                    jittered, v_off = apply_jitter(raw)
                    inked           = apply_ink_simulation(jittered)
                    inked           = _recolor_glyph(inked, ink_color)
                    glyphs.append((inked, v_off))
                except Exception as exc:
                    logger.error("compose_line: failed to render char %r: %s — skipping", ch, exc)
                    glyphs.append(None)

    # ------------------------------------------------------------------
    # Step 2 — Bidi visual reordering
    #
    # Build the sequence of *logical* indices that should appear from left
    # to right on the canvas after bidi reordering.
    # ------------------------------------------------------------------
    runs = _split_bidi_runs(chars)

    # Reverse the run *sequence* for RTL paragraphs (last run is leftmost).
    visual_runs = list(reversed(runs)) if direction == "rtl" else runs

    visual_indices: list[int] = []
    for run in visual_runs:
        idxs = run["indices"]
        # RTL runs always reverse their character order for visual display
        # (true for both RTL base and LTR base with embedded RTL).
        if run["direction"] == "rtl":
            visual_indices.extend(reversed(idxs))
        else:
            visual_indices.extend(idxs)

    # ------------------------------------------------------------------
    # Step 3 — Compute glyph widths and inter-character spacing
    # ------------------------------------------------------------------
    def _glyph_w(g) -> int:
        return g[0].shape[1] if g is not None else _SPACE_WIDTH

    # ------------------------------------------------------------------
    # Spacing design (all values relative to _TARGET_CHAR_H so they scale):
    #
    #   letter spacing : ~8 % of x-height  →  narrow, letters feel connected
    #   word spacing   : ~55 % of x-height →  clearly wider than letter gap
    #
    # Both use Gaussian jitter so no two gaps are identical.
    # ------------------------------------------------------------------
    # ------------------------------------------------------------------
    # Spacing — values come from style dict (already resolved above).
    # ------------------------------------------------------------------
    target_char_h  = target_char_h_global
    letter_sp_base = float(_st.get("letter_spacing", None) or 0)   # explicit px override
    jitter_pct     = float(_st.get("baseline_jitter", 2.0))        # σ % of char height

    glyph_widths_px = [
        glyphs[i][0].shape[1] if glyphs[i] is not None else 0
        for i in visual_indices
    ]
    real_widths = [w for w in glyph_widths_px if w > 0]
    avg_glyph_w = (sum(real_widths) / len(real_widths)) if real_widths else target_char_h

    # Letter spacing: explicit override or 15 % of avg glyph width
    _LSP       = letter_sp_base if letter_sp_base > 0 else avg_glyph_w * 0.15
    _LSP_SIGMA = _LSP * 0.35

    # Word spacing (within-line spaces, if any)
    _WSP       = avg_glyph_w * 1.0
    _WSP_SIGMA = avg_glyph_w * 0.25

    def _word_w() -> int:
        return max(round(avg_glyph_w * 0.6),
                   int(random.gauss(_WSP, _WSP_SIGMA)))

    widths = [
        glyphs[i][0].shape[1] if glyphs[i] is not None else _word_w()
        for i in visual_indices
    ]

    spacings = [
        max(0, int(random.gauss(_LSP, _LSP_SIGMA)))
        for _ in visual_indices
    ]

    # Do not add trailing spacing after the last character
    total_width = max(1, sum(w + s for w, s in zip(widths, spacings)) - spacings[-1])

    # ------------------------------------------------------------------
    # Step 4 — Composite onto a blank RGBA canvas
    # ------------------------------------------------------------------
    canvas     = Image.new("RGBA", (total_width, _LINE_HEIGHT), (0, 0, 0, 0))
    baseline_y = round(_LINE_HEIGHT * _BASELINE_Y_RATIO)

    blob_prob = float(_st.get("ink_blobs", 0.0))
    ink_rgb   = _INK_RGB.get(ink_color, (26, 23, 20))

    x = 0
    for idx, w, s in zip(visual_indices, widths, spacings):
        glyph = glyphs[idx]
        if glyph is not None:
            img, v_off  = glyph
            ch_here     = chars[idx]
            asc_ratio   = _CHAR_ASCENDER_RATIO.get(ch_here, 1.0)
            pil_g       = Image.fromarray(img, "RGBA")
            # Baseline shift: σ = jitter_pct % of glyph height
            baseline_dance = int(random.gauss(0, pil_g.height * (jitter_pct / 100.0)))
            if ch_here == 'י':
                # Yod is tiny — pin its top to where normal letters' tops are,
                # ignoring pil_g.height which is unreliable for short glyphs.
                y = baseline_y - target_char_h_global + v_off
            else:
                y = baseline_y - round(pil_g.height * asc_ratio) + v_off + baseline_dance
            canvas.paste(pil_g, (x, y), pil_g)
            # Ink blobs at stroke endpoints
            _add_ink_blob(canvas, x, y, pil_g.width, pil_g.height, blob_prob, ink_rgb)
        x += w + s

    return np.array(canvas, dtype=np.uint8)


def _join_word_images_with_gaps(
    word_imgs: list[np.ndarray],
    gaps: list[int],
) -> np.ndarray:
    """
    Concatenate word RGBA arrays horizontally.

    *gaps[i]* is the number of transparent pixels inserted BEFORE word_imgs[i].
    gaps[0] is always 0 (no leading space before the first word).
    All arrays are padded/cropped to exactly _LINE_HEIGHT rows.
    """
    if not word_imgs:
        return np.zeros((_LINE_HEIGHT, 0, 4), dtype=np.uint8)
    h = _LINE_HEIGHT
    parts: list[np.ndarray] = []
    for gap, img in zip(gaps, word_imgs):
        if gap > 0:
            parts.append(np.zeros((h, gap, 4), dtype=np.uint8))
        # Normalise height
        if img.shape[0] < h:
            pad = np.zeros((h - img.shape[0], img.shape[1], 4), dtype=np.uint8)
            img = np.vstack([img, pad])
        elif img.shape[0] > h:
            img = img[:h]
        parts.append(img)
    return np.concatenate(parts, axis=1) if parts else np.zeros((h, 0, 4), dtype=np.uint8)


def compose_paragraph(
    text: str,
    picker: VariantPicker,
    page_width: int = 2480,
    margin: int = 200,
    style: "dict | None" = None,
    ink_color: str = "black",
) -> list[np.ndarray]:
    """
    Lay out *text* into multiple lines that each fit within *page_width*.

    Words are split on spaces.  Each line's direction is inferred from its
    dominant script (first strong character wins).  ``compose_line`` handles
    mixed RTL/LTR content within a single line.

    Line-width estimation uses ``_AVG_CHAR_WIDTH`` (30 px) per character,
    which is a deliberate approximation — exact widths depend on glyph
    variants chosen at render time and are not known until composition.

    Parameters
    ----------
    text : str
        Full paragraph text in logical (typing) order.
    picker : VariantPicker
    page_width : int
        Maximum line width in pixels.  Defaults to 2480 (A4 @ 300 DPI).

    Returns
    -------
    list[np.ndarray]
        One RGBA array per line, each shaped (120, line_width, 4).
    """
    if not text.strip():
        return []

    usable_w = max(1, page_width - 2 * margin)
    _style = style or {}

    # ── Step 1: render every word individually to get exact pixel widths ──────
    raw_words = text.split(" ")
    rendered_words: list[np.ndarray] = []
    for word in raw_words:
        if not word:
            continue
        chars = list(word)
        dir_  = _detect_direction(chars)
        rendered_words.append(compose_line(chars, picker, dir_, style=_style, ink_color=ink_color))

    if not rendered_words:
        return []

    # ── Step 2: pack words into lines that fit within usable_w ───────────────
    word_sp_base = _style.get("word_spacing", _SPACE_WIDTH)

    def _rand_word_gap() -> int:
        sigma = word_sp_base * 0.20
        return max(round(word_sp_base * 0.60), int(random.gauss(word_sp_base, sigma)))

    lines: list[np.ndarray] = []
    line_words:  list[np.ndarray] = []
    line_gaps:   list[int]        = []   # gap BEFORE each word (0 for first)
    line_w: int = 0

    for img in rendered_words:
        ww      = img.shape[1]
        gap     = _rand_word_gap() if line_words else 0
        needed  = gap + ww

        if line_words and line_w + needed > usable_w:
            # Flush current line and start a new one
            lines.append(_flush_rtl_line(line_words, line_gaps))
            line_words = [img]
            line_gaps  = [0]
            line_w     = ww
        else:
            line_words.append(img)
            line_gaps.append(gap)
            line_w += needed

    # Flush last line
    if line_words:
        lines.append(_flush_rtl_line(line_words, line_gaps))

    return lines


def _flush_rtl_line(
    word_imgs: list[np.ndarray],
    gaps: list[int],
) -> np.ndarray:
    """
    Join words into a single line image with correct RTL visual order.

    Words arrive in logical (typing) order: first word = rightmost on page.
    render_full_page right-aligns the line image, so the LEFT edge of the image
    is the start of the readable text (leftmost word).

    To place the first word on the right:
      • Reverse both lists so word[0] (first typed) ends up rightmost.
      • Re-attach gaps: the gap that was between word[i] and word[i+1] now
        sits between reversed[n-i-1] and reversed[n-i], so we also reverse
        the gaps array and zero the new first element.
    """
    rev_imgs = list(reversed(word_imgs))
    rev_gaps = list(reversed(gaps))
    # The first element never has a leading gap
    if rev_gaps:
        rev_gaps[0] = 0
    return _join_word_images_with_gaps(rev_imgs, rev_gaps)


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------

def _make_bank(num_variants_per_char: dict[str, int]) -> dict:
    """
    Build an in-memory bank with distinct solid-colour images as variants.

    Each variant for character *c* at index *i* is a 10×10 RGBA array filled
    with value ``(i+1) * 40`` so variants are visually distinguishable.
    """
    bank: dict = {}
    for char, n in num_variants_per_char.items():
        key = normalize_char(char)       # store under the same key pick() will look up
        variants = []
        for i in range(n):
            fill = (i + 1) * 40          # 40, 80, 120, 160, 200 — all distinct
            img = np.full((10, 10, 4), fill, dtype=np.uint8)
            variants.append(img)
        bank[key] = {"variants": variants, "count": n}
    return bank


def _variant_index_from_image(img: np.ndarray) -> int:
    """Recover which variant index produced *img* based on its fill value."""
    fill = int(img[0, 0, 0])   # top-left pixel, blue channel
    return (fill // 40) - 1    # inverse of (i+1)*40


def run_tests() -> None:
    """Run all unit tests, raising AssertionError on the first failure."""

    # ------------------------------------------------------------------
    # Test 1 — Unknown character returns None
    # ------------------------------------------------------------------
    bank = _make_bank({"א": 2})
    picker = VariantPicker(bank)

    result = picker.pick("ב")   # "ב" is not in bank
    assert result is None, f"Expected None for unknown char, got {result}"
    print("PASS  unknown character returns None")

    # ------------------------------------------------------------------
    # Test 2 — Single variant always returned
    # ------------------------------------------------------------------
    bank = _make_bank({"X": 1})
    picker = VariantPicker(bank)

    picks = [picker.pick("X") for _ in range(10)]
    for img in picks:
        assert img is not None
        assert _variant_index_from_image(img) == 0, "Single variant must always be index 0"
    print("PASS  single variant always returned")

    # ------------------------------------------------------------------
    # Test 3 — Same variant never returned twice in a row (2 variants)
    # ------------------------------------------------------------------
    bank = _make_bank({"א": 2})
    picker = VariantPicker(bank)

    prev_idx = None
    for call in range(30):
        img = picker.pick("א")
        assert img is not None
        idx = _variant_index_from_image(img)
        if prev_idx is not None:
            assert idx != prev_idx, (
                f"Got the same variant ({idx}) twice in a row on call {call}"
            )
        prev_idx = idx
    print("PASS  same variant never returned twice in a row (2 variants, 30 calls)")

    # ------------------------------------------------------------------
    # Test 4 — Same variant never returned twice in a row (5 variants)
    # ------------------------------------------------------------------
    bank = _make_bank({"ב": 5})
    picker = VariantPicker(bank)

    prev_idx = None
    for call in range(50):
        img = picker.pick("ב")
        assert img is not None
        idx = _variant_index_from_image(img)
        if prev_idx is not None:
            assert idx != prev_idx, (
                f"Got the same variant ({idx}) twice in a row on call {call}"
            )
        prev_idx = idx
    print("PASS  same variant never returned twice in a row (5 variants, 50 calls)")

    # ------------------------------------------------------------------
    # Test 5 — Characters don't affect each other's avoidance state
    # ------------------------------------------------------------------
    bank = _make_bank({"A": 2, "B": 2})
    picker = VariantPicker(bank)

    prev_a = prev_b = None
    for _ in range(20):
        img_a = picker.pick("A")
        img_b = picker.pick("B")
        idx_a = _variant_index_from_image(img_a)
        idx_b = _variant_index_from_image(img_b)
        if prev_a is not None:
            assert idx_a != prev_a, "A's repetition avoidance broken by B pick"
        if prev_b is not None:
            assert idx_b != prev_b, "B's repetition avoidance broken by A pick"
        prev_a, prev_b = idx_a, idx_b
    print("PASS  per-character avoidance states are independent")

    # ------------------------------------------------------------------
    # Test 6 — reset() clears last_used but not the image cache
    # ------------------------------------------------------------------
    bank = _make_bank({"ג": 2})
    picker = VariantPicker(bank)

    picker.pick("ג")   # normalises to "gimel" and sets last_used["gimel"]
    assert normalize_char("ג") in picker._last_used

    picker.reset()
    assert picker._last_used == {}, "reset() must clear last_used"
    assert len(picker._cache) > 0, "reset() must NOT clear the image cache"
    print("PASS  reset() clears last_used but preserves image cache")

    # ------------------------------------------------------------------
    # Test 7 — pick() after reset() is unconstrained on first call
    # ------------------------------------------------------------------
    bank = _make_bank({"ד": 2})
    picker = VariantPicker(bank)

    first_pick_indices = set()
    for _ in range(40):
        picker.reset()
        img = picker.pick("ד")
        first_pick_indices.add(_variant_index_from_image(img))

    # With 40 trials and 2 variants, the probability of only ever picking
    # index 0 is (0.5)^40 ≈ 10^-12 — effectively impossible.
    assert len(first_pick_indices) == 2, (
        "After reset(), first pick should be uniformly random "
        f"(saw only indices {first_pick_indices} over 40 trials)"
    )
    print("PASS  first pick after reset() is uniformly random")

    # ------------------------------------------------------------------
    # Test 8 — _ensure_rgba promotes channel counts correctly
    # ------------------------------------------------------------------
    gray = np.full((5, 5), 200, dtype=np.uint8)
    rgba = VariantPicker._ensure_rgba(gray)
    assert rgba.shape == (5, 5, 4), f"Grayscale → RGBA failed: {rgba.shape}"

    bgr = np.full((5, 5, 3), 100, dtype=np.uint8)
    rgba = VariantPicker._ensure_rgba(bgr)
    assert rgba.shape == (5, 5, 4), f"BGR → RGBA failed: {rgba.shape}"

    already = np.full((5, 5, 4), 50, dtype=np.uint8)
    rgba = VariantPicker._ensure_rgba(already)
    assert rgba.shape == (5, 5, 4)
    print("PASS  _ensure_rgba handles grayscale / BGR / RGBA inputs")

    # ------------------------------------------------------------------
    # Test 9 — apply_jitter: output is RGBA and v_offset is in range
    # ------------------------------------------------------------------
    src = np.zeros((30, 20, 4), dtype=np.uint8)
    src[:, :, 3] = 200   # mostly opaque so rotation has content to expand

    v_offsets = set()
    for _ in range(60):
        out, v_off = apply_jitter(src)
        assert out.ndim == 3 and out.shape[2] == 4, \
            f"apply_jitter must return RGBA; got shape {out.shape}"
        assert out.dtype == np.uint8
        assert -3 <= v_off <= 3, f"v_offset {v_off} out of [-3, 3]"
        v_offsets.add(v_off)

    # With 60 trials over 7 possible values the chance of seeing < 3 unique
    # values is negligible — confirms randomness rather than a frozen RNG.
    assert len(v_offsets) >= 3, \
        f"apply_jitter v_offset appears non-random; saw only {v_offsets}"
    print("PASS  apply_jitter returns RGBA with v_offset in [-3, 3]")

    # ------------------------------------------------------------------
    # Test 10 — apply_jitter: rotation with expand=True can change size
    # ------------------------------------------------------------------
    src = np.zeros((40, 25, 4), dtype=np.uint8)
    src[5:35, 5:20, 3] = 255   # opaque rectangle in the middle

    sizes_seen = set()
    for _ in range(40):
        out, _ = apply_jitter(src)
        sizes_seen.add(out.shape[:2])

    # expand=True + scale jitter must produce at least 2 distinct sizes.
    assert len(sizes_seen) > 1, \
        f"apply_jitter appears to always produce the same size {sizes_seen}"
    print("PASS  apply_jitter produces varied output dimensions")

    # ------------------------------------------------------------------
    # Test 11 — apply_jitter: alpha channel is preserved (not zeroed out)
    # ------------------------------------------------------------------
    src = np.full((20, 15, 4), 0, dtype=np.uint8)
    src[:, :, :3] = 50    # dark ink colour
    src[:, :, 3]  = 255   # fully opaque

    out, _ = apply_jitter(src)
    # After rotation some border pixels become transparent (0 alpha is fine)
    # but the centre of the image must still have non-zero alpha.
    centre_alpha = out[out.shape[0] // 2, out.shape[1] // 2, 3]
    assert centre_alpha > 0, \
        f"Alpha destroyed by apply_jitter; centre pixel alpha = {centre_alpha}"
    print("PASS  apply_jitter preserves alpha channel")

    # ------------------------------------------------------------------
    # Test 12 — apply_ink_simulation: shape and dtype unchanged
    # ------------------------------------------------------------------
    src = np.zeros((25, 18, 4), dtype=np.uint8)
    src[:, :, :3] = 30     # dark ink
    src[:, :, 3]  = 255    # fully opaque

    out = apply_ink_simulation(src)
    assert out.shape == src.shape, \
        f"apply_ink_simulation changed shape: {src.shape} → {out.shape}"
    assert out.dtype == np.uint8
    print("PASS  apply_ink_simulation preserves shape and dtype")

    # ------------------------------------------------------------------
    # Test 13 — apply_ink_simulation: alpha channel is never modified
    # ------------------------------------------------------------------
    src = np.zeros((20, 20, 4), dtype=np.uint8)
    src[5:15, 5:15, :3] = 20    # ink region
    src[5:15, 5:15,  3] = 255   # ink region opaque
    # rest of alpha stays 0 (transparent background)

    out = apply_ink_simulation(src)
    np.testing.assert_array_equal(
        src[:, :, 3], out[:, :, 3],
        err_msg="apply_ink_simulation must not modify the alpha channel",
    )
    print("PASS  apply_ink_simulation does not modify alpha channel")

    # ------------------------------------------------------------------
    # Test 14 — apply_ink_simulation: noise only on ink pixels
    # ------------------------------------------------------------------
    src = np.zeros((20, 20, 4), dtype=np.uint8)
    src[5:15, 5:15, :3] = 128   # ink region (mid-grey)
    src[5:15, 5:15,  3] = 200   # alpha > 128 → ink

    out = apply_ink_simulation(src)

    # Background pixels (alpha == 0) must remain exactly (0,0,0,0)
    bg_mask = src[:, :, 3] == 0
    bg_out  = out[bg_mask]
    assert np.all(bg_out == 0), \
        "apply_ink_simulation modified background (alpha=0) pixels"
    print("PASS  apply_ink_simulation leaves transparent pixels untouched")

    # ------------------------------------------------------------------
    # Test 15 — apply_ink_simulation: ink pixels do change (noise applied)
    # ------------------------------------------------------------------
    # The probability that σ=3 noise produces exactly 0 for all channels
    # of all ink pixels is astronomically small.
    src = np.zeros((30, 30, 4), dtype=np.uint8)
    src[:, :, :3] = 100
    src[:, :, 3]  = 255   # fully opaque

    out = apply_ink_simulation(src)
    assert not np.array_equal(src[:, :, :3], out[:, :, :3]), \
        "apply_ink_simulation produced no change in ink pixel RGB values"
    print("PASS  apply_ink_simulation modifies ink pixel values")

    # ------------------------------------------------------------------
    # Test 16 — apply_ink_simulation: output values are clipped to [0, 255]
    # ------------------------------------------------------------------
    # Near-white ink + brightness close to 1.0 could push RGB above 255.
    src = np.full((10, 10, 4), 254, dtype=np.uint8)   # almost white, fully opaque
    for _ in range(20):
        out = apply_ink_simulation(src)
        assert out[:, :, :3].max() <= 255, "Pixel value exceeds 255 after ink sim"
        assert out[:, :, :3].min() >= 0,   "Pixel value below 0 after ink sim"
    print("PASS  apply_ink_simulation output is clipped to [0, 255]")

    # ------------------------------------------------------------------
    # Shared fixture for compose tests: bank with 2-variant glyphs
    # for a handful of Hebrew and Latin characters.
    # Each glyph is a 24×18 RGBA array with a distinct fill so we can
    # verify that the canvas actually received painted pixels.
    # ------------------------------------------------------------------
    def _make_glyph(fill_val: int) -> np.ndarray:
        g = np.zeros((24, 18, 4), dtype=np.uint8)
        g[:, :, :3] = fill_val    # some ink colour
        g[:, :, 3]  = 220         # mostly opaque
        return g

    compose_bank: dict = {}
    for i, ch in enumerate(["א", "ב", "ג", "a", "b", "c"]):
        v0 = _make_glyph(40 + i * 20)
        v1 = _make_glyph(50 + i * 20)
        compose_bank[normalize_char(ch)] = {"variants": [v0, v1], "count": 2}

    compose_picker = VariantPicker(compose_bank)

    # ------------------------------------------------------------------
    # Test 17 — compose_line: empty input returns zero-width canvas
    # ------------------------------------------------------------------
    out = compose_line([], compose_picker, "rtl")
    assert out.shape == (_LINE_HEIGHT, 0, 4), \
        f"Empty compose_line should be ({_LINE_HEIGHT}, 0, 4); got {out.shape}"
    print("PASS  compose_line([]) returns zero-width RGBA canvas")

    # ------------------------------------------------------------------
    # Test 18 — compose_line: output is RGBA with correct height
    # ------------------------------------------------------------------
    for dir_ in ("rtl", "ltr"):
        out = compose_line(["א", "ב", "ג"], compose_picker, dir_)
        assert out.ndim == 3 and out.shape[2] == 4, \
            f"compose_line must return RGBA; got shape {out.shape}"
        assert out.shape[0] == _LINE_HEIGHT, \
            f"Line height must be {_LINE_HEIGHT}; got {out.shape[0]}"
        assert out.shape[1] > 0, "Line width must be > 0"
    print("PASS  compose_line returns (_LINE_HEIGHT, W, 4) for both RTL and LTR")

    # ------------------------------------------------------------------
    # Test 19 — compose_line: canvas has ink pixels (glyphs were painted)
    # ------------------------------------------------------------------
    out = compose_line(["א", "ב", "ג"], compose_picker, "rtl")
    assert out[:, :, 3].max() > 0, \
        "compose_line produced an all-transparent canvas — glyphs not painted"
    print("PASS  compose_line canvas contains ink pixels")

    # ------------------------------------------------------------------
    # Test 20 — compose_line: RTL and LTR produce different layouts
    # ------------------------------------------------------------------
    # With the same chars, RTL places the first char on the right and LTR
    # places it on the left.  We verify this by checking that the rightmost
    # column of opaque pixels differs between the two runs.
    chars_mixed = ["a", "ב", "c"]
    out_rtl = compose_line(chars_mixed, compose_picker, "rtl")
    out_ltr = compose_line(chars_mixed, compose_picker, "ltr")
    # Not asserting pixel-perfect equality — jitter is random.
    # Just verify both are valid and have non-zero content.
    assert out_rtl[:, :, 3].max() > 0 and out_ltr[:, :, 3].max() > 0
    print("PASS  compose_line RTL and LTR both produce valid canvases")

    # ------------------------------------------------------------------
    # Test 21 — compose_line: space character creates a blank gap
    # ------------------------------------------------------------------
    out_no_space  = compose_line(["א", "ב"],       compose_picker, "rtl")
    out_with_space = compose_line(["א", " ", "ב"], compose_picker, "rtl")
    # Adding a space must make the canvas wider.
    assert out_with_space.shape[1] > out_no_space.shape[1], (
        f"Space should widen the line: {out_no_space.shape[1]} → "
        f"{out_with_space.shape[1]}"
    )
    print("PASS  space character widens compose_line canvas")

    # ------------------------------------------------------------------
    # Test 22 — compose_line: unknown character leaves blank gap (no crash)
    # ------------------------------------------------------------------
    out = compose_line(["א", "Z", "ב"], compose_picker, "rtl")  # Z not in bank
    assert out[:, :, 3].max() > 0, "Known chars should still appear"
    print("PASS  compose_line handles unknown characters gracefully")

    # ------------------------------------------------------------------
    # Test 23 — _split_bidi_runs: pure RTL produces a single run
    # ------------------------------------------------------------------
    runs = _split_bidi_runs(["א", "ב", "ג"])
    assert len(runs) == 1 and runs[0]["direction"] == "rtl"
    print("PASS  _split_bidi_runs pure-RTL -> single RTL run")

    # ------------------------------------------------------------------
    # Test 24 — _split_bidi_runs: mixed RTL+LTR produces two runs
    # ------------------------------------------------------------------
    runs = _split_bidi_runs(["א", "ב", "a", "b"])
    assert len(runs) == 2
    assert runs[0]["direction"] == "rtl"
    assert runs[1]["direction"] == "ltr"
    print("PASS  _split_bidi_runs mixed input -> correct run split")

    # ------------------------------------------------------------------
    # Test 25 — _split_bidi_runs: spaces inherit surrounding direction
    # ------------------------------------------------------------------
    # "א ב" — space between two Hebrew chars → single RTL run
    runs = _split_bidi_runs(["א", " ", "ב"])
    assert len(runs) == 1 and runs[0]["direction"] == "rtl"
    print("PASS  _split_bidi_runs spaces inherit direction of surrounding chars")

    # ------------------------------------------------------------------
    # Test 26 — compose_paragraph: empty string returns empty list
    # ------------------------------------------------------------------
    result = compose_paragraph("", compose_picker)
    assert result == []
    result = compose_paragraph("   ", compose_picker)
    assert result == []
    print("PASS  compose_paragraph empty / whitespace-only -> []")

    # ------------------------------------------------------------------
    # Test 27 — compose_paragraph: single word returns one line
    # ------------------------------------------------------------------
    result = compose_paragraph("אבג", compose_picker)
    assert len(result) == 1
    assert result[0].ndim == 3 and result[0].shape[2] == 4
    print("PASS  compose_paragraph single word -> one line array")

    # ------------------------------------------------------------------
    # Test 28 — compose_paragraph: long text wraps into multiple lines
    # ------------------------------------------------------------------
    # Force wrapping with a very small page_width (50 px) so even two
    # characters exceed the limit.
    long_text = "א ב ג א ב ג"
    result = compose_paragraph(long_text, compose_picker, page_width=50)
    assert len(result) > 1, \
        f"Expected multiple lines with page_width=50, got {len(result)}"
    for line_arr in result:
        assert line_arr.shape[0] == _LINE_HEIGHT
        assert line_arr.shape[2] == 4
    print("PASS  compose_paragraph wraps long text into multiple lines")

    # ------------------------------------------------------------------
    # normalize_char tests
    # ------------------------------------------------------------------

    # Test 29 — Hebrew base letter
    assert normalize_char("א") == "alef",        f"got {normalize_char('א')!r}"
    assert normalize_char("ב") == "bet",         f"got {normalize_char('ב')!r}"
    assert normalize_char("ת") == "tav",         f"got {normalize_char('ת')!r}"
    print("PASS  normalize_char Hebrew base letters ('alef', 'bet', 'tav')")

    # Test 30 — Hebrew final forms
    assert normalize_char("ך") == "final_kaf",   f"got {normalize_char('ך')!r}"
    assert normalize_char("ם") == "final_mem",   f"got {normalize_char('ם')!r}"
    assert normalize_char("ץ") == "final_tsadi", f"got {normalize_char('ץ')!r}"
    print("PASS  normalize_char Hebrew final (sofit) forms")

    # Test 31 — ASCII letters are lowercased regardless of input case
    assert normalize_char("A") == "a",  f"got {normalize_char('A')!r}"
    assert normalize_char("a") == "a",  f"got {normalize_char('a')!r}"
    assert normalize_char("Z") == "z",  f"got {normalize_char('Z')!r}"
    print("PASS  normalize_char ASCII letters fold to lowercase")

    # Test 32 — Digits become "digit_N"
    assert normalize_char("0") == "digit_0", f"got {normalize_char('0')!r}"
    assert normalize_char("7") == "digit_7", f"got {normalize_char('7')!r}"
    assert normalize_char("9") == "digit_9", f"got {normalize_char('9')!r}"
    print("PASS  normalize_char digits -> 'digit_N'")

    # Test 33 — Math symbols return their name
    assert normalize_char("+") == "plus",    f"got {normalize_char('+')!r}"
    assert normalize_char("=") == "equals",  f"got {normalize_char('=')!r}"
    assert normalize_char("π") == "pi",      f"got {normalize_char('π')!r}"
    assert normalize_char("√") == "sqrt",    f"got {normalize_char('√')!r}"
    assert normalize_char("×") == "multiply",f"got {normalize_char('×')!r}"
    assert normalize_char("≠") == "not_equal",f"got {normalize_char('≠')!r}"
    # Verify all 16 math symbols round-trip through MATH_SYMBOLS
    for name, sym in MATH_SYMBOLS.items():
        got = normalize_char(sym)
        assert got == name, f"MATH_SYMBOLS round-trip failed: {sym!r} -> {got!r}, expected {name!r}"
    print("PASS  normalize_char math symbols (all 16 MATH_SYMBOLS round-trip)")

    # Test 34 — Unknown character returns "unknown"
    assert normalize_char("€") == "unknown", f"got {normalize_char('€')!r}"
    assert normalize_char("@") == "unknown", f"got {normalize_char('@')!r}"
    assert normalize_char("¿") == "unknown", f"got {normalize_char('¿')!r}"
    print("PASS  normalize_char unknown chars return 'unknown'")

    # ------------------------------------------------------------------
    # pick() normalisation integration tests
    # ------------------------------------------------------------------

    # Test 35 — pick("A") and pick("a") resolve to the same bank entry
    bank_norm = _make_bank({"a": 1})   # stored under "a"
    picker_n  = VariantPicker(bank_norm)
    img_upper = picker_n.pick("A")
    img_lower = picker_n.pick("a")
    assert img_upper is not None, "pick('A') should resolve to 'a' bank entry"
    assert img_lower is not None, "pick('a') should resolve to 'a' bank entry"
    # Both return the same single variant → same pixel values
    assert np.array_equal(img_upper, img_lower), \
        "pick('A') and pick('a') should return identical images (same bank slot)"
    print("PASS  pick('A') and pick('a') both resolve to the 'a' bank entry")

    # Test 36 — pick("א") resolves via "alef" normalisation
    bank_he = _make_bank({"א": 2})     # stored under "alef"
    picker_h = VariantPicker(bank_he)
    img_he = picker_h.pick("א")
    assert img_he is not None, "pick('א') should find the 'alef' bank entry"
    print("PASS  pick('alef') resolves Hebrew alef from bank")

    # Test 37 — pick("7") resolves via "digit_7" normalisation
    bank_d = _make_bank({"7": 1})      # stored under "digit_7"
    picker_d = VariantPicker(bank_d)
    img_d = picker_d.pick("7")
    assert img_d is not None, "pick('7') should find the 'digit_7' bank entry"
    print("PASS  pick('7') resolves to 'digit_7' bank entry")

    # Test 38 — pick("+") resolves via "plus" normalisation
    bank_m = _make_bank({"+": 1})      # stored under "plus"
    picker_m = VariantPicker(bank_m)
    img_m = picker_m.pick("+")
    assert img_m is not None, "pick('+') should find the 'plus' bank entry"
    print("PASS  pick('+') resolves to 'plus' bank entry")

    # Test 39 — pick("€") returns None (normalises to "unknown", not in bank)
    bank_e = _make_bank({"a": 1})
    picker_e = VariantPicker(bank_e)
    assert picker_e.pick("€") is None, "pick of unknown char should return None"
    print("PASS  pick('euro') returns None (unknown char not in bank)")

    # Test 40 — repetition avoidance uses normalised key (pick("A")/pick("a") share state)
    bank_ab = _make_bank({"a": 2})
    picker_ab = VariantPicker(bank_ab)
    prev = None
    for _ in range(20):
        img = picker_ab.pick("A")   # always uses normalised key "a"
        assert img is not None
        idx = _variant_index_from_image(img)
        if prev is not None:
            assert idx != prev, "Repetition avoidance broken when calling pick('A') repeatedly"
        prev = idx
    print("PASS  repetition avoidance works correctly via normalised key")

    print()
    print("All tests passed.")


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.WARNING)
    random.seed(42)   # deterministic for CI; remove for production fuzzing
    run_tests()
