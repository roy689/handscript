import asyncio
import hashlib
import json
import logging
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

try:
    from dotenv import load_dotenv
    _local_env = Path(os.getenv("LOCALAPPDATA", "")) / "handscript" / ".env"
    if _local_env.exists():
        load_dotenv(_local_env)
    else:
        load_dotenv()  # fallback to ./.env
except ImportError:
    pass


# ── Sentry error tracking (Fix #3) ────────────────────────────────────────────
# Initialise BEFORE FastAPI is created so startup errors get captured.
# SENTRY_DSN is optional — when unset, the entire block is skipped.
def _sentry_scrub(event, hint):
    """Strip auth tokens, emails, and passwords from Sentry events before sending."""
    request = event.get("request") or {}
    headers = request.get("headers") or {}
    if isinstance(headers, dict):
        for k in list(headers.keys()):
            if k.lower() in {"authorization", "x-dev-user-id", "cookie"}:
                headers[k] = "[Filtered]"
    data = request.get("data") or {}
    if isinstance(data, dict):
        for k in ("password", "refreshToken", "idToken", "email"):
            if k in data:
                data[k] = "[Filtered]"
    return event


try:
    _sentry_dsn = os.getenv("SENTRY_DSN")
    if _sentry_dsn:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration

        sentry_sdk.init(
            dsn=_sentry_dsn,
            integrations=[
                FastApiIntegration(transaction_style="endpoint"),
                StarletteIntegration(),
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
            environment=os.getenv("APP_ENV", "development"),
            release=os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown"),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            send_default_pii=False,
            before_send=_sentry_scrub,
        )
except ImportError:
    pass  # sentry-sdk not installed — silently skip


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
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware

from modules.auth import require_auth, assert_same_user

from modules.validator import validate_text, generate_sample_page
if os.getenv("APP_ENV") == "production":
    from modules import firebase_storage as firebase_client
else:
    from modules import local_storage as firebase_client
from services import auth_service, firebase_service
from services import config as _svc_config

logger = logging.getLogger(__name__)


def _uid_tag(uid: str) -> str:
    """Return a short non-reversible tag for logging — never logs the real uid."""
    return hashlib.sha256(uid.encode()).hexdigest()[:8]


@contextmanager
def _tempfile(suffix: str = ".jpg"):
    """Context manager that creates a NamedTemporaryFile and guarantees cleanup."""
    tf = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    path = tf.name
    try:
        yield tf, path
    finally:
        try:
            tf.close()
        except OSError:
            pass
        Path(path).unlink(missing_ok=True)


_DEBUG = os.getenv("ENABLE_DEBUG_ENDPOINTS", "").lower() == "true"

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
_ALLOWED_ORIGINS += [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]

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


class _HttpsRedirectMiddleware(BaseHTTPMiddleware):
    """
    In production, redirect plain HTTP requests to HTTPS.

    Exception: Railway's internal load-balancer probes /health over plain
    HTTP from a private IP (e.g. 100.64.0.2) and does NOT follow redirects —
    a 301 here breaks the healthcheck and Railway marks the deployment as
    Failed. We therefore bypass the redirect for /health entirely. External
    traffic still hits Railway's edge proxy which terminates TLS and sets
    `x-forwarded-proto: https`, so this exception is safe.
    """
    async def dispatch(self, request: Request, call_next):
        if os.getenv("APP_ENV") == "production":
            # Always allow internal healthchecks (Railway uses plain HTTP)
            if request.url.path == "/health":
                return await call_next(request)
            # Default to empty string so an unset header is treated as HTTP, not HTTPS
            forwarded_proto = request.headers.get("x-forwarded-proto", "").lower()
            if forwarded_proto != "https":
                https_url = str(request.url).replace("http://", "https://", 1)
                return Response(
                    status_code=301,
                    headers={"Location": https_url},
                )
        return await call_next(request)


app.add_middleware(_HttpsRedirectMiddleware)

class _TrustedHostMiddleware(BaseHTTPMiddleware):
    """
    Trusted-host check that bypasses /health.

    Starlette's built-in TrustedHostMiddleware rejects requests whose Host
    header isn't in the allowlist — but Railway's internal load-balancer
    sends healthchecks with a Host header that's not a public domain
    (e.g. an internal IP or `*.railway.internal`).  Listing that explicitly
    would defeat the purpose of the allowlist.

    Our custom version always lets /health through and applies the strict
    check only to other paths, so external traffic still gets the
    protection against Host header injection.
    """

    def __init__(self, app, allowed_hosts: list[str]):
        super().__init__(app)
        self._exact: set[str] = set()
        self._wildcard_suffixes: list[str] = []
        self._allow_any: bool = False
        for h in allowed_hosts:
            h = h.strip().lower()
            if not h:
                continue
            if h == "*":
                self._allow_any = True
                break
            if h.startswith("*."):
                self._wildcard_suffixes.append(h[1:])   # ".railway.app"
            else:
                self._exact.add(h)

    def _is_allowed(self, host_header: str) -> bool:
        if self._allow_any:
            return True
        host = host_header.split(":", 1)[0].lower()  # strip port if present
        if host in self._exact:
            return True
        return any(host.endswith(sfx) for sfx in self._wildcard_suffixes)

    async def dispatch(self, request: Request, call_next):
        # Always allow internal healthchecks
        if request.url.path == "/health":
            return await call_next(request)
        host_header = request.headers.get("host", "")
        if not self._is_allowed(host_header):
            return Response(status_code=400, content=b"Invalid host header")
        return await call_next(request)


if os.getenv("APP_ENV") == "production":
    _trusted_hosts = [
        h.strip() for h in os.getenv("TRUSTED_HOSTS", "").split(",") if h.strip()
    ]
    if not _trusted_hosts:
        raise RuntimeError(
            "TRUSTED_HOSTS env var must be set in production "
            "(e.g. 'api.handscript.co.il,*.railway.app')"
        )
    app.add_middleware(_TrustedHostMiddleware, allowed_hosts=_trusted_hosts)

# ---------------------------------------------------------------------------
# Static files — generated sample pages are served from /static/
# ---------------------------------------------------------------------------

_STATIC_DIR = Path(__file__).parent / "static"
_STATIC_DIR.mkdir(exist_ok=True)
(_STATIC_DIR / "sample_pages").mkdir(exist_ok=True)

_DATA_BANKS = Path(__file__).parent / "data" / "banks"
_DATA_BANKS.mkdir(parents=True, exist_ok=True)

# ── Character-bank in-memory cache ───────────────────────────────────────────
# Caches the Firestore character bank for each user for up to 2 minutes.
# Preview renders hit this endpoint repeatedly (every slider move → 600 ms
# debounce), so avoiding a Firestore round-trip per render saves ~300-500 ms.
# The TTL is short enough that a newly-uploaded sample appears within 2 minutes.
_BANK_CACHE: dict[str, tuple[dict, float]] = {}
_BANK_CACHE_TTL = 120   # seconds


def _load_bank_cached(user_id: str) -> dict:
    """Return the user's character bank, using a 2-minute in-memory cache."""
    entry = _BANK_CACHE.get(user_id)
    if entry and (time.time() - entry[1]) < _BANK_CACHE_TTL:
        return entry[0]
    bank = firebase_client.load_character_bank(user_id)
    _BANK_CACHE[user_id] = (bank, time.time())
    return bank


def _invalidate_bank_cache(user_id: str) -> None:
    """Remove a user's cached bank so the next call fetches fresh data."""
    _BANK_CACHE.pop(user_id, None)


app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


async def _cleanup_old_pages() -> None:
    """Delete rendered pages older than 24 hours to prevent disk fill (B8)."""
    cutoff = time.time() - 24 * 3600
    pages_dir = _STATIC_DIR / "sample_pages"
    deleted = 0
    for p in pages_dir.glob("*.png"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
                deleted += 1
        except OSError:
            pass
    if deleted:
        logger.info("cleanup_old_pages: deleted %d stale pages", deleted)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(3600)  # run every hour
        await _cleanup_old_pages()
        _prune_rate_buckets()


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_cleanup_loop())
    if not os.getenv("FIREBASE_WEB_API_KEY"):
        logger.critical("FIREBASE_WEB_API_KEY missing — /auth/* endpoints will fail")
    # Build the circular email logo (best-effort; never blocks startup).
    try:
        from services.logo import ensure_round_logo
        await asyncio.to_thread(ensure_round_logo)
    except Exception as exc:
        logger.warning("round logo init failed: %s", exc)
# /banks is no longer a public StaticFiles mount — served via authenticated route below


@app.get("/banks/{user_id}/chars/{char_hex}/{filename}")
async def get_variant(
    user_id: str,
    char_hex: str,
    filename: str,
    uid: str = Depends(require_auth),
):
    """Serve a character variant image — requires auth and ownership."""
    assert_same_user(uid, user_id)
    file_path = (_DATA_BANKS / user_id / "chars" / char_hex / filename).resolve()
    if not str(file_path).startswith(str(_DATA_BANKS.resolve())):
        raise HTTPException(status_code=404)
    if not file_path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(file_path)

# Configure local storage with the server's own host (read from env or auto-detect for dev)
def _detect_server_host() -> str:
    """Return the machine's LAN IP for local dev. In production, SERVER_HOST env var must be set."""
    if os.getenv("APP_ENV") == "production":
        raise RuntimeError("SERVER_HOST environment variable must be set in production")
    import socket as _socket
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:8000"
    except Exception:
        return "http://localhost:8000"

_SERVER_HOST = os.getenv("SERVER_HOST") or _detect_server_host()
if not _SERVER_HOST.startswith(("http://", "https://")):
    raise RuntimeError(f"Invalid SERVER_HOST: {_SERVER_HOST!r}. Must start with http:// or https://")
logger.info("Server host: %s", _SERVER_HOST)
firebase_client.configure(_SERVER_HOST)

# Expose the active client to firebase_service without a circular import (D1)
_svc_config.firebase_client = firebase_client

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

import re as _re_uid
_SAFE_UID_FILE_RE = _re_uid.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _load_bank(user_id: str) -> dict:
    """Return the user's character bank, or an empty dict if not found."""
    if not _SAFE_UID_FILE_RE.fullmatch(user_id):
        logger.warning("_load_bank: rejecting invalid user_id %r", user_id)
        return {}
    path = _BANKS_DIR / f"{user_id}.json"
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("_load_bank: corrupt %s — returning empty (%s)", path, exc)
        return {}


def _save_bank(user_id: str, bank: dict) -> None:
    if not _SAFE_UID_FILE_RE.fullmatch(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    path = _BANKS_DIR / f"{user_id}.json"
    tmp  = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)  # atomic rename


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
        fresh = [t for t in _rate_buckets[user_id] if now - t < _RATE_WINDOW]
        if len(fresh) >= _RATE_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי בקשות. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        fresh.append(now)
        _rate_buckets[user_id] = fresh
        # Pruning happens periodically in _cleanup_loop, not here.

_ip_login_buckets: dict[str, list[float]] = collections.defaultdict(list)
_IP_LOGIN_LIMIT  = 10   # max login/signup attempts per IP per minute

def _check_ip_rate_limit(ip: str) -> None:
    """IP-based rate limit for unauthenticated auth endpoints."""
    now = time.time()
    with _rate_lock:
        fresh = [t for t in _ip_login_buckets[ip] if now - t < _RATE_WINDOW]
        if len(fresh) >= _IP_LOGIN_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי ניסיונות. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        fresh.append(now)
        _ip_login_buckets[ip] = fresh
        # Pruning happens periodically in _cleanup_loop, not here.

_CONVERT_RATE_LIMIT = 6   # /convert is heavy — tighter limit
_convert_buckets: dict[str, list[float]] = collections.defaultdict(list)

def _check_convert_rate_limit(user_id: str) -> None:
    now = time.time()
    with _rate_lock:
        fresh = [t for t in _convert_buckets[user_id] if now - t < _RATE_WINDOW]
        if len(fresh) >= _CONVERT_RATE_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי בקשות המרה. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        fresh.append(now)
        _convert_buckets[user_id] = fresh
        # Pruning happens periodically in _cleanup_loop, not here.


_RESET_PWD_BUCKETS: dict[str, list[float]] = collections.defaultdict(list)
_RESET_PWD_LIMIT = 3  # tighter — password reset is a phishing/enum vector

_RESEND_VERIFY_BUCKETS: dict[str, list[float]] = collections.defaultdict(list)
_RESEND_VERIFY_LIMIT = 3  # 3 resends per minute per IP — same as password reset


def _check_reset_rate_limit(ip: str) -> None:
    now = time.time()
    with _rate_lock:
        fresh = [t for t in _RESET_PWD_BUCKETS[ip] if now - t < _RATE_WINDOW]
        if len(fresh) >= _RESET_PWD_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי ניסיונות איפוס. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        fresh.append(now)
        _RESET_PWD_BUCKETS[ip] = fresh
        # Pruning happens periodically in _cleanup_loop, not here.


def _check_resend_verify_rate_limit(ip: str) -> None:
    now = time.time()
    with _rate_lock:
        fresh = [t for t in _RESEND_VERIFY_BUCKETS[ip] if now - t < _RATE_WINDOW]
        if len(fresh) >= _RESEND_VERIFY_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="יותר מדי ניסיונות שליחה. נסה שוב בעוד דקה.",
                headers={"Retry-After": "60"},
            )
        fresh.append(now)
        _RESEND_VERIFY_BUCKETS[ip] = fresh


def _prune_rate_buckets() -> None:
    """Drop expired/empty buckets — called periodically from _cleanup_loop."""
    now = time.time()
    with _rate_lock:
        for bucket_dict in (_rate_buckets, _ip_login_buckets, _convert_buckets, _RESET_PWD_BUCKETS, _RESEND_VERIFY_BUCKETS):
            for key in list(bucket_dict.keys()):
                bucket_dict[key] = [t for t in bucket_dict[key] if now - t < _RATE_WINDOW]
                if not bucket_dict[key]:
                    del bucket_dict[key]


# ---------------------------------------------------------------------------
# Request models — all fields include length/range limits
# ---------------------------------------------------------------------------

_MAX_TEXT = 25_000   # characters

class ValidateRequest(BaseModel):
    text:    str = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id: str = Field(..., min_length=1, max_length=128)


class StyleParams(BaseModel):
    char_height:      int   = Field(85,   ge=40,    le=130)
    letter_spacing:   float = Field(4.0,  ge=-30.0, le=30.0)   # negative → letters overlap (tighter than touching)
    word_spacing:     int   = Field(35,   ge=0,     le=100)
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
    # user_id removed — uid comes from JWT only
    character: str        = Field(..., min_length=1, max_length=4)
    samples:   list[str]  = Field(..., min_length=1, max_length=10)  # base64 images

    @field_validator("character")
    @classmethod
    def single_codepoint(cls, v: str) -> str:
        if len(v) != 1:
            raise ValueError("character must be exactly one Unicode code point")
        return v

    @field_validator("samples")
    @classmethod
    def limit_sample_size(cls, v: list[str]) -> list[str]:
        max_b64_len = int(1.5 * 1024 * 1024)  # ~1 MB binary per sample (B24)
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
    import subprocess
    if not _potrace_available():
        return None
    tmp_dir  = Path(tempfile.gettempdir()) / "potrace_tmp"
    tmp_dir.mkdir(exist_ok=True)
    pbm_path = tmp_dir / f"{temp_id}.pbm"
    svg_path = tmp_dir / f"{temp_id}.svg"
    try:
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
        return svg_text
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
        logger.warning("potrace failed: %s — falling back to raster", exc)
        return None
    finally:
        pbm_path.unlink(missing_ok=True)
        svg_path.unlink(missing_ok=True)


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
    target_frac: float = 0.075,
) -> np.ndarray:
    """
    Normalise stroke width so every STORED glyph has the same thickness
    relative to its bounding-box height, regardless of pen pressure or photo
    conditions.  This is the extraction-time pass; a second pass runs at
    synthesis time (synthesizer.normalize_stroke_width) to handle any residual
    differences after the glyph is scaled to the render character height.

    Algorithm
    ---------
    1. Extract the alpha channel (ink mask).
    2. Median of distanceTransform nonzero values → current_radius.
    3. Iteratively dilate (too thin) or erode (too thick) with a 3×3 elliptic
       kernel until within ±8 % of target_radius, up to 8 iterations.

    target_frac=0.075 matches _STROKE_RATIO in synthesizer.py so both passes
    converge to the same target.  The stored resolution is _TARGET_CHAR_H × 2
    ≈ 160 px, giving target_radius ≈ 6 px (≈ 0.5 mm, medium ballpoint pen).

    Tolerance tightened from the previous absolute 0.75 px (≈ 13 %) to ±8 %
    so that characters photographed with different pens or pressures reach the
    same visual weight before being saved to Firebase Storage.
    """
    alpha = rgba[:, :, 3].copy()
    h = alpha.shape[0]
    if h == 0:
        return rgba

    dist = cv2.distanceTransform(alpha, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    nonzero_dists = dist[dist > 0]
    if len(nonzero_dists) < 20:
        return rgba  # too sparse to measure reliably

    current_radius = float(np.median(nonzero_dists))
    target_radius  = target_frac * h / 2.0
    if target_radius <= 0:
        return rgba

    logger.info(
        "stroke_norm: h=%dpx  current_r=%.2f  target_r=%.2f  ratio=%.2f",
        h, current_radius, target_radius,
        current_radius / target_radius if target_radius > 0 else 0,
    )

    kernel    = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    new_alpha = alpha.copy()
    _MAX_ITERS = 12   # re-measures after each step — converges reliably

    for i in range(_MAX_ITERS):
        ratio = current_radius / target_radius
        if 0.92 <= ratio <= 1.08:   # within ±8 % — stop
            logger.info("stroke_norm: converged after %d iter(s)  ratio=%.2f", i, ratio)
            break
        if ratio > 1.08:
            new_alpha = cv2.erode(new_alpha, kernel, iterations=1)
            logger.debug("stroke_norm: ERODE iter %d", i + 1)
        else:
            new_alpha = cv2.dilate(new_alpha, kernel, iterations=1)
            logger.debug("stroke_norm: DILATE iter %d", i + 1)
        # Re-measure ACTUAL radius — old ±1.0 bookkeeping was wrong for complex glyphs
        d = cv2.distanceTransform(new_alpha, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        nz = d[d > 0]
        if len(nz) < 10:
            logger.debug("stroke_norm: glyph eroded away at iter %d", i + 1)
            break
        current_radius = float(np.median(nz))

    result = rgba.copy()
    result[:, :, 3] = new_alpha
    # Paint newly-dilated pixels with the existing ink colour so they blend in.
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
# Auth proxy endpoints — Firebase credentials stay on the server
# ---------------------------------------------------------------------------

class _AuthCredentials(BaseModel):
    email:    str = Field(..., min_length=3,  max_length=254, pattern=r"[^@]+@[^@]+\.[^@]+")
    password: str = Field(..., min_length=6,  max_length=128)

class _RefreshRequest(BaseModel):
    refreshToken: str = Field(..., min_length=1, max_length=512)

class _ResetRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254, pattern=r"[^@]+@[^@]+\.[^@]+")

class _IdpSignInRequest(BaseModel):
    """
    Federated sign-in request.
    `id_token` is the credential returned by the native Google / Apple SDK.
    """
    id_token: str = Field(..., min_length=1, max_length=8192)


@app.post("/auth/login")
async def auth_login(body: _AuthCredentials, request: Request):
    _check_ip_rate_limit(request.client.host)
    try:
        return await auth_service.sign_in(body.email, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@app.post("/auth/signup")
async def auth_signup(body: _AuthCredentials, request: Request):
    _check_ip_rate_limit(request.client.host)
    try:
        result = await auth_service.sign_up(body.email, body.password)
        # Send verification email — fire and don't fail signup if it errors.
        # We deliberately do NOT await exceptions here.
        sent = await auth_service.send_email_verification(result["idToken"])
        if not sent:
            logger.warning("auth_signup: verification email delivery failed for new user")
        result["email_verified"] = False
        return result
    except ValueError as exc:
        # EMAIL_EXISTS → 409 Conflict so the client can distinguish "already
        # registered" from other validation failures (which get 400).
        err_msg = str(exc)
        if "כבר רשומה" in err_msg or "EMAIL_EXISTS" in err_msg:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=err_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=err_msg)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@app.post("/auth/signin-google")
async def auth_signin_google(body: _IdpSignInRequest, request: Request):
    """
    Federated sign-in via Google.

    Client flow:
      1. Mobile uses @react-native-google-signin to get an ID token.
      2. Mobile POSTs that token here.
      3. Backend exchanges it with Firebase signInWithIdp.
      4. Returns standard {idToken, refreshToken, uid, email}.
    """
    _check_ip_rate_limit(request.client.host)
    try:
        return await auth_service.sign_in_with_idp(
            provider_id="google.com",
            id_token=body.id_token,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@app.post("/auth/refresh")
async def auth_refresh(body: _RefreshRequest, request: Request):
    _check_ip_rate_limit(request.client.host)
    try:
        return await auth_service.refresh_id_token(body.refreshToken)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@app.post("/auth/reset-password")
async def auth_reset_password(body: _ResetRequest, request: Request):
    _check_reset_rate_limit(request.client.host)
    sent = await auth_service.send_password_reset(body.email)
    if not sent:
        logger.warning("reset-password: delivery failed (email withheld from log)")
    # Always return ok=True to prevent email enumeration
    return {"ok": True}


class _ResendVerificationRequest(BaseModel):
    id_token: str = Field(..., min_length=1, max_length=8192)


class _CheckVerificationRequest(BaseModel):
    uid: str = Field(..., min_length=1, max_length=128)


@app.post("/auth/resend-verification")
async def auth_resend_verification(body: _ResendVerificationRequest, request: Request):
    """
    Re-send the email-verification link to the user identified by id_token.
    Rate-limited to 3 requests per IP per minute.
    Always returns ok=True — never reveals whether the send succeeded.
    """
    _check_resend_verify_rate_limit(request.client.host)
    sent = await auth_service.send_email_verification(body.id_token)
    if not sent:
        logger.warning("resend-verification: delivery failed")
    return {"ok": True}


@app.post("/auth/check-verification")
async def auth_check_verification(body: _CheckVerificationRequest, request: Request):
    """
    Check whether the Firebase Auth user has verified their email.
    Uses the Admin SDK so the result is always fresh.
    Returns {"verified": true/false}.
    """
    _check_ip_rate_limit(request.client.host)
    try:
        verified = auth_service.check_email_verified(body.uid)
        return {"verified": verified}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


class _AcceptTermsRequest(BaseModel):
    id_token: str
    version:  str = "1.0"


@app.post("/auth/accept-terms")
async def auth_accept_terms(body: _AcceptTermsRequest, request: Request):
    """
    Record that the authenticated user has accepted the Terms of Service.
    Writes { termsAcceptedAt, termsVersion } to users/{uid} in Firestore.
    This is the legal backend record; the mobile side also writes to AsyncStorage.
    """
    _check_ip_rate_limit(request.client.host)
    try:
        import firebase_admin.auth as fb_auth
        decoded = fb_auth.verify_id_token(body.id_token)
        uid = decoded["uid"]
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="טוקן לא תקין")
    try:
        from datetime import datetime, timezone
        db = firebase_service._db()
        db.collection("users").document(uid).set({
            "termsAcceptedAt": datetime.now(timezone.utc).isoformat(),
            "termsVersion":    body.version,
        }, merge=True)
    except Exception as exc:
        logger.error("accept-terms: Firestore write failed for uid=%s: %s", uid, exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail="שמירת האישור נכשלה")
    return {"ok": True}


@app.delete("/auth/account")
async def auth_delete_account(uid: str = Depends(require_auth)):
    """Delete the Firebase Auth account for the authenticated user."""
    try:
        await auth_service.delete_account(uid)
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail="מחיקת חשבון נכשלה")
    return {"ok": True}


@app.get("/subscription/{user_id}")
async def get_subscription(user_id: str, uid: str = Depends(require_auth)):
    assert_same_user(uid, user_id)
    return firebase_service.get_subscription_status(user_id)


# ---------------------------------------------------------------------------

class ErrorReport(BaseModel):
    message:   str       = Field(..., max_length=2000)
    stack:     str | None = Field(None, max_length=10000)
    context:   str = "unknown"
    timestamp: str

@app.post("/debug/error")
async def report_error(body: ErrorReport):
    """Client-side error reporting — only active when ENABLE_DEBUG_ENDPOINTS=true."""
    if not _DEBUG:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    logger.error(
        "[client-error] context=%s message=%s stack_lines=%d timestamp=%s",
        body.context,
        body.message,
        len(body.stack.split('\n')) if body.stack else 0,
        body.timestamp,
    )
    return {"ok": True}


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
    with _tempfile(".jpg") as (tmp, tmp_path):
        tmp.write(raw_bytes); tmp.close()
        bgr = _load_upright(tmp_path)

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
    from modules.synthesizer import normalize_stroke_width, _CHAR_HEIGHT_RATIO

    rgba_images: list[np.ndarray] = []

    for idx, b64 in enumerate(samples_b64):
        try:
            raw_bytes = _b64.b64decode(b64)
            with _tempfile(".jpg") as (tmp, tmp_path):
                tmp.write(raw_bytes)
                tmp.close()
                bgr = _load_upright(tmp_path)

            if bgr is None:
                logger.warning("sample %d could not be decoded — skipped", idx)
                continue

            result = _extract_character(bgr, idx)
            if result is None:
                continue

            rgba, svg_text = result
            crop_h, crop_w = rgba.shape[:2]

            # ── Normalize stroke width at save time ──────────────────────────────
            # Store every glyph with the same stroke-to-height ratio so its visual
            # weight is uniform wherever it's shown — the on-device editing canvas,
            # the live exact preview, and the final document alike. We normalize
            # relative to the glyph's BASE x-height (crop_h / char-height-ratio) so
            # tall letters and descenders get the same proportional weight as
            # x-height letters, matching the server's render-time normalization.
            try:
                _h_ratio     = _CHAR_HEIGHT_RATIO.get(char, 1.0) or 1.0
                _norm_target = max(1, round(crop_h / _h_ratio))
                rgba         = normalize_stroke_width(rgba, _norm_target)
            except Exception as exc:
                logger.warning("sample %d: stroke normalization skipped: %s", idx, exc)

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
        "save-character-samples: user_tag=%s char=%r samples=%d",
        _uid_tag(uid), char, len(body.samples),
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
        raise HTTPException(status_code=500, detail="שמירה נכשלה. נסה שוב.")

    saved_bank = firebase_client.load_character_bank(uid)
    char_data  = saved_bank.get(char, {})
    urls       = [v["url"] for v in char_data.get("variants", []) if "url" in v]

    logger.info(
        "save-character-samples: char=%r saved %d/%d samples → %d urls",
        char, len(rgba_images), len(body.samples), len(urls),
    )

    # Invalidate cached bank so the next preview render picks up the new samples.
    _invalidate_bank_cache(body.user_id)

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
    with _tempfile(suffix) as (tmp_file, tmp_path):
        content = await file.read()
        tmp_file.write(content)
        tmp_file.close()

        # Send original bytes directly — preserving EXIF so Vision API sees the
        # upright image.  Re-encoding through cv2 would strip EXIF and potentially
        # rotate the image, giving misleading debug results.
        b64 = _b64.b64encode(content).decode()

        # Still decode with cv2 just to report the image dimensions.
        import cv2 as _cv2
        img = _cv2.imread(tmp_path)
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
            ft2 = responses2[0].get("fullTextAnnotation", {})
            text2 = ft2.get("text", "")
            if text2:
                # No-hint call found something — language hint was the blocker
                ft = ft2
                responses = responses2
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

    logger.info("=== upload-sample: user_tag=%s ===", _uid_tag(user_id))

    suffix = Path(file.filename or "sample.jpg").suffix or ".jpg"
    with _tempfile(suffix) as (tmp_file, tmp_path):
        content = await file.read(_MAX_UPLOAD_BYTES + 1)
        if len(content) > _MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                detail="הקובץ גדול מדי (מקסימום 20MB)")
        tmp_file.write(content)
        tmp_file.close()
        logger.info("upload-sample: saved %d KB", len(content) // 1024)

        # Single Vision API call on the full image → {char: [crops]}
        bank = await asyncio.to_thread(build_bank_from_image, tmp_path)

    logger.info(
        "upload-sample: recognised %d unique Hebrew characters: %s",
        len(bank), sorted(bank.keys()),
    )

    if not bank:
        logger.warning(
            "upload-sample: no Hebrew characters detected. "
            "Check debug_output/3_vision_boxes.png to see what Vision API found."
        )
        # Return 422 so the mobile shows a clear error instead of an empty bank
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="לא זוהו אותיות עבריות בתמונה. ודא שהתאורה טובה, שהאותיות ברורות, ושהדף ללא רקע מודפס.",
        )

    # Persist to Firebase and local JSON fallback
    firebase_client.save_character_bank(user_id, bank)
    # Merge new chars into existing local metadata instead of overwriting
    existing_meta = _load_bank(user_id)
    for char, variants in bank.items():
        existing_meta[char] = {"count": len(variants), "variants": []}
    _save_bank(user_id, existing_meta)

    # Return the full bank from Firebase (includes download URLs)
    saved = firebase_client.load_character_bank(user_id)
    return saved if saved else _load_bank(user_id)


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
    logger.info("[validate] text_len=%d", len(body.text))
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

    from modules.synthesizer import VariantPicker, compose_paragraph, prefetch_bank_images
    from modules.layout import load_background, render_full_page, embed_watermark, export_page

    try:
        # 1. Load bank from Firebase
        bank = firebase_client.load_character_bank(body.user_id)
        logger.info("convert: bank_size=%d text_len=%d", len(bank), len(body.text))

        # Prefetch all variant images in parallel before synthesis.
        await asyncio.to_thread(prefetch_bank_images, bank)

        # 2. Validate coverage
        result = validate_text(body.text, bank)
        if not result["ok"]:
            return {
                "ok": False,
                "pages": 0,
                "urls": [],
                "error": f"Missing characters: {', '.join(result['missing'])}",
            }

        # 3. Synthesise lines (CPU-bound — run off the event loop)
        picker = VariantPicker(bank)
        for _ch, _cd in bank.items():
            _n = len(_cd.get("variants", []))
            if _n > 0:
                logger.info("convert: char=%r has %d variant(s)", _ch, _n)
        _MARGIN = 200
        valid_ink = {"black", "blue", "red"}
        ink_color = body.ink_color if body.ink_color in valid_ink else "black"
        style_dict = {
            "char_height":     body.style.char_height,
            "letter_spacing":  body.style.letter_spacing,
            "word_spacing":    body.style.word_spacing,
            "baseline_jitter": body.style.baseline_jitter,
            "slant":           body.style.slant,
            "ink_blobs":       body.style.ink_blobs,
        }
        lines = await asyncio.to_thread(
            compose_paragraph,
            body.text, picker,
            margin=_MARGIN,
            style=style_dict,
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

        # 5. Arrange lines onto pages (CPU-bound — run off the event loop)
        pages = await asyncio.to_thread(render_full_page, lines, background, margin=_MARGIN, slant_px=body.style.slant, scan_mode=body.scan_mode)

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

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("convert: unhandled error text_len=%d: %s", len(body.text), exc, exc_info=True)
        raise HTTPException(status_code=500, detail="שגיאת שרת פנימית. נסה שוב.")


class ConvertBothRequest(BaseModel):
    text:       str        = Field(..., min_length=1, max_length=_MAX_TEXT)
    user_id:    str        = Field(..., min_length=1, max_length=128)
    background: str        = Field("lines", pattern=r"^(blank|lines|grid)$")
    ink_color:  str        = Field("black", pattern=r"^(black|blue|red)$")
    style:      StyleParams = StyleParams()
    preview:    bool        = False


class FinalizeRequest(BaseModel):
    # The clean/photo page URLs returned by a previous preview render
    # (/convert-both with preview=true). These point at temporary static files;
    # /finalize promotes them to permanent Firebase Storage without re-rendering,
    # guaranteeing the saved file is pixel-identical to what the user approved.
    user_id:    str       = Field(..., min_length=1, max_length=128)
    clean_urls: list[str] = Field(..., min_length=1, max_length=64)
    photo_urls: list[str] = Field(..., min_length=1, max_length=64)


# Only basenames matching this pattern are accepted by /finalize, blocking any
# path-traversal attempt via the URL the client sends back.
_SAFE_PAGE_FILE_RE = _re_uid.compile(r"^page_(clean|photo)_\d+_\d+\.png$")


@app.post("/finalize")
async def finalize(body: FinalizeRequest, uid: str = Depends(require_auth)):
    """
    Promote an already-rendered preview to a permanent deliverable.

    The preview render (/convert-both with preview=true) writes temporary PNGs
    to the local static dir. Those files are ephemeral — the Railway container
    filesystem resets on every redeploy, and a cleanup task prunes them after
    24h. /finalize copies the EXACT same bytes to Firebase Storage so the file
    the user keeps is permanent, and increments the daily usage count (preview
    renders never do). No re-rendering happens, so the output is byte-identical
    to what the user saw and approved.

    Response
    --------
    {
        "ok": bool,
        "clean_urls": list[str],   # permanent Firebase URLs (or original on per-file upload failure)
        "photo_urls": list[str],
        "expired": bool,           # true when source files are gone → client should re-render
        "usage_remaining": int | null,
        "watermark_visible": bool,
        "error": str | null
    }
    """
    assert_same_user(uid, body.user_id)
    # General limit (not the stricter /convert limit): finalize only copies bytes,
    # it does not render, and it runs right after several preview renders that
    # already consumed the convert budget.
    _check_rate_limit(body.user_id)

    pages_dir = _STATIC_DIR / "sample_pages"

    def _resolve_local(url: str) -> "Path | None":
        """Map a static page URL back to its on-disk file, safely."""
        fn = url.rstrip("/").split("/")[-1]
        if not _SAFE_PAGE_FILE_RE.fullmatch(fn):
            return None
        p = pages_dir / fn
        return p if p.is_file() else None

    clean_paths = [_resolve_local(u) for u in body.clean_urls]
    photo_paths = [_resolve_local(u) for u in body.photo_urls]

    # If ANY source file is missing (container restarted, cleanup ran, or a URL
    # was already a permanent Firebase URL), tell the client to fall back to a
    # full re-render rather than persisting a partial document.
    if any(p is None for p in clean_paths) or any(p is None for p in photo_paths):
        logger.info("finalize: source files unavailable for user_tag=%s → expired",
                    _uid_tag(body.user_id))
        return {
            "ok": False, "expired": True,
            "clean_urls": [], "photo_urls": [],
            "usage_remaining": None, "watermark_visible": True,
            "error": None,
        }

    # ── Authoritative daily-limit gate (mirrors /convert-both) ───────────────
    _FREE_DAILY_LIMIT = 5
    is_pro = firebase_client.check_is_pro_user(body.user_id)
    if not is_pro:
        if firebase_client.get_usage_count(body.user_id) >= _FREE_DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=f"הגעת למגבלת {_FREE_DAILY_LIMIT} המרות ליום. שדרג לפרו להמרות ללא הגבלה.",
            )

    try:
        def _persist(paths: list[Path], originals: list[str]) -> list[str]:
            out: list[str] = []
            for p, original in zip(paths, originals):
                data = p.read_bytes()
                perm = firebase_client.upload_rendered_page(body.user_id, p.name, data)
                # On a Firebase failure keep the still-valid static URL so the
                # document is never broken; it just won't be permanent.
                out.append(perm if perm else original)
            return out

        clean_perm = await asyncio.to_thread(_persist, clean_paths, body.clean_urls)
        photo_perm = await asyncio.to_thread(_persist, photo_paths, body.photo_urls)

        # Count usage exactly once, after a successful persist.
        firebase_client.increment_usage(body.user_id)

        usage_today     = firebase_client.get_usage_count(body.user_id)
        usage_remaining = None if is_pro else max(0, _FREE_DAILY_LIMIT - usage_today)

        logger.info("finalize: persisted %d clean + %d photo pages for user_tag=%s",
                    len(clean_perm), len(photo_perm), _uid_tag(body.user_id))

        return {
            "ok": True, "expired": False,
            "clean_urls": clean_perm,
            "photo_urls": photo_perm,
            "usage_remaining": usage_remaining,
            "watermark_visible": not is_pro,
            "error": None,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("finalize: unhandled error for user_tag=%s: %s",
                     _uid_tag(body.user_id), exc, exc_info=True)
        raise HTTPException(status_code=500, detail="שגיאת שרת פנימית. נסה שוב.")


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

    from modules.synthesizer import VariantPicker, compose_paragraph, prefetch_bank_images
    from modules.layout import (
        load_background, render_full_page, embed_watermark,
        export_page, apply_photo_effect,
    )

    try:
        # Use cached bank for preview renders — avoids a Firestore round-trip
        # every time the user pauses after adjusting a slider.
        bank = _load_bank_cached(body.user_id) if body.preview else firebase_client.load_character_bank(body.user_id)
        logger.info("convert-both: bank_size=%d text_len=%d preview=%s", len(bank), len(body.text), body.preview)

        # Download all variant images in parallel before synthesis so the
        # compose_paragraph loop never blocks on a sequential network request.
        # On the first call this converts ~55 s of sequential downloads into
        # ~3-5 s of parallel downloads.  On subsequent calls everything hits
        # the module-level cache and completes in ~0 ms.
        await asyncio.to_thread(prefetch_bank_images, bank)

        result = validate_text(body.text, bank)
        if not result["ok"]:
            return {
                "ok": False, "pages": 0,
                "clean_urls": [], "photo_urls": [],
                "error": f"Missing characters: {', '.join(result['missing'])}",
            }

        # ── #12 Server-side usage limit ──────────────────────────────────────────
        # Check BEFORE rendering so we don't burn CPU/GPU on a request that will
        # be rejected.  The client-side checkCanConvert() is a soft UX guard only
        # (race condition on multi-device); this is the authoritative gate.
        _FREE_DAILY_LIMIT = 5
        if not body.preview:
            _is_pro_check = firebase_client.check_is_pro_user(body.user_id)
            if not _is_pro_check:
                _usage_check = firebase_client.get_usage_count(body.user_id)
                if _usage_check >= _FREE_DAILY_LIMIT:
                    raise HTTPException(
                        status_code=429,
                        detail=f"הגעת למגבלת {_FREE_DAILY_LIMIT} המרות ליום. שדרג לפרו להמרות ללא הגבלה.",
                    )

        picker = VariantPicker(bank)
        for _ch, _cd in bank.items():
            _n = len(_cd.get("variants", []))
            if _n > 0:
                logger.info("convert-both: char=%r has %d variant(s)", _ch, _n)
        _MARGIN = 200
        # ink_color and background are already validated by Pydantic (pattern
        # constraint on ConvertBothRequest) — no redundant fallback needed.
        ink_color = body.ink_color
        style_dict = {
            "char_height":     body.style.char_height,
            "letter_spacing":  body.style.letter_spacing,
            "word_spacing":    body.style.word_spacing,
            "baseline_jitter": body.style.baseline_jitter,
            "slant":           body.style.slant,
            "ink_blobs":       body.style.ink_blobs,
        }

        # fast_mode skips normalize_stroke_width and uses BILINEAR resampling —
        # saves ~800-1200 ms per page with imperceptible quality difference at preview sizes.
        lines = await asyncio.to_thread(
            compose_paragraph,
            body.text, picker,
            margin=_MARGIN,
            style=style_dict,
            ink_color=ink_color,
            fast_mode=body.preview,
        )
        logger.info("convert-both: synthesised %d lines (fast_mode=%s)", len(lines), body.preview)

        if not lines:
            return {"ok": False, "pages": 0, "clean_urls": [], "photo_urls": [],
                    "error": "No content to render"}

        bg_type    = body.background   # already validated by Pydantic
        logger.info("convert-both: background=%r", bg_type)
        background = load_background(bg_type)

        # Render clean pages once (CPU-bound — run off the event loop)
        clean_pages = await asyncio.to_thread(
            render_full_page,
            lines, background, margin=_MARGIN,
            slant_px=body.style.slant, scan_mode='clean',
        )

        # Derive photo pages from clean pages (avoids second synthesis pass)
        photo_pages = await asyncio.to_thread(
            lambda: [apply_photo_effect(p.copy()) for p in clean_pages]
        )

        timestamp = int(time.time())
        clean_urls: list[str] = []
        photo_urls: list[str] = []

        # ── #6 Clean up stale renders before uploading new ones ──────────────────
        # Fire-and-forget: non-fatal if it fails.  Prevents Storage cost creep
        # from accumulated page_clean_*/page_photo_* files (2×N per conversion).
        asyncio.get_event_loop().run_in_executor(
            None, firebase_client.delete_old_renders, body.user_id
        )

        # ── #13 Temp-file cleanup on failure ─────────────────────────────────────
        # Track every temp path created so the finally block can delete them even
        # if export_page or Firebase upload raises an exception mid-loop.
        _tmp_paths: list[Path] = []

        try:
            for i, (clean_pg, photo_pg) in enumerate(zip(clean_pages, photo_pages)):
                page_num = f"{i + 1:02d}"

                # Clean page
                clean_wm  = embed_watermark(clean_pg, body.user_id)
                clean_fn  = f"page_clean_{timestamp}_{page_num}.png"
                clean_tmp = Path(tempfile.gettempdir()) / clean_fn
                _tmp_paths.append(clean_tmp)
                export_page(clean_wm, "png", str(clean_tmp))
                with open(clean_tmp, "rb") as fh:
                    clean_bytes = fh.read()
                # Preview renders skip Firebase Storage entirely — serve from local
                # static files instead.  Saves ~500 ms × 2 modes per page.
                if body.preview:
                    dest = _STATIC_DIR / "sample_pages" / clean_fn
                    dest.write_bytes(clean_bytes)
                    clean_url = f"{_SERVER_HOST}/static/sample_pages/{clean_fn}"
                else:
                    clean_url = firebase_client.upload_rendered_page(body.user_id, clean_fn, clean_bytes)
                    if clean_url is None:
                        dest = _STATIC_DIR / "sample_pages" / clean_fn
                        dest.write_bytes(clean_bytes)
                        clean_url = f"{_SERVER_HOST}/static/sample_pages/{clean_fn}"
                clean_urls.append(clean_url)

                # Photo page
                photo_wm  = embed_watermark(photo_pg, body.user_id)
                photo_fn  = f"page_photo_{timestamp}_{page_num}.png"
                photo_tmp = Path(tempfile.gettempdir()) / photo_fn
                _tmp_paths.append(photo_tmp)
                export_page(photo_wm, "png", str(photo_tmp))
                with open(photo_tmp, "rb") as fh:
                    photo_bytes = fh.read()
                if body.preview:
                    dest = _STATIC_DIR / "sample_pages" / photo_fn
                    dest.write_bytes(photo_bytes)
                    photo_url = f"{_SERVER_HOST}/static/sample_pages/{photo_fn}"
                else:
                    photo_url = firebase_client.upload_rendered_page(body.user_id, photo_fn, photo_bytes)
                    if photo_url is None:
                        dest = _STATIC_DIR / "sample_pages" / photo_fn
                        dest.write_bytes(photo_bytes)
                        photo_url = f"{_SERVER_HOST}/static/sample_pages/{photo_fn}"
                photo_urls.append(photo_url)

        finally:
            # Always delete temp files — even on partial failure mid-loop.
            for _p in _tmp_paths:
                _p.unlink(missing_ok=True)

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

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("convert-both: unhandled error for user_tag=%s: %s",
                     _uid_tag(body.user_id), exc, exc_info=True)
        raise HTTPException(status_code=500, detail="שגיאת שרת פנימית. נסה שוב.")


@app.delete("/character/{user_id}/{char}")
async def delete_character(user_id: str, char: str, uid: str = Depends(require_auth)):
    """Delete all saved samples for a single character."""
    assert_same_user(uid, user_id)
    ok = firebase_client.delete_character(user_id, char)
    _invalidate_bank_cache(user_id)
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
    _invalidate_bank_cache(user_id)
    return {"status": "ok" if ok else "error"}


@app.post("/glyphs")
async def get_glyphs(body: GlyphsRequest, uid: str = Depends(require_auth)):
    """
    Return ALL variant URLs per unique character in *text*.

    Previously this returned a single representative URL per character, which
    meant the client-side preview rendered every occurrence of a character with
    the same image — defeating the whole purpose of uploading multiple samples.

    Now it returns the full list of variant URLs per character so the client
    can pick a different sample for each occurrence, matching the variety the
    server-side /convert renderer already produces.

    Response shape:
        { "glyphs": { "<char>": ["url0", "url1", ...] }, "missing": [...] }
    """
    assert_same_user(uid, body.user_id)
    _check_rate_limit(body.user_id)
    logger.info("[glyphs] text_len=%d", len(body.text))
    from modules.synthesizer import normalize_char

    bank = firebase_client.load_character_bank(body.user_id)
    # Use the SAME whitespace definition as validate_text so the two endpoints
    # agree on which characters are "content" (avoids invisible chars slipping
    # through validation but being absent from glyph_map → computer-font fallback).
    _WHITESPACE = {" ", "\n", "\t", "\r"}
    unique_chars = {c for c in body.text if c not in _WHITESPACE}

    glyph_map: dict[str, list[str]] = {}
    missing:   list[str]            = []

    for ch in unique_chars:
        norm      = normalize_char(ch)
        char_data = bank.get(ch) or bank.get(norm) or {}
        variants  = char_data.get("variants", [])
        # Guard: some Firestore docs can have null entries in the variants array
        urls = [v["url"] for v in variants if v is not None and isinstance(v, dict) and v.get("url")]
        if urls:
            glyph_map[ch] = urls
            logger.info("[glyphs] char=%r → %d variant(s)", ch, len(urls))
        else:
            missing.append(ch)
            logger.warning("[glyphs] char=%r → NOT FOUND in bank", ch)

    return {"glyphs": glyph_map, "missing": missing}


@app.get("/bank/{user_id}")
async def get_bank(user_id: str, uid: str = Depends(require_auth)):
    """Return the user's current character bank (characters list)."""
    assert_same_user(uid, user_id)
    logger.info("[bank] user_tag=%s", _uid_tag(uid))
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
