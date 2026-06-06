"""
Generate a circular version of the app logo for use in emails.

Why this exists: a true circle in email must be a pre-cropped PNG with
transparent corners — CSS tricks (border-radius / overflow:hidden) are
unreliable in Gmail and other clients. We can't ship a binary asset easily, so
the backend builds it at startup: it fetches the app logo, center-crops it to a
square, applies a circular alpha mask, and saves it to the static folder. The
email templates then reference it at  {SERVER_HOST}/static/logo_round.png .

Pillow and requests are already backend dependencies, so this runs on Railway
without any extra setup. It is best-effort: any failure is logged and ignored
(the email simply falls back to its alt text + wordmark).
"""

import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Public source logo (the wide "Ink & Parchment" lockup) from the repo.
LOGO_SRC_URL = (
    "https://raw.githubusercontent.com/roy689/handscript/master/mobile/assets/logo.png"
)

_OUT_PATH = Path(__file__).resolve().parent.parent / "static" / "logo_round.png"
_SIZE = 240  # output diameter in px (retina-friendly; displayed ~118px)


def ensure_round_logo(force: bool = False) -> bool:
    """
    Make sure static/logo_round.png exists. Returns True if available.
    Idempotent — skips work if the file is already present (unless force).
    """
    if _OUT_PATH.exists() and not force:
        return True
    try:
        import requests
        from PIL import Image, ImageDraw

        resp = requests.get(LOGO_SRC_URL, timeout=15)
        resp.raise_for_status()
        src = Image.open(io.BytesIO(resp.content)).convert("RGBA")

        # Center-crop to a square (keeps the central emblem, like the app's
        # circular logo on the sign-in screen).
        w, h = src.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        square = src.crop((left, top, left + side, top + side)).resize(
            (_SIZE, _SIZE), Image.LANCZOS
        )

        # Circular alpha mask → transparent corners.
        mask = Image.new("L", (_SIZE, _SIZE), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, _SIZE, _SIZE), fill=255)
        square.putalpha(mask)

        _OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        square.save(_OUT_PATH, "PNG")
        logger.info("ensure_round_logo: wrote %s", _OUT_PATH)
        return True
    except Exception as exc:
        logger.warning("ensure_round_logo: could not build round logo: %s", exc)
        return False
