import json
import logging
import os
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("modules.synthesizer").setLevel(logging.DEBUG)

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware

from modules.auth import require_auth, assert_same_user

from modules.validator import validate_text, generate_sample_page
from modules import firebase_storage as firebase_client

logger = logging.getLogger(__name__)

app = FastAPI(title="Handscript API")

app.add_middleware(GZipMiddleware, minimum_size=1000)

# Restrict CORS to known origins.  Add your production domain here when you
# deploy.  The wildcard is intentionally removed to block CSRF from arbitrary
# web origins.
_ALLOWED_ORIGINS = [
    # local development (Expo Go / Metro bundler)
    "http://localhost:8081",
    "http://localhost:19006",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:19006",
    # add your production domain, e.g. "https://app.handscript.co.il"
]
_ALLOWED_ORIGINS_EXTRA = os.getenv("ALLOWED_ORIGINS", "").split(",")
_ALLOWED_ORIGINS += [o.strip() for o in _ALLOWED_ORIGINS_EXTRA if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Dev-User-Id"],
)


class _TimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        response.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
        if elapsed_ms > 2000:
            logger.warning("Slow request: %s %s took %.0f ms", request.method, request.url.path, elapsed_ms)
        return response


app.add_middleware(_TimingMiddleware)

# ---------------------------------------------------------------------------
# Static files — generated sample pages are served from /static/
# ---------------------------------------------------------------------------

_STATIC_DIR = Path(__file__).parent / "static"
_STATIC_DIR.mkdir(exist_ok=True)
(_STATIC_DIR / "sample_pages").mkdir(exist_ok=True)

_DATA_BANKS = Path(__file__).parent / "data" / "banks"
_DATA_BANKS.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

# Configure local storage with the server's own host (read from env or default)
def _detect_server_host() -> str:
    """Return the machine's LAN IP so mobile clients can reach the server."""
    import socket as _socket
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:8000"
    except Exception:
        return "http://172.20.10.2:8000"

_SERVER_HOST = os.getenv("SERVER_HOST") or _detect_server_host()
if not _SERVER_HOST.startswith(("http://", "https://")):
    raise RuntimeError(f"Invalid SERVER_HOST: {_SERVER_HOST!r}. Must start with http:// or https://")
logger.info("Server host: %s", _SERVER_HOST)
firebase_client.configure(_SERVER_HOST)

# ---------------------------------------------------------------------------
# Local bank storage (placeholder until Firebase is wired)
#
# Each user's glyph bank is a JSON file at:
#   backend/data/banks/{user_id}.json
#
# Format: { "<character>": { ...glyph metadata... }, ... }
# The validation logic only reads the dict keys, so the values don't matter yet.
# ---------------------------------------------------------------------------

_BANKS_DIR = Path(__file__).parent / "data" / "banks"
_BANKS_DIR.mkdir(parents=True, exist_ok=True)


def _load_bank(user_id: str) -> dict:
    """Return the user's character bank, or an empty dict if not found."""
    path = _BANKS_DIR / f"{user_id}.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_bank(user_id: str, bank: dict) -> None:
    path = _BANKS_DIR / f"{user_id}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Simple in-memory rate limiter (per user_id, resets every minute)
# ---------------------------------------------------------------------------
import collections, threading

_rate_lock    = threading.Lock()
_rate_buckets: dict[str, list[float]] = collections.defaultdict(list)
_RATE_WINDOW  = 60.0   # seconds
_RATE_LIMIT   = 20     # max requests per window per user

def _check_rate_limit(user_id: str) -> None:
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets[user_id]
        _rate_buckets[user_id] = [t for t in bucket if now - t < _RATE_WINDOW]
        if len(_rate_buckets[user_id]) >= _RATE_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי בקשות. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        _rate_buckets[user_id].append(now)

_CONVERT_RATE_LIMIT = 6   # /convert is heavy — tighter limit

def _check_convert_rate_limit(user_id: str) -> None:
    now = time.time()
    key = f"__convert_{user_id}"
    with _rate_lock:
        bucket = _rate_buckets[key]
        _rate_buckets[key] = [t for t in bucket if now - t < _RATE_WINDOW]
        if len(_rate_buckets[key]) >= _CONVERT_RATE_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי בקשות המרה. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        _rate_buckets[key].append(now)


# ---------------------------------------------------------------------------
# Request models — all fields include length/range limits
# ---------------------------------------------------------------------------

_MAX_TEXT = 5_000   # characters

class ValidateRequest(BaseModel):
    text:    str = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id: str = Field(..., min_length=1, max_length=128)


class StyleParams(BaseModel):
    char_height:      int   = Field(85,   ge=40,  le=130)
    letter_spacing:   float = Field(4.0,  ge=0.0, le=30.0)
    word_spacing:     int   = Field(35,   ge=15,  le=100)
    baseline_jitter:  float = Field(7.5,  ge=0.0, le=25.0)
    slant:            float = Field(2.25, ge=0.0, le=40.0)
    ink_blobs:        float = Field(0.03, ge=0.0, le=0.30)


class ConvertRequest(BaseModel):
    text:       str        = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id:    str        = Field(..., min_length=1, max_length=128)
    background: str        = Field("lines", pattern=r"^(blank|lines|grid)$")
    ink_color:  str        = Field("black", pattern=r"^(black|blue|red)$")
    style:      StyleParams = StyleParams()
    preview:    bool        = False
    scan_mode:  str        = Field("clean", pattern=r"^(clean|photo)$")


class SaveCharacterSamplesRequest(BaseModel):
    user_id:   str | None = Field(None, min_length=1, max_length=128)
    character: str        = Field(..., min_length=1, max_length=4)
    samples:   list[str]  = Field(..., min_length=1, max_length=10)  # base64 images

    @field_validator("samples")
    @classmethod
    def limit_sample_size(cls, v: list[str]) -> list[str]:
        max_b64_len = 10 * 1024 * 1024  # ~7.5 MB per sample
        for s in v:
            if len(s) > max_b64_len:
                raise ValueError("sample image too large")
        return v


class GlyphsRequest(BaseModel):
    text:    str = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id: str = Field(..., min_length=1, max_length=128)


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Vectorisation helpers
# ---------------------------------------------------------------------------

def _potrace_available() -> bool:
    """Return True if potrace binary is on PATH."""
    import shutil
    return shutil.which("potrace") is not None


def _bitmap_to_svg(binary_mask: np.ndarray, temp_id: str) -> "str | None":
    """
    Run potrace on *binary_mask* (uint8, ink=255 background=0).
    Returns the raw SVG text, or None if potrace is unavailable or fails.
    """
    import subprocess, tempfile as _tf
    if not _potrace_available():
        return None
    try:
        tmp_dir  = Path(tempfile.gettempdir()) / "potrace_tmp"
        tmp_dir.mkdir(exist_ok=True)
        pbm_path = tmp_dir / f"{temp_id}.pbm"
        svg_path = tmp_dir / f"{temp_id}.svg"

        # potrace reads PBM: black pixel = foreground (ink).
        # Our mask has ink=255 (white) so we invert before saving.
        inverted = cv2.bitwise_not(binary_mask)
        # Write raw PBM (P4 binary format) via PIL
        from PIL import Image as _PIL
        _PIL.fromarray(inverted).save(str(pbm_path))

        subprocess.run(
            ["potrace", str(pbm_path), "-s", "-o", str(svg_path),
             "--turdsize", "2",       # ignore tiny noise blobs
             "--alphamax",  "1.0",    # smooth corners
             "--opttolerance", "0.2"],
            check=True, capture_output=True, timeout=3,
        )
        svg_text = svg_path.read_text(encoding="utf-8")
        pbm_path.unlink(missing_ok=True)
        svg_path.unlink(missing_ok=True)
        return svg_text
    except Exception as exc:
        logger.warning("potrace failed: %s — falling back to raster", exc)
        return None


def _svg_to_rgba(svg_text: str, target_h: int, ink_rgb: tuple[int,int,int]) -> "np.ndarray | None":
    """
    Render *svg_text* to an RGBA array at *target_h* pixels tall.
    Ink is recoloured to *ink_rgb*; background is transparent.
    Returns None if cairosvg is unavailable.
    """
    try:
        import cairosvg, re
        from PIL import Image as _PIL
        import io as _io

        # Replace potrace's black fill with our ink colour and make background transparent
        r, g, b = ink_rgb
        hex_ink = f"#{r:02x}{g:02x}{b:02x}"
        svg_coloured = re.sub(r'fill:[^;"]+', f"fill:{hex_ink}", svg_text)
        # Remove any white/light background rect potrace may have added
        svg_coloured = re.sub(r'<rect[^/]*/>', '', svg_coloured)

        png_bytes = cairosvg.svg2png(
            bytestring=svg_coloured.encode(),
            output_height=target_h,
        )
        img   = _PIL.open(_io.BytesIO(png_bytes)).convert("RGBA")
        arr   = np.array(img, dtype=np.uint8)

        # Collect the alpha channel and binarize it.
        # cairosvg anti-aliases edges → many fringe pixels sit between 32–180.
        # We lower the acceptance threshold to 64 (from 128) so that anti-aliased
        # ink edges are kept rather than discarded, then dilate 1 px to restore
        # the stroke weight that would otherwise be lost at the perimeter.
        alpha_ch = arr[:, :, 3]
        ink_mask = alpha_ch >= 64

        # Morphological dilation on the ink mask to recover thinned strokes.
        ink_mask_u8 = ink_mask.astype(np.uint8) * 255
        dk = np.ones((3, 3), dtype=np.uint8)
        ink_mask_u8 = cv2.dilate(ink_mask_u8, dk, iterations=1)
        ink_mask = ink_mask_u8 > 0

        arr[ink_mask,  0] = r
        arr[ink_mask,  1] = g
        arr[ink_mask,  2] = b
        arr[ink_mask,  3] = 255          # full opacity — no semi-transparent pixels
        arr[~ink_mask, :] = 0            # fully transparent background
        return arr
    except Exception as exc:
        logger.warning("cairosvg render failed: %s — falling back to raster", exc)
        return None


# ---------------------------------------------------------------------------
# Stroke-width normalisation
# ---------------------------------------------------------------------------

def _normalize_stroke_width(
    rgba: np.ndarray,
    target_frac: float = 0.07,
) -> np.ndarray:
    """
    Normalise stroke width so every stored glyph has a consistent thickness
    relative to its bounding-box height.

    Algorithm
    ---------
    1. Extract the alpha channel (ink mask).
    2. Run cv2.distanceTransform – each ink pixel gets its distance to the
       nearest background pixel, which equals the local stroke *radius*.
    3. Take the median of all nonzero distances → current_radius.
    4. Compare to target_radius = target_frac * h / 2.
    5. Erode or dilate by round(|delta|) iterations of a 3×3 elliptic kernel
       to match the target.

    target_frac=0.07 means the target stroke width is 7 % of the glyph
    bounding-box height.  At the stored resolution (_TARGET_CHAR_H × 2 ≈
    160 px) that is about 11 px per stroke, which maps to ~5 px after the
    0.5× scale applied during synthesis – visually consistent and natural.
    """
    alpha = rgba[:, :, 3].copy()
    h = alpha.shape[0]

    dist = cv2.distanceTransform(alpha, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    nonzero_dists = dist[dist > 0]
    if len(nonzero_dists) < 20:
        return rgba  # too sparse to measure reliably

    current_radius = float(np.median(nonzero_dists))
    target_radius  = target_frac * h / 2.0
    delta          = target_radius - current_radius

    logger.info(
        "stroke_norm: h=%dpx  current_r=%.2f  target_r=%.2f  delta=%.2f",
        h, current_radius, target_radius, delta,
    )

    if abs(delta) < 0.75:
        logger.info("stroke_norm: within tolerance — no adjustment")
        return rgba

    iters  = max(1, round(abs(delta)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    if delta > 0:
        new_alpha = cv2.dilate(alpha, kernel, iterations=iters)
        logger.info("stroke_norm: DILATE %d iters (thicken)", iters)
    else:
        new_alpha = cv2.erode(alpha, kernel, iterations=iters)
        logger.info("stroke_norm: ERODE  %d iters (thin)", iters)

    result = rgba.copy()
    result[:, :, 3] = new_alpha
    # Paint newly added pixels with the same ink colour as existing ones
    existing_ink = rgba[:, :, 3] > 0
    if existing_ink.any():
        ink_r = int(np.mean(rgba[existing_ink, 0]))
        ink_g = int(np.mean(rgba[existing_ink, 1]))
        ink_b = int(np.mean(rgba[existing_ink, 2]))
    else:
        ink_r, ink_g, ink_b = 25, 25, 45
    new_pixels = (new_alpha > 0) & ~existing_ink
    result[new_pixels, 0] = ink_r
    result[new_pixels, 1] = ink_g
    result[new_pixels, 2] = ink_b

    return result


# ---------------------------------------------------------------------------
# Character extraction helper
# ---------------------------------------------------------------------------

def _extract_character(bgr: np.ndarray, sample_idx: int) -> "tuple[np.ndarray, str | None] | None":
    """
    Professional character extraction pipeline.

    Steps
    -----
    1. Resize to a consistent working size
    2. Shadow / illumination normalisation (divide-by-blur)
    3. Adaptive threshold → binary ink mask
    4. Horizontal / vertical line removal (notebook ruling)
    5. Morphological cleanup (noise removal + stroke solidification)
    6. Tight bounding-box crop with small padding
    7. Edge-smoothed alpha channel on a fixed dark-ink RGBA image

    Returns RGBA numpy array (H×W×4, uint8) or None if no ink found.
    """
    from PIL import Image as _PilImg, ImageFilter as _ImgFilter

    # ── 1. Resize: cap longest side at 1000 px (smaller = faster, still enough detail)
    h0, w0 = bgr.shape[:2]
    target_side = 1000
    if max(h0, w0) > target_side:
        sc  = target_side / max(h0, w0)
        bgr = cv2.resize(bgr, (int(w0 * sc), int(h0 * sc)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    # ── 2. Illumination normalisation ────────────────────────────────────────
    # Divide by a heavily blurred copy to cancel shadows and uneven lighting.
    bg_blur    = cv2.GaussianBlur(gray, (61, 61), 0).astype(np.float32)
    bg_blur    = np.maximum(bg_blur, 1.0)
    normalised = np.clip(gray.astype(np.float32) / bg_blur * 255, 0, 255).astype(np.uint8)

    # ── 2b. CLAHE contrast enhancement ───────────────────────────────────────
    # After illumination normalisation the ink and paper may still sit close
    # together in intensity (e.g. light-pressure pen on pale paper).
    # CLAHE (Contrast Limited Adaptive Histogram Equalisation) redistributes
    # the local histogram to maximise contrast inside each 8×8 tile while
    # preventing over-amplification of noise (clipLimit=2.0).
    clahe      = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    normalised = clahe.apply(normalised)

    # ── 3. Threshold ─────────────────────────────────────────────────────────
    # Primary: adaptive (Gaussian) threshold — handles any residual local
    # brightness gradient across the crop.
    binary_adaptive = cv2.adaptiveThreshold(
        normalised, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        blockSize=21, C=10,
    )

    # Secondary: global Otsu — reliable when the crop histogram is bimodal
    # (ink vs. background), which is the common case after CLAHE.
    _, binary_otsu = cv2.threshold(
        normalised, 0, 255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )

    # Union of both masks: keeps every pixel that either method calls ink.
    # This recovers strokes that are faint enough for one method to miss.
    binary = cv2.bitwise_or(binary_adaptive, binary_otsu)

    # ── 4. Notebook line removal ─────────────────────────────────────────────
    # Multi-pass horizontal line removal with dilation so partial lines are
    # caught.  We use two kernel widths: aggressive (100 px) then moderate
    # (50 px) to catch lines that were interrupted by an ink stroke.
    def _remove_lines(src: np.ndarray, kw: int, kh: int, dilate_px: int = 2) -> np.ndarray:
        kern   = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh))
        lines  = cv2.morphologyEx(src, cv2.MORPH_OPEN, kern, iterations=1)
        if dilate_px > 0:
            dk    = cv2.getStructuringElement(cv2.MORPH_RECT, (1, dilate_px * 2 + 1))
            lines = cv2.dilate(lines, dk, iterations=1)
        return cv2.subtract(src, lines)

    img_w, img_h = binary.shape[1], binary.shape[0]

    # Horizontal ruling lines — two passes
    binary = _remove_lines(binary, kw=max(100, img_w // 4), kh=1, dilate_px=2)
    binary = _remove_lines(binary, kw=max(50,  img_w // 8), kh=1, dilate_px=1)

    # Vertical margin lines — single pass
    binary = _remove_lines(binary, kw=1, kh=max(100, img_h // 4), dilate_px=2)

    # ── 5. Noise removal ─────────────────────────────────────────────────────
    open_k = np.ones((2, 2), dtype=np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, open_k, iterations=1)

    # ── 5b. Smart interior hole-filling ──────────────────────────────────────
    # Hebrew letters like ב, ד, פ have *accidental* gaps (faded ink) that should
    # be filled.  But ס, ם and digits like 0, 8, 6, 9 have *intentional* holes
    # that must be preserved — filling them would destroy the character shape.
    #
    # Decision rules (applied to each internal contour / "hole"):
    #   PRESERVE if any of:
    #     • hole area  > LARGE_RATIO   of char bounding-box area  (big = intentional)
    #     • circularity > CIRC_HIGH    AND centre_distance < CENTRE_CLOSE
    #     • circularity > CIRC_MED     AND hole area > MED_RATIO
    #     • hole width  > DIM_RATIO    of char width  (wide hole = intentional)
    #     • hole height > DIM_RATIO    of char height
    #   FILL otherwise  (small, irregular, off-centre → accidental gap)

    # ── Tunable thresholds ────────────────────────────────────────────────────
    _LARGE_RATIO   = 0.05   # hole area / char bbox area
    _MED_RATIO     = 0.03
    _CIRC_HIGH     = 0.60   # circularity ∈ [0,1]; 1 = perfect circle
    _CIRC_MED      = 0.70
    _CENTRE_CLOSE  = 0.35   # normalised Euclidean distance from char centre
    _DIM_RATIO     = 0.40   # hole span / char span (width or height)

    _ctrs, _hier = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if _ctrs and _hier is not None:

        # Character bounding box (for relative measurements)
        _ink_px = np.where(binary > 0)
        if len(_ink_px[0]):
            _cy0, _cy1 = int(_ink_px[0].min()), int(_ink_px[0].max())
            _cx0, _cx1 = int(_ink_px[1].min()), int(_ink_px[1].max())
        else:
            _cy0, _cx0 = 0, 0
            _cy1, _cx1 = binary.shape[0], binary.shape[1]
        _cw = max(_cx1 - _cx0, 1)
        _ch = max(_cy1 - _cy0, 1)
        _char_area = _cw * _ch
        _ccx = _cx0 + _cw / 2
        _ccy = _cy0 + _ch / 2

        logger.info("hole_fill: char_bbox=%dx%d  n_contours=%d", _cw, _ch, len(_ctrs))

        _holes_preserve: list[int] = []
        _holes_fill:     list[int] = []

        for _i, _c in enumerate(_ctrs):
            if _hier[0][_i][3] == -1:
                continue   # external contour — not a hole

            _ha = cv2.contourArea(_c)
            _hx, _hy, _hw, _hh = cv2.boundingRect(_c)
            _size_ratio = _ha / _char_area

            _perim = cv2.arcLength(_c, True)
            _circ  = (4 * np.pi * _ha / (_perim ** 2)) if _perim > 0 else 0.0

            # Normalised distance of hole centre from char centre
            _dx = abs((_hx + _hw / 2) - _ccx) / _cw
            _dy = abs((_hy + _hh / 2) - _ccy) / _ch
            _cdist = (_dx ** 2 + _dy ** 2) ** 0.5

            _keep = False
            _why  = ""
            if _size_ratio > _LARGE_RATIO:
                _keep = True;  _why = f"large {_size_ratio*100:.1f}%"
            elif _circ > _CIRC_HIGH and _cdist < _CENTRE_CLOSE:
                _keep = True;  _why = f"circular {_circ:.2f} centred {_cdist:.2f}"
            elif _circ > _CIRC_MED and _size_ratio > _MED_RATIO:
                _keep = True;  _why = f"circular {_circ:.2f} med-size {_size_ratio*100:.1f}%"
            elif _hw / _cw > _DIM_RATIO or _hh / _ch > _DIM_RATIO:
                _keep = True;  _why = f"wide {_hw}x{_hh} vs {_cw}x{_ch}"

            if _keep:
                _holes_preserve.append(_i)
                logger.info("hole_fill:  hole #%d area=%.0f (%.1f%%) circ=%.2f → PRESERVE (%s)",
                            _i, _ha, _size_ratio*100, _circ, _why)
            else:
                _holes_fill.append(_i)
                logger.info("hole_fill:  hole #%d area=%.0f (%.1f%%) circ=%.2f → FILL (accidental gap)",
                            _i, _ha, _size_ratio*100, _circ)

        logger.info("hole_fill: preserve=%d  fill=%d", len(_holes_preserve), len(_holes_fill))

        # Build output: fill everything solid, then punch out intentional holes
        _filled = np.zeros_like(binary)
        for _i, _c in enumerate(_ctrs):
            if _hier[0][_i][3] == -1:          # external → draw solid
                cv2.drawContours(_filled, [_c], -1, 255, thickness=cv2.FILLED)
        for _i in _holes_preserve:             # cut out intentional holes
            cv2.drawContours(_filled, [_ctrs[_i]], -1, 0, thickness=cv2.FILLED)

        binary = _filled

    # ── 6. Connected-component filtering (the key fix) ───────────────────────
    # Scattered noise pixels extend the bounding box to cover the whole image.
    # We keep only blobs large enough to be real ink strokes, then take their
    # combined bounding box.  This gives a tight, noise-free crop.
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)

    total_ink_px = int((binary > 0).sum())
    if total_ink_px == 0:
        logger.warning("sample %d: no ink pixels found — skipped", sample_idx)
        return None   # type: ignore[return-value]

    # Minimum blob area: at least 0.5 % of total ink OR 80 px (whichever is larger).
    # This discards dust/noise while keeping fine strokes.
    min_area = max(80, int(total_ink_px * 0.005))

    keep_labels = [
        i for i in range(1, n_labels)          # 0 = background
        if stats[i, cv2.CC_STAT_AREA] >= min_area
    ]

    if not keep_labels:
        logger.warning("sample %d: all blobs too small (min_area=%d) — skipped",
                       sample_idx, min_area)
        return None   # type: ignore[return-value]

    # Rebuild a clean binary image from the kept blobs only
    clean = np.zeros_like(binary)
    for lbl in keep_labels:
        clean[labels == lbl] = 255

    # ── 7. Tight bounding-box crop ───────────────────────────────────────────
    coords = cv2.findNonZero(clean)
    bx, by, bw, bh = cv2.boundingRect(coords)
    pad = 10
    x1  = max(0, bx - pad);              y1  = max(0, by - pad)
    x2  = min(clean.shape[1], bx+bw+pad); y2 = min(clean.shape[0], by+bh+pad)
    mask_crop = clean[y1:y2, x1:x2]

    crop_h, crop_w = mask_crop.shape
    logger.info("sample %d: crop %dx%d  blobs=%d  ink_px=%d",
                sample_idx, crop_w, crop_h, len(keep_labels),
                int((mask_crop > 0).sum()))

    _INK = (25, 25, 45)   # dark blue-black pen colour (R, G, B)

    # ── 8a. Vectorise via potrace ─────────────────────────────────────────────
    from modules.synthesizer import _TARGET_CHAR_H as _TCH
    svg_text = _bitmap_to_svg(mask_crop, f"s{sample_idx}_{id(mask_crop)}")
    if svg_text is not None:
        rgba = _svg_to_rgba(svg_text, target_h=_TCH * 2, ink_rgb=_INK)
        if rgba is not None:
            rgba = _normalize_stroke_width(rgba)
            logger.info("sample %d: vectorised → %dx%d",
                        sample_idx, rgba.shape[1], rgba.shape[0])
            return rgba, svg_text   # type: ignore[return-value]

    # ── 8b. Raster fallback ───────────────────────────────────────────────────
    # Dilation to thicken thin strokes and bridge micro-gaps before saving.
    # 3×3 kernel + 2 iterations gives ~1 extra pixel of stroke width on each
    # side, which prevents the "broken" look on low-pressure pen strokes.
    dilate_k  = np.ones((3, 3), dtype=np.uint8)
    mask_crop = cv2.dilate(mask_crop, dilate_k, iterations=2)

    # Clamp to binary after dilation (dilation output is already 0/255 for
    # binary input, but be explicit so alpha has no semi-transparent pixels).
    _, mask_crop = cv2.threshold(mask_crop, 127, 255, cv2.THRESH_BINARY)

    # Full-opacity RGBA: every ink pixel gets alpha = 255, background = 0.
    rgba          = np.zeros((crop_h, crop_w, 4), dtype=np.uint8)
    rgba[:, :, 0] = _INK[0]
    rgba[:, :, 1] = _INK[1]
    rgba[:, :, 2] = _INK[2]
    rgba[:, :, 3] = mask_crop   # binary: 255 = full ink, 0 = fully transparent

    rgba = _normalize_stroke_width(rgba)
    logger.info("sample %d: raster → %dx%d", sample_idx, crop_w, crop_h)
    return rgba, None   # type: ignore[return-value]


# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/debug-extraction")
async def debug_extraction(
    body: SaveCharacterSamplesRequest,
    uid: str = Depends(require_auth),
):
    if os.getenv("APP_ENV", "production") != "development":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    """
    Dev-only: run _extract_character on the first sample and return diagnostics.
    Saves intermediate images to backend/debug_output/.
    """
    import base64 as _b64
    from modules.extractor import _load_upright
    from PIL import Image as _PilImg

    debug_dir = Path(__file__).parent / "debug_output"
    debug_dir.mkdir(exist_ok=True)

    if not body.samples:
        return {"error": "no samples"}

    raw_bytes = _b64.b64decode(body.samples[0])
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
    tmp.write(raw_bytes); tmp.close()
    bgr = _load_upright(tmp.name)
    Path(tmp.name).unlink(missing_ok=True)

    if bgr is None:
        return {"error": "could not decode image"}

    # Save original
    _PilImg.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).save(str(debug_dir / "0_original.png"))

    h0, w0 = bgr.shape[:2]
    if max(h0, w0) > 1400:
        sc = 1400 / max(h0, w0)
        bgr = cv2.resize(bgr, (int(w0*sc), int(h0*sc)), cv2.INTER_AREA)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _PilImg.fromarray(gray).save(str(debug_dir / "1_gray.png"))

    bg_blur = cv2.GaussianBlur(gray, (61, 61), 0).astype(np.float32)
    bg_blur = np.maximum(bg_blur, 1.0)
    normalised = np.clip(gray.astype(np.float32) / bg_blur * 255, 0, 255).astype(np.uint8)
    _PilImg.fromarray(normalised).save(str(debug_dir / "2_normalised.png"))

    blurred = cv2.GaussianBlur(normalised, (3, 3), 0)
    binary  = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY_INV, blockSize=21, C=10)
    _PilImg.fromarray(binary).save(str(debug_dir / "3_threshold.png"))

    if binary.shape[1] >= 80:
        h_kern  = cv2.getStructuringElement(cv2.MORPH_RECT, (binary.shape[1]//3, 1))
        h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kern, iterations=1)
        binary  = cv2.subtract(binary, h_lines)
    if binary.shape[0] >= 80:
        v_kern  = cv2.getStructuringElement(cv2.MORPH_RECT, (1, binary.shape[0]//3))
        v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kern, iterations=1)
        binary  = cv2.subtract(binary, v_lines)
    _PilImg.fromarray(binary).save(str(debug_dir / "4_lines_removed.png"))

    open_k = np.ones((2, 2), dtype=np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, open_k, iterations=1)
    _PilImg.fromarray(binary).save(str(debug_dir / "5_cleaned.png"))

    coords = cv2.findNonZero(binary)
    if coords is None:
        return {"error": "no ink found after processing", "debug_dir": str(debug_dir)}

    bx, by, bw, bh = cv2.boundingRect(coords)
    mask_crop = binary[max(0,by-10):by+bh+10, max(0,bx-10):bx+bw+10]
    _PilImg.fromarray(mask_crop).save(str(debug_dir / "6_crop.png"))

    result = _extract_character(bgr, 0)
    rgba = result[0] if result else None

    return {
        "original_size": f"{w0}×{h0}",
        "ink_pixels_before_crop": int((binary > 0).sum()),
        "crop_size": f"{bw}×{bh}",
        "extraction_ok": rgba is not None,
        "vectorised": result is not None and result[1] is not None,
        "potrace_available": _potrace_available(),
        "debug_images": [str(p) for p in sorted(debug_dir.glob("*.png"))],
    }


def _process_samples_sync(
    user_id: str, char: str, samples_b64: list[str],
) -> tuple[list[np.ndarray], str | None]:
    """
    CPU-bound portion of save-character-samples — runs in a thread pool so
    it doesn't block the asyncio event loop.

    Returns (rgba_images, error_detail).  error_detail is None on success.
    """
    import base64 as _b64
    from modules.extractor import _load_upright

    rgba_images: list[np.ndarray] = []

    for idx, b64 in enumerate(samples_b64):
        try:
            raw_bytes = _b64.b64decode(b64)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
            tmp.write(raw_bytes)
            tmp.close()

            bgr = _load_upright(tmp.name)
            Path(tmp.name).unlink(missing_ok=True)

            if bgr is None:
                logger.warning("sample %d could not be decoded — skipped", idx)
                continue

            result = _extract_character(bgr, idx)
            if result is None:
                continue

            rgba, svg_text = result
            crop_h, crop_w = rgba.shape[:2]
            logger.info(
                "sample %d: extracted %dx%d  ink_px=%d  vectorised=%s",
                idx, crop_w, crop_h, int((rgba[:, :, 3] > 0).sum()),
                svg_text is not None,
            )
            rgba_images.append(rgba)

        except Exception as exc:
            logger.error("sample %d processing failed: %s", idx, exc)

    if not rgba_images:
        return [], "no usable samples after processing"

    return rgba_images, None


@app.post("/save-character-samples")
async def save_character_samples(body: SaveCharacterSamplesRequest, uid: str = Depends(require_auth)):
    """
    Save multiple handwriting samples for a single known character.

    No OCR is performed — the character identity comes from the request.
    Each base64 image is:
      1. EXIF-corrected (phone photos)
      2. Thresholded to isolate ink
      3. Cropped to the character's bounding box
      4. Saved to local storage as a PNG

    Response
    --------
    { "status": "success", "character": str, "samples_saved": int, "urls": list[str] }
    """
    import asyncio

    _check_rate_limit(uid)

    if not body.samples:
        return {"status": "error", "detail": "no samples provided"}

    char = body.character
    logger.info(
        "save-character-samples: user=%s char=%r samples=%d",
        uid, char, len(body.samples),
    )

    # Run CPU-heavy extraction in a thread so the event loop stays responsive
    rgba_images, error_detail = await asyncio.to_thread(
        _process_samples_sync, uid, char, body.samples,
    )

    if error_detail:
        logger.warning("save-character-samples: %s", error_detail)
        raise HTTPException(status_code=422, detail=error_detail)

    ok = firebase_client.save_character_bank(uid, {char: rgba_images})
    if not ok:
        logger.warning("save_character_bank reported partial failure for char=%r", char)

    saved_bank = firebase_client.load_character_bank(uid)
    char_data  = saved_bank.get(char, {})
    urls       = [v["url"] for v in char_data.get("variants", []) if "url" in v]

    logger.info(
        "save-character-samples: char=%r saved %d/%d samples → %d urls",
        char, len(rgba_images), len(body.samples), len(urls),
    )

    return {
        "status":        "success",
        "character":     char,
        "samples_saved": len(rgba_images),
        "urls":          urls,
    }


@app.post("/debug/vision")
async def debug_vision(
    file: UploadFile = File(...),
    uid: str = Depends(require_auth),
):
    if os.getenv("APP_ENV", "production") != "development":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    """
    Dev-only endpoint: upload an image and get back exactly what Vision API sees.
    Call from browser/Postman or curl:
        curl -X POST http://localhost:8000/debug/vision -F "file=@/path/to/photo.jpg"
    """
    import base64 as _b64
    import requests as _req
    from modules.extractor import _VISION_API_KEY, _VISION_URL

    suffix   = Path(file.filename or "img.jpg").suffix or ".jpg"
    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp_file.write(content)
        tmp_file.close()

        # Send original bytes directly — preserving EXIF so Vision API sees the
        # upright image.  Re-encoding through cv2 would strip EXIF and potentially
        # rotate the image, giving misleading debug results.
        b64 = _b64.b64encode(content).decode()

        # Still decode with cv2 just to report the image dimensions.
        import cv2 as _cv2
        img = _cv2.imread(tmp_file.name)
        if img is None:
            return {"error": "could not decode image"}
        h, w = img.shape[:2]

        if not _VISION_API_KEY:
            return {"error": "GOOGLE_VISION_API_KEY not set in .env"}

        def _call_vision(b64_data: str, use_lang_hint: bool) -> dict:
            req_body = {
                "image": {"content": b64_data},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            }
            if use_lang_hint:
                req_body["imageContext"] = {"languageHints": ["he"]}
            r = _req.post(
                _VISION_URL,
                params={"key": _VISION_API_KEY},
                json={"requests": [req_body]},
                timeout=30,
            )
            return r.json()

        # Try with Hebrew hint first; if empty, retry without any hint.
        data = _call_vision(b64, use_lang_hint=True)
        responses = data.get("responses", [{}])
        ft = responses[0].get("fullTextAnnotation", {})
        detected_text = ft.get("text", "")
        hint_used = "he"

        if not detected_text:
            data2 = _call_vision(b64, use_lang_hint=False)
            responses2 = data2.get("responses", [{}])
            ft2 = responses2.get("fullTextAnnotation", {}) if isinstance(responses2, dict) else responses2[0].get("fullTextAnnotation", {})
            text2 = ft2.get("text", "")
            if text2:
                # No-hint call found something — language hint was the blocker
                ft = ft2
                responses = responses2 if isinstance(responses2, dict) else [responses2[0]]
                detected_text = text2
                hint_used = "none (he-hint returned empty)"

        # Count per character
        char_counts: dict[str, int] = {}
        for page in ft.get("pages", []):
            for block in page.get("blocks", []):
                for para in block.get("paragraphs", []):
                    for word in para.get("words", []):
                        for sym in word.get("symbols", []):
                            c = sym.get("text", "")
                            char_counts[c] = char_counts.get(c, 0) + 1

        # Check which vertex format was used
        vertex_format = "none"
        for page in ft.get("pages", []):
            for block in page.get("blocks", []):
                for para in block.get("paragraphs", []):
                    for word in para.get("words", []):
                        for sym in word.get("symbols", []):
                            bb = sym.get("boundingBox", {})
                            if bb.get("vertices"):
                                vertex_format = "vertices (pixels)"
                            elif bb.get("normalizedVertices"):
                                vertex_format = "normalizedVertices (0-1 floats)"
                            break

        first_resp = responses[0] if isinstance(responses, list) else responses
        text_annotations = first_resp.get("textAnnotations", []) if isinstance(first_resp, dict) else []
        raw_text_path = text_annotations[0].get("description", "") if text_annotations else ""

        return {
            "image_size":         f"{w}x{h}",
            "language_hint":      hint_used,
            "detected_text":      detected_text[:500],
            "raw_text_path":      raw_text_path[:200],
            "total_symbols":      sum(char_counts.values()),
            "unique_chars":       len(char_counts),
            "char_counts":        char_counts,
            "vertex_format":      vertex_format,
            "api_error":          first_resp.get("error") if isinstance(first_resp, dict) else None,
            "raw_response_keys":  list(first_resp.keys()) if isinstance(first_resp, dict) else [],
            "full_raw_response":  str(data)[:1000],
        }
    finally:
        Path(tmp_file.name).unlink(missing_ok=True)


_MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB

@app.post("/upload-sample")
async def upload_sample(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    uid: str = Depends(require_auth),
):
    assert_same_user(uid, user_id)
    _check_rate_limit(user_id)
    from modules.extractor import build_bank_from_image

    logger.info("=== upload-sample: user=%s filename=%s ===", user_id, file.filename)

    suffix = Path(file.filename or "sample.jpg").suffix or ".jpg"
    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read(_MAX_UPLOAD_BYTES + 1)
        if len(content) > _MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                detail="הקובץ גדול מדי (מקסימום 20MB)")
        tmp_file.write(content)
        tmp_file.close()
        tmp_path = tmp_file.name
        logger.info("upload-sample: saved %d KB → %s", len(content) // 1024, tmp_path)

        # Single Vision API call on the full image → {char: [crops]}
        bank = build_bank_from_image(tmp_path)

        logger.info(
            "upload-sample: recognised %d unique Hebrew characters: %s",
            len(bank), sorted(bank.keys()),
        )

        if not bank:
            logger.warning(
                "upload-sample: no Hebrew characters detected. "
                "Check debug_output/3_vision_boxes.png to see what Vision API found."
            )
            return {}

        # Persist to Firebase and local JSON fallback
        firebase_client.save_character_bank(user_id, bank)
        local_meta = {
            char: {"count": len(variants), "variants": []}
            for char, variants in bank.items()
        }
        _save_bank(user_id, local_meta)

        # Return the full bank from Firebase (includes download URLs)
        saved = firebase_client.load_character_bank(user_id)
        return saved if saved else _load_bank(user_id)

    finally:
        tmp_file.close()
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass


@app.post("/validate")
async def validate(
    body: ValidateRequest,
    request: Request,
    uid: str = Depends(require_auth),
):
    """
    Check whether the user's glyph bank covers every character in *text*.

    Response
    --------
    {
        "ok": bool,
        "missing": list[str],
        "coverage_percent": float,
        "sample_page_url": str | null   # only present when missing chars exist
    }
    """
    assert_same_user(uid, body.user_id)
    _check_rate_limit(body.user_id)
    bank = firebase_client.load_character_bank(body.user_id)
    result = validate_text(body.text, bank)

    sample_page_url = None
    if result["missing"]:
        try:
            abs_path = generate_sample_page(result["missing"])
            rel_path = Path(abs_path).relative_to(Path(__file__).parent)
            sample_page_url = str(request.base_url) + str(rel_path).replace("\\", "/")
        except Exception as exc:
            logger.warning("generate_sample_page failed: %s", exc)

    return {**result, "sample_page_url": sample_page_url}


@app.post("/convert")
async def convert(body: ConvertRequest, uid: str = Depends(require_auth)):
    """
    Render *text* in the user's handwriting and return public download URLs.

    Pipeline
    --------
    1. Load the user's character bank from Firebase (fall back to local JSON).
    2. Validate that all characters in *text* are covered by the bank.
    3. Build a VariantPicker and synthesise lines with compose_paragraph.
    4. Load the requested paper background.
    5. Arrange lines onto one or more pages with render_full_page.
    6. Embed an invisible watermark on each page.
    7. Export each page as PNG.
    8. Upload pages to Firebase Storage.
    9. Return the list of public download URLs.

    Response
    --------
    {
        "ok": bool,
        "pages": int,
        "urls": list[str],
        "error": str | null
    }
    """
    assert_same_user(uid, body.user_id)
    _check_convert_rate_limit(body.user_id)

    from modules.synthesizer import VariantPicker, compose_paragraph
    from modules.layout import load_background, render_full_page, embed_watermark, export_page

    try:
        # 1. Load bank from Firebase
        bank = firebase_client.load_character_bank(body.user_id)
        logger.info("convert: user=%s bank_chars=%s text=%r",
                    body.user_id, sorted(bank.keys()), body.text[:60])

        # 2. Validate coverage
        result = validate_text(body.text, bank)
        if not result["ok"]:
            return {
                "ok": False,
                "pages": 0,
                "urls": [],
                "error": f"Missing characters: {', '.join(result['missing'])}",
            }

        # 3. Synthesise lines
        picker = VariantPicker(bank)
        _MARGIN = 200
        valid_ink = {"black", "blue", "red"}
        ink_color = body.ink_color if body.ink_color in valid_ink else "black"
        lines  = compose_paragraph(
            body.text, picker,
            margin=_MARGIN,
            style={
                "char_height":     body.style.char_height,
                "letter_spacing":  body.style.letter_spacing,
                "word_spacing":    body.style.word_spacing,
                "baseline_jitter": body.style.baseline_jitter,
                "slant":           body.style.slant,
                "ink_blobs":       body.style.ink_blobs,
            },
            ink_color=ink_color,
        )
        logger.info("convert: synthesised %d lines for %d chars",
                    len(lines), len([c for c in body.text if c != " "]))

        if not lines:
            return {"ok": False, "pages": 0, "urls": [], "error": "No content to render"}

        # 4. Load background
        valid_bgs = {"blank", "lines", "grid"}
        bg_type   = body.background if body.background in valid_bgs else "blank"
        background = load_background(bg_type)

        # 5. Arrange lines onto pages
        pages = render_full_page(lines, background, margin=_MARGIN, slant_px=body.style.slant, scan_mode=body.scan_mode)

        urls: list[str] = []
        timestamp = int(time.time())

        for i, page in enumerate(pages):
            # 6. Watermark
            page_wm = embed_watermark(page, body.user_id)

            # 7. Export as PNG to a temp file
            # Include scan_mode in filename so clean/photo renders never overwrite each other
            filename = f"page_{body.scan_mode}_{timestamp}_{i + 1:02d}.png"
            tmp_path = str(Path(tempfile.gettempdir()) / filename)
            export_page(page_wm, "png", tmp_path)

            # 8. Upload to Firebase Storage
            with open(tmp_path, "rb") as fh:
                image_bytes = fh.read()

            url = firebase_client.upload_rendered_page(body.user_id, filename, image_bytes)

            # Fall back to local /static if upload returns None
            if url is None:
                static_dest = _STATIC_DIR / "sample_pages" / filename
                static_dest.write_bytes(image_bytes)
                url = f"{_SERVER_HOST}/static/sample_pages/{filename}"

            urls.append(url)

            # Clean up temp file
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass

        # 9. Increment daily usage counter (skip for preview/debounce calls)
        if not body.preview:
            firebase_client.increment_usage(body.user_id)

        # 10. Build response metadata
        FREE_DAILY_LIMIT  = 5
        is_pro            = firebase_client.check_is_pro_user(body.user_id)
        usage_today       = firebase_client.get_usage_count(body.user_id)
        usage_remaining   = None if is_pro else max(0, FREE_DAILY_LIMIT - usage_today)

        return {
            "ok":               True,
            "pages":            len(pages),
            "urls":             urls,
            "error":            None,
            "watermark_visible": not is_pro,
            "usage_remaining":  usage_remaining,
        }

    except Exception as exc:
        logger.error("convert: unhandled error for user=%s text=%r: %s",
                     body.user_id, body.text[:60], exc, exc_info=True)
        return {
            "ok":    False,
            "pages": 0,
            "urls":  [],
            "error": "שגיאת שרת פנימית. נסה שוב.",
            "watermark_visible": True,
        }


class ConvertBothRequest(BaseModel):
    text:       str        = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id:    str        = Field(..., min_length=1, max_length=128)
    background: str        = Field("lines", pattern=r"^(blank|lines|grid)$")
    ink_color:  str        = Field("black", pattern=r"^(black|blue|red)$")
    style:      StyleParams = StyleParams()
    preview:    bool        = False


@app.post("/convert-both")
async def convert_both(body: ConvertBothRequest, uid: str = Depends(require_auth)):
    """
    Render *text* in both clean and photo modes in a single request.

    Synthesises glyphs once, renders clean pages, then derives photo pages by
    applying apply_photo_effect to each clean page — avoiding a second full
    synthesis pass.  Returns both URL sets so the client can switch modes
    instantly without making a second network request.

    Response
    --------
    {
        "ok": bool,
        "pages": int,
        "clean_urls": list[str],
        "photo_urls": list[str],
        "error": str | null
    }
    """
    assert_same_user(uid, body.user_id)
    _check_convert_rate_limit(body.user_id)

    from modules.synthesizer import VariantPicker, compose_paragraph
    from modules.layout import (
        load_background, render_full_page, embed_watermark,
        export_page, apply_photo_effect,
    )

    try:
        bank = firebase_client.load_character_bank(body.user_id)
        logger.info("convert-both: user=%s bank_chars=%s text=%r",
                    body.user_id, sorted(bank.keys()), body.text[:60])

        result = validate_text(body.text, bank)
        if not result["ok"]:
            return {
                "ok": False, "pages": 0,
                "clean_urls": [], "photo_urls": [],
                "error": f"Missing characters: {', '.join(result['missing'])}",
            }

        picker = VariantPicker(bank)
        _MARGIN = 200
        valid_ink = {"black", "blue", "red"}
        ink_color = body.ink_color if body.ink_color in valid_ink else "black"

        lines = compose_paragraph(
            body.text, picker,
            margin=_MARGIN,
            style={
                "char_height":     body.style.char_height,
                "letter_spacing":  body.style.letter_spacing,
                "word_spacing":    body.style.word_spacing,
                "baseline_jitter": body.style.baseline_jitter,
                "slant":           body.style.slant,
                "ink_blobs":       body.style.ink_blobs,
            },
            ink_color=ink_color,
        )
        logger.info("convert-both: synthesised %d lines", len(lines))

        if not lines:
            return {"ok": False, "pages": 0, "clean_urls": [], "photo_urls": [],
                    "error": "No content to render"}

        valid_bgs = {"blank", "lines", "grid"}
        bg_type   = body.background if body.background in valid_bgs else "blank"
        background = load_background(bg_type)

        # Render clean pages once
        clean_pages = render_full_page(
            lines, background, margin=_MARGIN,
            slant_px=body.style.slant, scan_mode='clean',
        )

        # Derive photo pages from clean pages (avoids second synthesis pass)
        photo_pages = [apply_photo_effect(p.copy()) for p in clean_pages]

        timestamp = int(time.time())
        clean_urls: list[str] = []
        photo_urls: list[str] = []

        for i, (clean_pg, photo_pg) in enumerate(zip(clean_pages, photo_pages)):
            page_num = f"{i + 1:02d}"

            # Clean page
            clean_wm  = embed_watermark(clean_pg, body.user_id)
            clean_fn  = f"page_clean_{timestamp}_{page_num}.png"
            clean_tmp = str(Path(tempfile.gettempdir()) / clean_fn)
            export_page(clean_wm, "png", clean_tmp)
            with open(clean_tmp, "rb") as fh:
                clean_bytes = fh.read()
            clean_url = firebase_client.upload_rendered_page(body.user_id, clean_fn, clean_bytes)
            if clean_url is None:
                dest = _STATIC_DIR / "sample_pages" / clean_fn
                dest.write_bytes(clean_bytes)
                clean_url = f"{_SERVER_HOST}/static/sample_pages/{clean_fn}"
            clean_urls.append(clean_url)
            Path(clean_tmp).unlink(missing_ok=True)

            # Photo page
            photo_wm  = embed_watermark(photo_pg, body.user_id)
            photo_fn  = f"page_photo_{timestamp}_{page_num}.png"
            photo_tmp = str(Path(tempfile.gettempdir()) / photo_fn)
            export_page(photo_wm, "png", photo_tmp)
            with open(photo_tmp, "rb") as fh:
                photo_bytes = fh.read()
            photo_url = firebase_client.upload_rendered_page(body.user_id, photo_fn, photo_bytes)
            if photo_url is None:
                dest = _STATIC_DIR / "sample_pages" / photo_fn
                dest.write_bytes(photo_bytes)
                photo_url = f"{_SERVER_HOST}/static/sample_pages/{photo_fn}"
            photo_urls.append(photo_url)
            Path(photo_tmp).unlink(missing_ok=True)

        if not body.preview:
            firebase_client.increment_usage(body.user_id)

        FREE_DAILY_LIMIT = 5
        is_pro           = firebase_client.check_is_pro_user(body.user_id)
        usage_today      = firebase_client.get_usage_count(body.user_id)
        usage_remaining  = None if is_pro else max(0, FREE_DAILY_LIMIT - usage_today)

        logger.info("convert-both: done — %d pages, %d clean + %d photo URLs",
                    len(clean_pages), len(clean_urls), len(photo_urls))

        return {
            "ok":               True,
            "pages":            len(clean_pages),
            "clean_urls":       clean_urls,
            "photo_urls":       photo_urls,
            "error":            None,
            "watermark_visible": not is_pro,
            "usage_remaining":  usage_remaining,
        }

    except Exception as exc:
        logger.error("convert-both: unhandled error for user=%s: %s",
                     body.user_id, exc, exc_info=True)
        return {
            "ok": False, "pages": 0,
            "clean_urls": [], "photo_urls": [],
            "error": "שגיאת שרת פנימית. נסה שוב.",
            "watermark_visible": True,
        }


@app.delete("/character/{user_id}/{char}")
async def delete_character(user_id: str, char: str, uid: str = Depends(require_auth)):
    """Delete all saved samples for a single character."""
    assert_same_user(uid, user_id)
    ok = firebase_client.delete_character(user_id, char)
    return {"status": "ok" if ok else "error", "character": char}


@app.get("/character/{user_id}/{char}/variants")
async def get_character_variants(user_id: str, char: str, uid: str = Depends(require_auth)):
    """Return saved variant metadata (url, index) for one character."""
    assert_same_user(uid, user_id)
    bank = firebase_client.load_character_bank(user_id)
    data = bank.get(char, {})
    variants = [
        {"index": i, "url": v["url"]}
        for i, v in enumerate(data.get("variants", []))
        if "url" in v
    ]
    return {"character": char, "variants": variants}


@app.delete("/character/{user_id}/{char}/variant/{index}")
async def delete_character_variant(user_id: str, char: str, index: int, uid: str = Depends(require_auth)):
    """Delete one specific variant by index; re-index remaining variants."""
    assert_same_user(uid, user_id)
    ok = firebase_client.delete_character_variant(user_id, char, index)
    return {"status": "ok" if ok else "error"}


@app.post("/glyphs")
async def get_glyphs(body: GlyphsRequest, uid: str = Depends(require_auth)):
    """
    Return one representative variant URL per unique character in *text*.
    """
    assert_same_user(uid, body.user_id)
    _check_rate_limit(body.user_id)
    from modules.synthesizer import normalize_char

    bank = firebase_client.load_character_bank(body.user_id)
    unique_chars = {c for c in body.text if c.strip()}

    glyph_map: dict[str, str] = {}
    missing:   list[str]      = []

    for ch in unique_chars:
        norm      = normalize_char(ch)
        char_data = bank.get(ch) or bank.get(norm) or {}
        variants  = char_data.get("variants", [])
        url = next((v["url"] for v in variants if v.get("url")), None)
        if url:
            glyph_map[ch] = url
        else:
            missing.append(ch)

    return {"glyphs": glyph_map, "missing": missing}


@app.get("/bank/{user_id}")
async def get_bank(user_id: str, uid: str = Depends(require_auth)):
    """Return the user's current character bank (characters list)."""
    assert_same_user(uid, user_id)
    bank = firebase_client.load_character_bank(user_id)
    chars = list(bank.keys())
    return {"user_id": user_id, "characters": chars, "count": len(chars)}


@app.get("/usage/{user_id}")
async def get_usage(user_id: str, uid: str = Depends(require_auth)):
    """Return today's conversion count for the user."""
    assert_same_user(uid, user_id)
    count = firebase_client.get_usage_count(user_id)
    return {"user_id": user_id, "today_count": count}


@app.delete("/bank/{user_id}")
async def clear_bank(user_id: str, uid: str = Depends(require_auth)):
    """Delete all character samples for the user (Firebase + local JSON)."""
    assert_same_user(uid, user_id)
    ok = firebase_client.clear_character_bank(user_id)
    (_BANKS_DIR / f"{user_id}.json").unlink(missing_ok=True)
    return {"ok": ok}


@app.delete("/user/{user_id}")
async def delete_user(user_id: str, uid: str = Depends(require_auth)):
    """Delete all stored data for the user (Firebase + local JSON bank)."""
    assert_same_user(uid, user_id)
    ok = firebase_client.delete_user_data(user_id)
    (_BANKS_DIR / f"{user_id}.json").unlink(missing_ok=True)
    return {"ok": ok}
