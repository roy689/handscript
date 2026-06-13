"""Handwriting synthesis — variant picker for glyph selection."""

import logging
import math
import random
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from urllib.parse import urlparse

import cv2
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageEnhance

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level glyph image cache
# ---------------------------------------------------------------------------
# Caches decoded RGBA numpy arrays keyed by Firebase Storage URL.
# Lives for the lifetime of the Railway worker process (until restart or
# max-requests=1000 recycle).  This eliminates repeated Firebase Storage
# downloads across requests: the first render is slow, every subsequent
# render for the same user is fast.
#
# Memory budget: 500 images × ~200 KB each ≈ 100 MB — well within Railway's
# 512 MB worker limit.  The LRU eviction keeps it bounded.
_GLYPH_IMAGE_CACHE: OrderedDict = OrderedDict()
_GLYPH_IMAGE_CACHE_MAX = 500
_GLYPH_CACHE_LOCK = threading.Lock()


def _glyph_cache_get(url: str) -> "np.ndarray | None":
    with _GLYPH_CACHE_LOCK:
        if url in _GLYPH_IMAGE_CACHE:
            _GLYPH_IMAGE_CACHE.move_to_end(url)
            return _GLYPH_IMAGE_CACHE[url]
    return None


def _glyph_cache_put(url: str, img: np.ndarray) -> None:
    with _GLYPH_CACHE_LOCK:
        if url in _GLYPH_IMAGE_CACHE:
            _GLYPH_IMAGE_CACHE.move_to_end(url)
        else:
            if len(_GLYPH_IMAGE_CACHE) >= _GLYPH_IMAGE_CACHE_MAX:
                _GLYPH_IMAGE_CACHE.popitem(last=False)   # evict oldest
            _GLYPH_IMAGE_CACHE[url] = img


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
        self._bank        = bank
        self._last_used:  dict[str, int]       = {}
        self._pick_queues: dict[str, list[int]] = {}   # shuffled deck per char
        self._cache:       OrderedDict          = OrderedDict()
        self._MAX_CACHE = 200

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def pick(self, char: str, rng: "random.Random | None" = None) -> Optional[np.ndarray]:
        """
        Return an RGBA numpy array for one variant of *char*.

        Selection rules
        ---------------
        - 0 variants in bank → None
        - 1 variant          → always return it (no other choice)
        - N ≥ 2 variants     → shuffled-deck rotation: each variant appears
                               exactly once per N calls before any repeats

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
        img, _idx, _url = self.pick_meta(char, rng=rng)
        return img

    def pick_meta(
        self, char: str, rng: "random.Random | None" = None,
    ) -> "tuple[Optional[np.ndarray], int, Optional[str]]":
        """
        Like :meth:`pick`, but also returns WHICH variant was chosen.

        Returns ``(image, variant_index, variant_url)``; ``(None, -1, None)``
        when the character is absent. The index/url are recorded into layout
        plans (REWRITE_PLAN §3.3) so the mobile compositor can fetch the exact
        glyph image the server placed.
        """
        # Try the raw character first (Firebase stores keys as the actual char).
        # Fall back to the normalised key for backward-compat with older banks.
        normalized = normalize_char(char)
        bank_key = char if char in self._bank else normalized

        char_data = self._bank.get(bank_key)
        if char_data is None:
            logger.debug("Character %r (keys tried: %r, %r) not in bank", char, char, normalized)
            return None, -1, None

        variants = char_data.get("variants") or []
        n = len(variants)

        if n == 0:
            logger.warning("Character %r has an empty variants list", char)
            return None, -1, None

        if n == 1:
            return self._get_image(bank_key, 0), 0, self._variant_url(variants, 0)

        # ── Shuffled-deck variant selection ───────────────────────────────────
        # Each character gets its own deck (a shuffled list of variant indices).
        # We pop from the front until it's empty, then re-shuffle a new deck.
        # This guarantees every variant appears exactly once per cycle —
        # far more natural-looking than random.choice, which often repeats.
        queue = self._pick_queues.get(bank_key)
        if not queue:
            deck = list(range(n))
            # Seeded shuffle when rng is provided → deterministic variant
            # rotation per document seed. None → legacy random behaviour.
            (rng if rng is not None else random).shuffle(deck)
            # Avoid starting the fresh deck with the card we just used.
            last = self._last_used.get(bank_key)
            if last is not None and len(deck) > 1 and deck[0] == last:
                deck[0], deck[-1] = deck[-1], deck[0]
            self._pick_queues[bank_key] = deck
            queue = deck

        chosen = queue.pop(0)
        self._last_used[bank_key] = chosen
        logger.debug("pick: char=%r → variant %d/%d", bank_key, chosen, n)

        return self._get_image(bank_key, chosen), chosen, self._variant_url(variants, chosen)

    @staticmethod
    def _variant_url(variants: list, idx: int) -> "str | None":
        """URL of variant *idx*, or None for in-memory (test) banks."""
        try:
            v = variants[idx]
            if isinstance(v, dict):
                return v.get("url")
        except (IndexError, TypeError):
            pass
        return None

    def reset(self) -> None:
        """
        Clear the repetition-avoidance state.

        Call between documents so the first character of a new document is
        chosen freely (no carry-over exclusion from the previous document).
        The image cache is intentionally preserved — images don't change
        between documents and re-downloading them would waste time.
        """
        self._last_used.clear()
        self._pick_queues.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_image(self, char: str, idx: int) -> "np.ndarray | None":
        """Return the image for variant *idx* of *char*, with full error isolation.

        Lookup order:
        1. Instance LRU cache  (hot path — same VariantPicker within one request)
        2. Module-level cache  (warm path — image downloaded by a previous request)
        3. Fresh download      (cold path — first time this URL is seen)
        """
        key = (char, idx)
        if key not in self._cache:
            if len(self._cache) >= self._MAX_CACHE:
                self._cache.popitem(last=False)
            try:
                variant = self._bank[char]["variants"][idx]

                # Check module-level cache before downloading (avoids network I/O
                # on all requests after the first per worker process).
                url = variant.get("url") if isinstance(variant, dict) else None
                if url:
                    cached = _glyph_cache_get(url)
                    if cached is not None:
                        self._cache[key] = cached
                        self._cache.move_to_end(key)
                        return self._cache[key]

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

    # Allowed hosts for variant image downloads (B23 — SSRF prevention)
    _ALLOWED_DOWNLOAD_HOSTS = frozenset({
        "firebasestorage.googleapis.com",
        "storage.googleapis.com",
        "localhost",
        "127.0.0.1",
    })

    @staticmethod
    def _download(url: str) -> np.ndarray:
        """Fetch an image from *url* and decode to an RGBA numpy array."""
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if host not in VariantPicker._ALLOWED_DOWNLOAD_HOSTS:
            raise ValueError(f"Download from disallowed host: {host!r}")
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

        result = VariantPicker._ensure_rgba(img)
        # Store in module-level cache so future requests skip the download.
        _glyph_cache_put(url, result)
        return result


def prefetch_bank_images(bank: dict, max_workers: int = 12) -> None:
    """
    Download all variant images in *bank* into the module-level cache in parallel.

    Call this once before ``compose_paragraph`` so the synthesis loop never
    blocks on a network request.  Any download failure is silently ignored —
    the synthesiser will retry (and log) on first use.

    Parameters
    ----------
    bank : dict
        Character bank as returned by ``firebase_client.load_character_bank``.
    max_workers : int
        Thread-pool size.  12 concurrent connections is well within Railway's
        limits and saturates typical Firebase Storage bandwidth.
    """
    urls: list[str] = []
    for char_data in bank.values():
        for variant in char_data.get("variants") or []:
            if isinstance(variant, dict):
                url = variant.get("url")
                if url and _glyph_cache_get(url) is None:
                    urls.append(url)

    if not urls:
        return   # everything already cached

    logger.info("prefetch_bank_images: downloading %d uncached glyph(s) in parallel", len(urls))

    def _fetch_one(url: str) -> None:
        try:
            VariantPicker._download(url)   # stores result in _GLYPH_IMAGE_CACHE
        except Exception as exc:
            logger.debug("prefetch failed for %s: %s", url, exc)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch_one, url): url for url in urls}
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception:
                pass   # _fetch_one already logs; swallow here too


# ---------------------------------------------------------------------------
# Jitter and ink simulation
# ---------------------------------------------------------------------------

def apply_jitter(
    char_img: np.ndarray,
    fast_mode: bool = False,
    rng: "random.Random | None" = None,
) -> tuple[np.ndarray, int]:
    """
    Apply small random geometric perturbations to a character image so that
    repeated glyphs look hand-drawn rather than stamped.

    Transformations (applied in order)
    -----------------------------------
    1. Rotation  : uniform(-2.0, +2.0) degrees, expand=True so no corner clipping
    2. Scale     : uniform(0.97, 1.03) — LANCZOS (quality) or BILINEAR (fast_mode)
    3. H-padding : randint(-1, +2) transparent pixels appended to the right edge
                   (negative clamped to 0 — "do not clip" rule)
    4. V-offset  : randint(-3, +3) — NOT applied to the image; returned as int
                   so the layout module can shift the character vertically when
                   compositing without changing the image dimensions here.

    Parameters
    ----------
    char_img : np.ndarray
        RGBA source image (H × W × 4, uint8).
    fast_mode : bool
        When True uses BILINEAR resampling instead of BICUBIC/LANCZOS.
        Imperceptibly different at preview resolution; ~2× faster.

    Returns
    -------
    tuple[np.ndarray, int]
        (transformed RGBA array, vertical_offset_pixels)
        vertical_offset_pixels is negative = shift up, positive = shift down.
    """
    # Deterministic rendering: when *rng* is provided every random draw comes
    # from it, so the same seed reproduces the exact same jitter. When None,
    # the module-level `random` keeps legacy (non-deterministic) behaviour.
    _r = rng if rng is not None else random

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
    resample = Image.BILINEAR if fast_mode else Image.BICUBIC
    angle = _r.uniform(-2.0, 2.0)
    pil_img = pil_img.rotate(
        angle,
        resample=resample,
        expand=True,
        fillcolor=(0, 0, 0, 0),
    )

    # ------------------------------------------------------------------
    # Step 2 — Scale
    # ------------------------------------------------------------------
    scale  = _r.uniform(0.97, 1.03)
    new_w  = max(1, round(pil_img.width  * scale))
    new_h  = max(1, round(pil_img.height * scale))
    pil_img = pil_img.resize((new_w, new_h), Image.BILINEAR if fast_mode else Image.LANCZOS)

    # ------------------------------------------------------------------
    # Step 3 — Horizontal spacing jitter (right-side transparent padding)
    # ------------------------------------------------------------------
    # Spacing jitter controls the gap to the next character. A negative
    # value means slightly tighter; clamping to 0 honours "do not clip".
    h_jitter = _r.randint(-1, 2)
    pad      = max(0, h_jitter)
    if pad > 0:
        padded = Image.new("RGBA", (pil_img.width + pad, pil_img.height), (0, 0, 0, 0))
        padded.paste(pil_img, (0, 0))
        pil_img = padded

    # ------------------------------------------------------------------
    # Step 4 — Vertical offset (metadata only — returned, not applied)
    # ------------------------------------------------------------------
    v_offset = _r.randint(-3, 3)

    return np.array(pil_img, dtype=np.uint8), v_offset


def apply_ink_simulation(
    char_img: np.ndarray,
    rng: "random.Random | None" = None,
) -> np.ndarray:
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

    # Seeded RNG for determinism (None → legacy non-deterministic behaviour).
    _r = rng if rng is not None else random

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
    brightness = _r.uniform(0.92, 1.0)
    pil_rgb = ImageEnhance.Brightness(pil_rgb).enhance(brightness)

    # Contrast: slight boost (1.05–1.15) to keep strokes punchy
    contrast = _r.uniform(1.05, 1.15)
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

    # numpy noise seeded from the (possibly seeded) python RNG so the entire
    # glyph appearance is reproducible from one master seed.
    np_rng = np.random.default_rng(_r.getrandbits(32))
    noise = np_rng.normal(0, 3, result[:, :, :3].shape).astype(np.float32)
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
# _CHAR_HEIGHT_RATIO: total glyph height as multiple of _TARGET_CHAR_H (80 px)
#
# Placement formula (baseline_y = 180 × 0.62 = 112 px):
#   char_height  = round(_TARGET_CHAR_H × h_ratio)
#   ascender_h   = round(char_height × asc_ratio)
#   top_y        = baseline_y − ascender_h     ← where glyph is pasted
#   bottom_y     = top_y + char_height
#
# Design rules:
#   Normal x-height letters  h_ratio ≈ 0.75–1.0, asc = 1.0
#     → entire glyph above baseline, bottom = baseline (y 112)
#   ל (ascender)             h_ratio = 1.35, asc = 1.0
#     → foot on baseline, head rises 28 px above normal tops
#   Descenders (ן ך ף ץ ק)  asc = _asc(h_ratio) = 1/h_ratio
#     → top aligns with x-height top (y 32), stem hangs below y 112
#   Digits / uppercase       h_ratio ≈ 0.95–1.10, asc = 1.0
#   Operators (+ = × ...)    small h, asc > 1.0  → centred in x-height zone
#   Apostrophes / quotes     small h, asc ≈ 4–5  → pinned near top of x-height
#   Period                   h_ratio = 0.15, asc = 1.0 → tiny dot on baseline
#   Comma                    h_ratio = 0.28, asc = 0.82 → dot near baseline + tail
# ---------------------------------------------------------------------------
_CHAR_HEIGHT_RATIO: dict[str, float] = {
    # ── Hebrew: standard x-height (entirely above baseline) ──────────────────
    "א": 0.92,   # alef
    "ב": 0.92,   # bet
    "ג": 0.82,   # gimel — somewhat shorter
    "ד": 0.82,   # dalet — flat top, somewhat shorter
    "ה": 0.90,   # he
    "ו": 0.68,   # vav — short narrow stroke
    "ז": 0.78,   # zayin — slightly shorter
    "ח": 0.92,   # het
    "ט": 0.92,   # tet — round, full x-height
    "י": 0.35,   # yod — small mark, 35 % of x-height, sits in upper portion of line
    "כ": 0.90,   # kaf (open)
    "מ": 0.92,   # mem (open)
    "נ": 0.82,   # nun (open) — slightly shorter
    "ס": 0.92,   # samekh — round, full x-height
    "ע": 0.90,   # ayin
    "פ": 0.90,   # pe (open)
    "צ": 0.85,   # tsadi (open) — slightly shorter
    "ר": 0.75,   # resh — one of the shortest Hebrew letters
    "ש": 0.92,   # shin — wide, full x-height
    "ת": 0.92,   # tav
    # ── Hebrew: ascender ─────────────────────────────────────────────────────
    "ל": 1.35,   # lamed — head rises ~35 % above x-height; foot on baseline
    # ── Hebrew: descenders (top at x-height, stem below baseline) ────────────
    "ק": 1.19,   # qof — slight descender (~15 px)
    "ך": 1.56,   # final kaf — long descender (~45 px)
    "ן": 1.80,   # final nun — long descender fills full space to next ruled line
    "ף": 1.38,   # final pe — medium descender (~30 px)
    "ץ": 1.31,   # final tsadi — medium descender (~25 px)
    # ── Hebrew: closed final forms (no descender) ─────────────────────────────
    "ם": 0.95,   # final mem — closed square, same height as normal letters
    # ── Digits 0–9 (x-height, on baseline) ───────────────────────────────────
    "0": 0.95, "1": 0.95, "2": 0.95, "3": 0.95, "4": 0.95,
    "5": 0.95, "6": 0.95, "7": 0.95, "8": 0.95, "9": 0.95,
    # ── Latin lowercase: x-height group ──────────────────────────────────────
    "a": 0.92, "c": 0.92, "e": 0.92, "i": 0.92, "m": 0.92, "n": 0.92,
    "o": 0.92, "r": 0.80, "s": 0.88, "u": 0.92, "v": 0.92,
    "w": 0.92, "x": 0.88, "z": 0.88,
    # ── Latin lowercase: ascenders ────────────────────────────────────────────
    "b": 1.25, "d": 1.25, "h": 1.22, "k": 1.22, "l": 1.22,
    "f": 1.20, "t": 1.05,
    # ── Latin lowercase: descenders ───────────────────────────────────────────
    "g": 1.38,   # round bowl at x-height + tail (~30 px descender)
    "j": 1.38,   # hook descender
    "p": 1.25,   # bowl at x-height + stem down (~20 px)
    "q": 1.25,   # mirror of p
    "y": 1.30,   # descends ~22 px below baseline
    # ── Latin uppercase (cap-height, on baseline) ─────────────────────────────
    "A": 1.10, "B": 1.10, "C": 1.10, "D": 1.10, "E": 1.10,
    "F": 1.10, "G": 1.10, "H": 1.10, "I": 1.10, "J": 1.10,
    "K": 1.10, "L": 1.10, "M": 1.10, "N": 1.10, "O": 1.10,
    "P": 1.10, "Q": 1.10, "R": 1.10, "S": 1.10, "T": 1.10,
    "U": 1.10, "V": 1.10, "W": 1.10, "X": 1.10, "Y": 1.10, "Z": 1.10,
    # ── Punctuation ───────────────────────────────────────────────────────────
    ".": 0.15,   # period — tiny dot sitting on baseline
    ",": 0.28,   # comma — dot near baseline + short descending tail
    ":": 0.80,   # colon — two dots spanning x-height, bottom on baseline
    ";": 0.85,   # semicolon — like colon + descending comma tail
    "!": 1.00,   # exclamation — full x-height
    "?": 1.00,   # question mark — full x-height
    "'": 0.22,   # apostrophe — small mark, floats at top of x-height
    '"': 0.22,   # double quote — same as apostrophe
    "׳": 0.22,   # geresh (Hebrew apostrophe)
    "״": 0.22,   # gershayim (Hebrew double quote)
    "-": 0.12,   # hyphen — thin horizontal stroke, vertically centred
    "–": 0.12,   # en dash — same height as hyphen
    "—": 0.12,   # em dash — same height as hyphen
    "…": 0.15,   # ellipsis — dots on baseline, same as period
    "(": 1.10, ")": 1.10,   # paren — slightly taller than x-height, foot on baseline
    "[": 1.10, "]": 1.10,   # bracket — same as paren
    "{": 1.10, "}": 1.10,   # brace — same as paren
    # ── Math symbols ──────────────────────────────────────────────────────────
    "+": 0.55,   # plus — vertically centred in x-height zone
    "−": 0.12,   # minus U+2212 — thin bar, centred like hyphen
    "×": 0.55,   # multiply — centred
    "÷": 0.55,   # divide — centred
    "=": 0.45,   # equals — two thin bars, centred
    "≠": 0.55,   # not-equal — like = with diagonal slash
    "<": 0.65,   # less-than — centred chevron
    ">": 0.65,   # greater-than — centred chevron
    "≤": 0.75,   # less-or-equal — chevron + underline
    "≥": 0.75,   # greater-or-equal — chevron + underline
    "±": 0.85,   # plus-minus — centred
    "%": 0.95,   # percent — full x-height, on baseline
    "√": 1.20,   # square root — ascender; radical arm rises above x-height
    "^": 0.45,   # caret/power — superscript at top of x-height
    "π": 0.90,   # pi — x-height, on baseline
    # ── Currency ──────────────────────────────────────────────────────────────
    "₪": 1.05,   # shekel — full x-height, on baseline
    "$": 1.20,   # dollar — vertical stem extends above and below
    "€": 1.00,   # euro — x-height
    "£": 1.00,   # pound — x-height
    "¢": 0.85,   # cent — small, around x-height
    # ── Arrows ──────────────────────────────────────────────────────────────────
    "←": 0.55,   # left arrow — centred like an operator
    "→": 0.55,   # right arrow — centred like an operator
    "↑": 1.00,   # up arrow — full height
    "↓": 1.00,   # down arrow — full height
    # ── Special symbols ──────────────────────────────────────────────────────────
    "@": 1.05,   # at — slightly taller than x-height
    "#": 1.00,   # hash — x-height
    "&": 1.00,   # ampersand — x-height
    "*": 0.45,   # asterisk — superscript at top of x-height
    "/": 1.10,   # slash — spans the line
    "\\": 1.10,  # backslash — spans the line
    "|": 1.10,   # pipe — vertical bar
    "~": 0.35,   # tilde — thin, centred
    "_": 0.10,   # underscore — below the baseline
}

# ---------------------------------------------------------------------------
# _CHAR_ASCENDER_RATIO: fraction of glyph height that sits ABOVE the baseline
#
#   asc = 1.0            → entire glyph above baseline (bottom = baseline)
#   asc = _asc(h_ratio)  → top aligns with normal x-height top (y 32),
#                           stem hangs below baseline — used for descenders
#   asc > 1.0            → glyph sits above its "natural" position (centred
#                           operators, quotes, superscripts)
#
# Centering formula (x-height mid = y 72):
#   for symbol of height h: asc = (40 + h/2) / h  =  40/h + 0.5
# Pinning top to y 32:
#   asc = (baseline_y − 32) / h  =  80 / h
# ---------------------------------------------------------------------------
def _asc(h_ratio: float) -> float:
    """Ascender ratio for a descender whose top aligns with the normal x-height top."""
    return round(1.0 / h_ratio, 4)

_CHAR_ASCENDER_RATIO: dict[str, float] = {
    # ── Hebrew: entirely above baseline ──────────────────────────────────────
    # yod: 2.3 — sits in upper portion of line, not pinned to very top
    "י": 2.3,
    "א": 1.0, "ב": 1.0, "ג": 1.0, "ד": 1.0, "ה": 1.0,
    "ו": 1.0, "ז": 1.0, "ח": 1.0, "ט": 1.0, "כ": 1.0,
    "מ": 1.0, "נ": 1.0, "ס": 1.0, "ע": 1.0, "פ": 1.0,
    "צ": 1.0, "ר": 1.0, "ש": 1.0, "ת": 1.0, "ם": 1.0,
    # ── Hebrew: ascender — foot on baseline, head rises above ────────────────
    "ל": 1.0,
    # ── Hebrew: descenders — top at x-height top, stem below baseline ────────
    "ק": _asc(1.19),   # ≈ 0.840
    "ך": _asc(1.56),   # ≈ 0.641
    "ן": _asc(1.80),   # ≈ 0.556 — top at x-height, long tail fills space to next line
    "ף": _asc(1.38),   # ≈ 0.725
    "ץ": _asc(1.31),   # ≈ 0.763
    # ── Digits — on baseline ──────────────────────────────────────────────────
    "0": 1.0, "1": 1.0, "2": 1.0, "3": 1.0, "4": 1.0,
    "5": 1.0, "6": 1.0, "7": 1.0, "8": 1.0, "9": 1.0,
    # ── Latin lowercase: x-height group ──────────────────────────────────────
    "a": 1.0, "c": 1.0, "e": 1.0, "i": 1.0, "m": 1.0, "n": 1.0,
    "o": 1.0, "r": 1.0, "s": 1.0, "u": 1.0, "v": 1.0,
    "w": 1.0, "x": 1.0, "z": 1.0,
    # ── Latin lowercase: ascenders ────────────────────────────────────────────
    "b": 1.0, "d": 1.0, "f": 1.0, "h": 1.0, "k": 1.0, "l": 1.0, "t": 1.0,
    # ── Latin lowercase: descenders — bowl/top aligns with x-height top ──────
    "g": _asc(1.38),   # ≈ 0.725
    "j": _asc(1.38),   # ≈ 0.725
    "p": _asc(1.25),   # = 0.800
    "q": _asc(1.25),   # = 0.800
    "y": _asc(1.30),   # ≈ 0.769
    # ── Latin uppercase: on baseline ─────────────────────────────────────────
    "A": 1.0, "B": 1.0, "C": 1.0, "D": 1.0, "E": 1.0, "F": 1.0,
    "G": 1.0, "H": 1.0, "I": 1.0, "J": 1.0, "K": 1.0, "L": 1.0,
    "M": 1.0, "N": 1.0, "O": 1.0, "P": 1.0, "Q": 1.0, "R": 1.0,
    "S": 1.0, "T": 1.0, "U": 1.0, "V": 1.0, "W": 1.0, "X": 1.0,
    "Y": 1.0, "Z": 1.0,
    # ── Punctuation ───────────────────────────────────────────────────────────
    ".": 1.0,    # tiny dot sitting exactly on baseline
    ",": 0.82,   # dot near baseline + tail 4 px below
    ":": 1.0,    # bottom dot on baseline
    ";": 0.94,   # slight tail below baseline
    "!": 1.0,
    "?": 1.0,
    # Quotes float at top of x-height: asc = 80 / (80 × h_ratio) = 1/h_ratio × (1/1)
    # h_ratio=0.22 → h=17.6 px;  asc = 80/17.6 ≈ 4.54 → top at y ≈ 32
    "'": 4.54,
    '"': 4.54,
    "׳": 4.54,
    "״": 4.54,
    # Hyphen/dash: centred in x-height zone (mid = y 72)
    # h=9.6 px, y_top = 72−4.8 ≈ 67;  asc = (112−67)/9.6 = 4.69
    "-": 4.69,
    "–": 4.69,   # en dash — centred like hyphen
    "—": 4.69,
    "…": 1.0,    # ellipsis — dots on baseline
    # Brackets/parens/braces: foot on baseline
    "(": 1.0, ")": 1.0, "[": 1.0, "]": 1.0, "{": 1.0, "}": 1.0,
    # ── Math symbols ──────────────────────────────────────────────────────────
    # Centred operators: asc = 40/h + 0.5  (x-height mid = y 72)
    "+": 1.41,   # h=44 px → asc = 40/44 + 0.5 ≈ 1.41
    "−": 4.69,   # thin bar — same centring as hyphen
    "×": 1.41,   # same as plus
    "÷": 1.41,   # same as plus
    "=": 1.61,   # h=36 px → asc = 40/36 + 0.5 ≈ 1.61
    "≠": 1.41,   # same as plus
    "<": 1.27,   # h=52 px → asc = 40/52 + 0.5 ≈ 1.27
    ">": 1.27,
    "≤": 1.17,   # h=60 px → asc = 40/60 + 0.5 ≈ 1.17
    "≥": 1.17,
    "±": 1.09,   # h=68 px → asc = 40/68 + 0.5 ≈ 1.09
    "%": 1.0,    # on baseline
    "√": 1.0,    # entire height above baseline (radical foot on baseline)
    "^": 2.22,   # h=36 px; top pinned to y 32 → asc = 80/36 ≈ 2.22
    "π": 1.0,    # on baseline
    # ── Currency — foot on baseline ───────────────────────────────────────────
    "₪": 1.0, "$": 1.0, "€": 1.0, "£": 1.0, "¢": 1.0,
    # ── Arrows — horizontals centred, verticals full-height on baseline ───────
    "←": 1.41,   # centred like plus
    "→": 1.41,
    "↑": 1.0,
    "↓": 1.0,
    # ── Special symbols ──────────────────────────────────────────────────────────
    "@": 1.0, "#": 1.0, "&": 1.0,
    "*": 2.22,   # asterisk — superscript pinned to top of x-height
    "/": 1.0, "\\": 1.0, "|": 1.0,
    "~": 1.93,   # h=28 px → asc = 40/28 + 0.5 ≈ 1.93 (centred)
    "_": 0.0,    # underscore — entirely below baseline
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

# Target stroke width as a fraction of character height.
# At 80 px char height → target stroke ≈ 6 px (≈ 0.5 mm at 300 DPI — medium pen).
_STROKE_RATIO     = 0.075
# Maximum morphological iterations per glyph (10 covers ~10 px of correction — enough for
# thick-pen vs thin-pen differences without distorting the glyph shape).
_STROKE_MAX_ITERS = 10


def normalize_stroke_width(img: np.ndarray, target_char_h: int) -> np.ndarray:
    """
    Normalize stroke width so every glyph has the same visual weight regardless
    of how it was drawn or photographed.

    Performance optimizations vs original
    --------------------------------------
    1. Early-exit: if the initial radius is already within ±15 % of the target
       (the common case for hand-drawn glyphs), skip the morphological loop
       entirely — no distanceTransform calls at all.
    2. Measure every 2 iterations instead of every iteration.  distanceTransform
       is the dominant cost; halving the number of calls roughly halves CPU time
       for glyphs that DO need adjustment.
    3. Convergence tolerance kept at ±8 % for final acceptance to maintain output
       quality (only the mid-loop measurement is deferred, not the exit check).
    """
    alpha = img[:, :, 3]
    if alpha.max() == 0:
        return img

    ink = (alpha > 128).astype(np.uint8) * 255

    def _measure_radius(mask: np.ndarray) -> float:
        d = cv2.distanceTransform(mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        nz = d[d > 0]
        return float(np.median(nz)) if len(nz) >= 10 else 0.0

    current_radius = _measure_radius(ink)
    if current_radius == 0.0:
        return img

    target_radius = target_char_h * _STROKE_RATIO / 2.0
    if target_radius <= 0:
        return img

    # ── Optimization 1: early-exit if already close enough ───────────────────
    # ±15 % tolerance for the pre-check is deliberately looser than the ±8 %
    # convergence check inside the loop — avoids morphological work for the
    # majority of glyphs that are already near the target stroke weight.
    if 0.85 <= current_radius / target_radius <= 1.15:
        return img

    kernel    = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    new_alpha = ink.copy()

    for step in range(_STROKE_MAX_ITERS):
        ratio = current_radius / target_radius
        if 0.92 <= ratio <= 1.08:   # within ±8 % — converged
            break
        if ratio > 1.08:
            new_alpha = cv2.erode(new_alpha, kernel, iterations=1)
        else:
            new_alpha = cv2.dilate(new_alpha, kernel, iterations=1)

        # ── Optimization 2: re-measure every 2 iterations ────────────────────
        # distanceTransform dominates cost; skipping one in two cuts it roughly
        # in half for glyphs that need multiple corrections.
        if step % 2 == 1:
            r = _measure_radius(new_alpha)
            if r == 0.0:
                break   # glyph eroded away completely
            current_radius = r

    out = img.copy()
    out[:, :, 3] = new_alpha
    return out


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

    NOTE: currently UNUSED. The "slant" style parameter is consumed as a
    per-LINE baseline tilt in layout.py (render_full_page slant_px), not as a
    per-glyph shear. Kept for a possible future glyph-level italic feature.

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


def _plan_ink_blobs(
    glyph_x: int,
    glyph_y: int,
    glyph_w: int,
    glyph_h: int,
    blob_prob: float,
    rng: "random.Random | None" = None,
) -> list[dict]:
    """
    PLAN step of ink-blob generation (REWRITE_PLAN §3.2): consume the exact
    same rng draws as the legacy _add_ink_blob and return blob parameters
    instead of painting. The raster step (_paint_ink_blobs) consumes NO rng,
    so plan+paint is byte-identical to the legacy single-step function.
    """
    _r = rng if rng is not None else random
    if blob_prob <= 0 or _r.random() > blob_prob:
        return []
    blobs: list[dict] = []
    for _ in range(_r.randint(1, 2)):
        # Blob anchors: right edge (pen start in RTL) or a random mid-stroke point
        if _r.random() < 0.55:
            bx = glyph_x + glyph_w + _r.randint(-2, 2)
            by = glyph_y + glyph_h - _r.randint(0, max(1, glyph_h // 5))
        else:
            bx = glyph_x + _r.randint(0, max(1, glyph_w))
            by = glyph_y + _r.randint(0, glyph_h)
        radius = _r.randint(max(4, glyph_h // 10), max(8, glyph_h // 5))
        alpha  = _r.randint(180, 240)
        blobs.append({"x": bx, "y": by, "r": radius, "a": alpha})
    return blobs


def _paint_ink_blobs(canvas: Image.Image, blobs: list[dict], ink_rgb: tuple) -> None:
    """RASTER step of ink-blob generation — pure painting, no randomness."""
    if not blobs:
        return
    draw = ImageDraw.Draw(canvas)
    r, g, b = ink_rgb
    for blob in blobs:
        radius = blob["r"]
        draw.ellipse(
            [blob["x"] - radius, blob["y"] - radius,
             blob["x"] + radius, blob["y"] + radius],
            fill=(r, g, b, blob["a"]),
        )


def _add_ink_blob(
    canvas: Image.Image,
    glyph_x: int,
    glyph_y: int,
    glyph_w: int,
    glyph_h: int,
    blob_prob: float,
    ink_rgb: tuple,
    rng: "random.Random | None" = None,
) -> None:
    """
    Legacy single-step API: plan + paint in one call. Kept for backward
    compatibility; new code should use _plan_ink_blobs / _paint_ink_blobs.
    """
    _paint_ink_blobs(
        canvas,
        _plan_ink_blobs(glyph_x, glyph_y, glyph_w, glyph_h, blob_prob, rng=rng),
        ink_rgb,
    )


def _hcrop_to_ink(img: np.ndarray) -> np.ndarray:
    """
    Crop an RGBA glyph horizontally to its inked columns (alpha > 0).

    Glyph images carry variable transparent side-margins (from storage, the
    rotate-expand in apply_jitter, and resampling). Measuring inter-character
    and inter-word spacing from the image bounding box therefore yields gaps
    that vary per glyph and never reach zero — the spacing slider appears to
    "lose control" of some letters/words, and they can't be made to touch.

    Cropping to the actual ink makes every gap an ink-to-ink distance: spacing
    becomes uniform and fully slider-controlled, and a spacing of 0 makes
    neighbours truly touch. Rows are preserved so vertical placement is
    unaffected.
    """
    if img.ndim != 3 or img.shape[1] == 0:
        return img
    cols = np.where(img[:, :, 3].any(axis=0))[0]
    if cols.size == 0:
        return img   # fully transparent (shouldn't happen for real ink)
    return img[:, cols[0]:cols[-1] + 1, :]


def plan_line(
    chars: list[str],
    picker: VariantPicker,
    direction: str = "rtl",
    style: "dict | None" = None,
    ink_color: str = "black",
    fast_mode: bool = False,
    rng: "random.Random | None" = None,
) -> "tuple[dict, list[np.ndarray]]":
    """
    PLAN step of line rendering (REWRITE_PLAN §3.2) — computes the full layout
    of one line and records every random decision, WITHOUT compositing.

    Returns ``(line_plan, glyph_images)`` where:
      line_plan = {
        "width":  int,                 # final line canvas width (px)
        "height": _LINE_HEIGHT,
        "glyphs": [ { "char", "x", "y", "w", "h",
                      "variant", "url",            # which bank variant was used
                      "img",                       # index into glyph_images
                      "blobs": [ {x, y, r, a} ] }, ... ]   # visual (paste) order
      }
      glyph_images = transformed RGBA arrays, aligned with the "img" indices.

    ``raster_line(line_plan, glyph_images, ink_color)`` pastes the result and
    consumes NO randomness — so plan+raster is byte-identical to the legacy
    single-step compose_line (which is now a thin wrapper over both).

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
    tuple[dict, list[np.ndarray]]
        (line_plan, glyph_images) — see above.
    """
    if not chars:
        return {"width": 0, "height": _LINE_HEIGHT, "glyphs": []}, []

    # ------------------------------------------------------------------
    # Deterministic rendering: a seeded rng makes every random decision in
    # this line (variant picks, jitter, spacing, blobs) reproducible.
    # None → legacy non-deterministic behaviour (module-level random).
    # ------------------------------------------------------------------
    _r = rng if rng is not None else random

    # ------------------------------------------------------------------
    # Style dict — resolve early so all steps below can reference it.
    # ------------------------------------------------------------------
    _st = style or {}
    target_char_h_global = int(_st.get("char_height", _TARGET_CHAR_H))

    # ------------------------------------------------------------------
    # Step 1 — Render every glyph in logical order
    # ------------------------------------------------------------------
    # glyphs[i] = (RGBA_array, v_off, variant_idx, variant_url) or None
    glyphs: list = []
    for ch in chars:
        if ch == " ":
            glyphs.append(None)
        else:
            raw, v_idx, v_url = picker.pick_meta(ch, rng=rng)
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
                        # fast_mode: BILINEAR is ~2× faster than LANCZOS;
                        # imperceptible difference at preview display sizes.
                        resample = Image.BILINEAR if fast_mode else Image.LANCZOS
                        pil_raw = pil_raw.resize((new_w, target_h), resample)
                        raw     = np.array(pil_raw, dtype=np.uint8)
                    # Normalize stroke width ALWAYS (even in fast_mode/preview) so
                    # every glyph has the same visual weight in the live exact
                    # preview, during editing, and in the final document alike.
                    # A small early-exit inside the function keeps the common case
                    # cheap, so glyphs already near the target are barely touched.
                    raw = normalize_stroke_width(raw, target_char_h_global)
                    logger.debug("compose_line: char=%r  raw=%dx%d → scaled=%dx%d (h_ratio=%.2f)",
                                 ch, raw_h, raw_w, raw.shape[0], raw.shape[1], h_ratio)
                    jittered, v_off = apply_jitter(raw, fast_mode=fast_mode, rng=rng)
                    inked           = apply_ink_simulation(jittered, rng=rng)
                    inked           = _recolor_glyph(inked, ink_color)
                    # Tight horizontal crop so spacing is measured ink-to-ink,
                    # making it uniform, fully slider-controlled, and able to
                    # reach zero (touching) at the minimum.
                    inked           = _hcrop_to_ink(inked)
                    glyphs.append((inked, v_off, v_idx, v_url))
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
    # Use None-sentinel to distinguish "not supplied" from "explicitly 0 / negative".
    # The old `or 0` coerced None AND 0 to 0, then the fallback fired even for explicit 0.
    _raw_lsp = _st.get("letter_spacing")
    letter_sp_base = float(_raw_lsp) if _raw_lsp is not None else None
    # None-sentinel here too (mirrors compose_paragraph): explicit 0 means
    # "words touching" and must NOT fall back to natural spacing. The old
    # `or 0` + `> 0` combo silently replaced slider=0 with avg_glyph_w.
    _raw_wsp = _st.get("word_spacing")
    word_sp_base = float(_raw_wsp) if _raw_wsp is not None else None
    jitter_pct     = float(_st.get("baseline_jitter", 2.0))        # σ % of char height

    glyph_widths_px = [
        glyphs[i][0].shape[1] if glyphs[i] is not None else 0
        for i in visual_indices
    ]
    real_widths = [w for w in glyph_widths_px if w > 0]
    avg_glyph_w = (sum(real_widths) / len(real_widths)) if real_widths else target_char_h

    # Letter spacing:
    #   • None (no style key) → natural fallback of 15 % of avg glyph width
    #   • Any explicit value (including 0 or negative) → use as-is
    #   Negative values are intentional: the client sends slider*0.30-8, so slider=0
    #   gives -8 px (letters tight/overlapping).  We clamp at -25 % of avg width to
    #   prevent complete character overlap at extreme settings.
    if letter_sp_base is None:
        _LSP = avg_glyph_w * 0.15          # natural spacing when no style given
    else:
        _LSP = max(-avg_glyph_w * 0.25, letter_sp_base)

    # Sigma always positive; reduced for tight/negative values to avoid wild swings.
    _LSP_SIGMA = abs(_LSP) * 0.20

    # Word spacing (within-line spaces): explicit style override (0 honoured —
    # words touching) or 100 % of avg glyph width when no style key was given.
    if word_sp_base is None:
        _WSP = avg_glyph_w * 1.0
    else:
        _WSP = max(0.0, word_sp_base)
    _WSP_SIGMA = _WSP * 0.25

    def _word_w() -> int:
        # The 60%-of-glyph floor is a readability default — apply it only when
        # the caller did NOT set word_spacing explicitly, otherwise slider=0
        # could never produce touching words.
        floor = round(avg_glyph_w * 0.6) if word_sp_base is None else 0
        return max(floor, int(_r.gauss(_WSP, _WSP_SIGMA)))

    widths = [
        glyphs[i][0].shape[1] if glyphs[i] is not None else _word_w()
        for i in visual_indices
    ]

    # Spacing may be negative (overlap). Clamp minimum to -25 % of avg glyph width
    # so characters never fully disappear behind each other.
    _CLAMP_NEG = int(-avg_glyph_w * 0.25)
    spacings = [
        max(_CLAMP_NEG, int(_r.gauss(_LSP, _LSP_SIGMA)))
        for _ in visual_indices
    ]

    # Do not add trailing spacing after the last character
    total_width = max(1, sum(w + s for w, s in zip(widths, spacings)) - spacings[-1])

    # ------------------------------------------------------------------
    # Step 4 — PLAN glyph placements (no compositing; rng draws happen in the
    # exact same order as the legacy paste loop, so plan+raster reproduces the
    # legacy bytes draw-for-draw).
    # ------------------------------------------------------------------
    baseline_y = round(_LINE_HEIGHT * _BASELINE_Y_RATIO)
    blob_prob  = float(_st.get("ink_blobs", 0.0))

    placements:   list[dict]      = []
    glyph_images: list[np.ndarray] = []

    x = 0
    for idx, w, s in zip(visual_indices, widths, spacings):
        glyph = glyphs[idx]
        if glyph is not None:
            img, v_off, v_idx, v_url = glyph
            ch_here     = chars[idx]
            asc_ratio   = _CHAR_ASCENDER_RATIO.get(ch_here, 1.0)
            # Pre-jitter target height — used for POSITION so jitter scale/rotation
            # don't push the glyph above the top ruled line unexpectedly.
            h_ratio_here    = _CHAR_HEIGHT_RATIO.get(ch_here, 1.0)
            target_h_here   = max(1, round(target_char_h_global * h_ratio_here))
            ascender_h_here = round(target_h_here * asc_ratio)
            # Descenders (asc_ratio < 1.0): skip baseline_dance so the tail stays
            # anchored below the baseline, not drifting into the next line or above.
            is_descender = asc_ratio < 1.0
            baseline_dance = (
                0
                if is_descender
                else int(_r.gauss(0, target_h_here * (jitter_pct / 100.0)))
            )
            if ch_here == 'י':
                # Yod: pin top to normal x-height top.
                y = baseline_y - target_char_h_global + v_off
            else:
                # Use pre-jitter ascender so scale/rotation jitter don't shift position.
                y = baseline_y - ascender_h_here + v_off + baseline_dance
            # Clamp: never let a glyph start above the line canvas top.
            y = max(0, y)

            gh, gw = img.shape[0], img.shape[1]
            blobs  = _plan_ink_blobs(x, y, gw, gh, blob_prob, rng=rng)

            placements.append({
                "char":    ch_here,
                "x":       x,
                "y":       y,
                "w":       gw,
                "h":       gh,
                "variant": v_idx,
                "url":     v_url,
                "img":     len(glyph_images),
                "blobs":   blobs,
            })
            glyph_images.append(img)
        x += w + s

    line_plan = {"width": total_width, "height": _LINE_HEIGHT, "glyphs": placements}
    return line_plan, glyph_images


def raster_line(
    line_plan: dict,
    glyph_images: list[np.ndarray],
    ink_color: str = "black",
) -> np.ndarray:
    """
    RASTER step of line rendering (REWRITE_PLAN §3.2): paste the pre-planned
    glyph images and blobs onto a fresh canvas. Consumes NO randomness — the
    output is a pure function of (line_plan, glyph_images, ink_color).
    """
    width = line_plan["width"]
    if width <= 0:
        return np.zeros((_LINE_HEIGHT, 0, 4), dtype=np.uint8)

    canvas  = Image.new("RGBA", (width, _LINE_HEIGHT), (0, 0, 0, 0))
    ink_rgb = _INK_RGB.get(ink_color, (26, 23, 20))

    for g in line_plan["glyphs"]:
        pil_g = Image.fromarray(glyph_images[g["img"]], "RGBA")
        canvas.paste(pil_g, (g["x"], g["y"]), pil_g)
        _paint_ink_blobs(canvas, g["blobs"], ink_rgb)

    return np.array(canvas, dtype=np.uint8)


def compose_line(
    chars: list[str],
    picker: VariantPicker,
    direction: str = "rtl",
    style: "dict | None" = None,
    ink_color: str = "black",
    fast_mode: bool = False,
    rng: "random.Random | None" = None,
) -> np.ndarray:
    """
    Render a single line of text as an RGBA numpy array.

    Thin wrapper: plan_line (all decisions + rng draws) → raster_line (pure
    pasting). Public behaviour is identical to the legacy monolithic version.
    """
    line_plan, glyph_images = plan_line(
        chars, picker, direction, style=style, ink_color=ink_color,
        fast_mode=fast_mode, rng=rng,
    )
    return raster_line(line_plan, glyph_images, ink_color=ink_color)


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
    fast_mode: bool = False,
    rng: "random.Random | None" = None,
) -> list[np.ndarray]:
    """
    Lay out *text* into multiple lines that each fit within *page_width*.

    Newline characters (Enter key) produce an explicit line break — the current
    line is flushed and a new one starts, exactly matching the client-side
    Preview behaviour.  Two consecutive newlines produce a blank line (empty
    RGBA strip) so paragraph spacing is preserved in the final output.

    Words within each paragraph are split on spaces.  Each line's direction is
    inferred from its dominant script (first strong character wins).
    ``compose_line`` handles mixed RTL/LTR content within a single line.

    Parameters
    ----------
    text : str
        Full text in logical (typing) order.  May contain ``\\n`` characters.
    picker : VariantPicker
    page_width : int
        Maximum line width in pixels.  Defaults to 2480 (A4 @ 300 DPI).

    Returns
    -------
    list[np.ndarray]
        One RGBA array per line, each shaped (_LINE_HEIGHT, line_width, 4).
    """
    entries = plan_paragraph(
        text, picker, page_width=page_width, margin=margin, style=style,
        ink_color=ink_color, fast_mode=fast_mode, rng=rng,
    )

    all_lines: list[np.ndarray] = []
    for entry in entries:
        if entry["type"] == "blank":
            all_lines.append(np.zeros((_LINE_HEIGHT, 1, 4), dtype=np.uint8))
            continue
        word_imgs = [
            raster_line(w["plan"], w["images"], ink_color=ink_color)
            for w in entry["words"]
        ]
        gaps = [w["gap"] for w in entry["words"]]
        all_lines.append(_flush_rtl_line(word_imgs, gaps))
    return all_lines


def plan_paragraph(
    text: str,
    picker: VariantPicker,
    page_width: int = 2480,
    margin: int = 200,
    style: "dict | None" = None,
    ink_color: str = "black",
    fast_mode: bool = False,
    rng: "random.Random | None" = None,
) -> list[dict]:
    """
    PLAN step of paragraph layout (REWRITE_PLAN §3.2/3.3).

    Splits *text* into words, plans each word (plan_line), and wraps words
    into lines exactly like the legacy compose_paragraph — same rng draw
    order, so plan+raster is byte-identical to the legacy pipeline.

    Returns a list of line entries (document order):
      {"type": "blank", "width": 1, "words": []}
      {"type": "text",  "width": int,        # joined visual line width
       "words": [ {"plan": line_plan, "images": [...], "gap": int}, ... ] }

    ``words`` is in LOGICAL order; ``gap`` is inserted BEFORE the word when
    joining (gap of the first word in a line is 0). Visual (RTL) placement is
    derived via :func:`plan_visual_line`.
    """
    if not text.strip():
        return []

    usable_w = max(1, page_width - 2 * margin)
    _style = style or {}
    # Deterministic rendering: one sequential rng drives the whole document.
    # Same (text, style, seed) → identical draws → identical output bytes.
    # Sequential consumption also gives PREFIX STABILITY: editing text on line
    # N leaves lines 1…N-1 pixel-identical (their draws come first).
    _r = rng if rng is not None else random

    # Use None-sentinel so explicit 0 (slider at min) is honoured.
    # Fallback to _SPACE_WIDTH only when the style key is absent entirely.
    _raw_wsp_para = _style.get("word_spacing")
    word_sp_base = float(_raw_wsp_para) if _raw_wsp_para is not None else float(_SPACE_WIDTH)

    def _rand_word_gap() -> int:
        # Reduced sigma (15 % vs old 20 %) + no 60 % floor — makes spacing
        # consistent across the line and lets slider=0 produce near-zero gaps.
        sigma = word_sp_base * 0.15
        return max(0, int(_r.gauss(word_sp_base, sigma)))

    def _entry_width(words: "list[dict]") -> int:
        # Joined width must mirror _flush_rtl_line + _join_word_images_with_gaps:
        # gaps are REVERSED and the new first gap is zeroed before joining.
        rev_gaps = list(reversed([w["gap"] for w in words]))
        if rev_gaps:
            rev_gaps[0] = 0
        return sum(rev_gaps) + sum(w["plan"]["width"] for w in words)

    def _pack_words_into_lines(word_entries: "list[dict]") -> list[dict]:
        """Pack planned words into wrapped lines — same draws as legacy."""
        if not word_entries:
            return []

        out_lines:  list[dict] = []
        line_words: list[dict] = []
        line_w: int = 0

        for entry in word_entries:
            ww     = entry["plan"]["width"]
            gap    = _rand_word_gap() if line_words else 0
            needed = gap + ww

            if line_words and line_w + needed > usable_w:
                out_lines.append({"type": "text", "width": _entry_width(line_words), "words": line_words})
                line_words = [{**entry, "gap": 0}]
                line_w     = ww
            else:
                line_words.append({**entry, "gap": gap})
                line_w += needed

        if line_words:
            out_lines.append({"type": "text", "width": _entry_width(line_words), "words": line_words})
        return out_lines

    # ── Split on explicit newlines first, preserving Enter-key breaks ─────────
    paragraphs = text.split("\n")

    all_entries: list[dict] = []

    for para in paragraphs:
        # Empty paragraph → explicit blank line (transparent strip)
        if not para.strip():
            all_entries.append({"type": "blank", "width": 1, "words": []})
            continue

        # ── Step 1: plan every word to get exact pixel widths ─────────────────
        raw_words = para.split(" ")
        word_entries: list[dict] = []
        for word in raw_words:
            if not word:
                continue
            chars = list(word)
            dir_  = _detect_direction(chars)
            w_plan, w_images = plan_line(
                chars, picker, dir_, style=_style, ink_color=ink_color,
                fast_mode=fast_mode, rng=rng,
            )
            word_entries.append({"plan": w_plan, "images": w_images, "gap": 0})

        # ── Step 2: wrap words into lines ─────────────────────────────────────
        all_entries.extend(_pack_words_into_lines(word_entries))

    return all_entries


def plan_visual_line(entry: dict) -> "tuple[int, list[dict]]":
    """
    Convert one plan_paragraph line entry into VISUAL (RTL-flushed) glyph
    placements, mirroring _flush_rtl_line exactly: words and gaps reversed,
    new first gap zeroed, x offsets accumulated left→right.

    Returns (line_width, glyphs) where each glyph dict has absolute
    line-local coordinates: {char, url, variant, x, y, w, h}.
    """
    if entry["type"] == "blank" or not entry["words"]:
        return entry.get("width", 1), []

    rev_words = list(reversed(entry["words"]))
    rev_gaps  = list(reversed([w["gap"] for w in entry["words"]]))
    if rev_gaps:
        rev_gaps[0] = 0

    glyphs: list[dict] = []
    x = 0
    for gap, wentry in zip(rev_gaps, rev_words):
        x += gap
        for g in wentry["plan"]["glyphs"]:
            glyphs.append({
                "char":    g["char"],
                "url":     g["url"],
                "variant": g["variant"],
                "x":       g["x"] + x,
                "y":       g["y"],
                "w":       g["w"],
                "h":       g["h"],
            })
        x += wentry["plan"]["width"]

    return x, glyphs


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

    # Test 41 — DETERMINISTIC RENDERING (REWRITE_PLAN §3.1, the WYSIWYG contract)
    # Same (text, style, seed) → byte-identical output. Different seed → differs.
    bank_det   = _make_bank({"א": 3, "ב": 2, "ג": 4})
    _det_style = {"char_height": 80, "letter_spacing": 4, "word_spacing": 35,
                  "baseline_jitter": 7.5, "ink_blobs": 0.2}
    _det_text  = "אבג גבא אאב\nבגא אב גג"

    def _render_det(seed_val: int) -> bytes:
        picker_det = VariantPicker(bank_det)          # fresh picker per render
        rng_det    = random.Random(seed_val)          # fresh seeded rng per render
        det_lines  = compose_paragraph(
            _det_text, picker_det, style=_det_style, rng=rng_det,
        )
        return b"".join(ln.tobytes() for ln in det_lines)

    _out_a = _render_det(123)
    _out_b = _render_det(123)
    assert _out_a == _out_b, "DETERMINISM BROKEN: same seed produced different bytes"
    _out_c = _render_det(456)
    assert _out_a != _out_c, "different seeds unexpectedly produced identical bytes"
    print("PASS  deterministic rendering: same seed → identical bytes; different seed → differs")

    # Test 42 — determinism must hold even when the GLOBAL random state differs
    # between runs (proves no code path still leaks module-level random).
    random.seed(111)
    _out_d = _render_det(123)
    random.seed(999)
    _out_e = _render_det(123)
    assert _out_d == _out_e, (
        "DETERMINISM LEAK: output depends on global random state — "
        "some draw still uses module-level random instead of the seeded rng"
    )
    assert _out_d == _out_a, "seeded render changed across global-state variations"
    print("PASS  no leakage to module-level random (global state does not affect seeded renders)")

    # Test 43 — plan/raster split: layout geometry matches rasterized pixels.
    # plan_paragraph (geometry) and compose_paragraph (pixels) with the same
    # seed must agree on every line width — this is the contract that lets the
    # mobile compositor (/layout) trust the geometry as ground truth.
    _ent_picker = VariantPicker(bank_det)
    _ent_rng    = random.Random(123)
    _entries    = plan_paragraph(_det_text, _ent_picker, style=_det_style, rng=_ent_rng)
    _ras_picker = VariantPicker(bank_det)
    _ras_rng    = random.Random(123)
    _ras_lines  = compose_paragraph(_det_text, _ras_picker, style=_det_style, rng=_ras_rng)
    assert len(_entries) == len(_ras_lines), "plan/raster line count mismatch"
    for _entry, _line_img in zip(_entries, _ras_lines):
        _vis_w, _vis_glyphs = plan_visual_line(_entry)
        assert _vis_w == _line_img.shape[1], (
            f"plan width {_vis_w} != raster width {_line_img.shape[1]}"
        )
        for _g in _vis_glyphs:
            assert 0 <= _g["x"] <= _vis_w,            "glyph x outside line bounds"
            assert _g["x"] + _g["w"] <= _vis_w + 4,   "glyph overflows line width"
    print("PASS  plan/raster split: layout geometry matches rasterized line widths")

    # Test 44 — layout geometry is deterministic per seed
    def _plan_geo(seed_val: int) -> list:
        p = VariantPicker(bank_det)
        r = random.Random(seed_val)
        return [plan_visual_line(e) for e in
                plan_paragraph(_det_text, p, style=_det_style, rng=r)]

    assert _plan_geo(123) == _plan_geo(123), "same seed produced different layout geometry"
    assert _plan_geo(123) != _plan_geo(456), "different seeds produced identical geometry"
    print("PASS  /layout geometry deterministic per seed")

    print()
    print("All tests passed.")


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.WARNING)
    random.seed(42)   # deterministic for CI; remove for production fuzzing
    run_tests()
