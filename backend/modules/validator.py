"""Missing character detection and sample-page generation."""

import os
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Page geometry — A4 at 300 DPI
# ---------------------------------------------------------------------------

_PAGE_W = 2480
_PAGE_H = 3508
_MARGIN = 130          # left/right/top margin in pixels
_COLS   = 3            # character cards per row

_USABLE_W = _PAGE_W - 2 * _MARGIN
_CARD_W   = _USABLE_W // _COLS
_CARD_PAD = 24         # inner horizontal padding inside each card

# Font sizes (PIL truetype sizes ≈ px height at 300 DPI)
_SZ_CHAR  = 160        # the displayed missing character
_SZ_LABEL = 30         # instruction line
_SZ_TITLE = 54         # page title
_SZ_SUB   = 34         # page subtitle

# Writing-line slots below each character
_WRITING_LINES  = 3
_WRITING_LINE_H = 88   # vertical space per writing slot

# Derived card height
_CHAR_AREA_H = _SZ_CHAR + 50
_LABEL_H     = _SZ_LABEL + 18
_CARD_H      = _CHAR_AREA_H + _LABEL_H + _WRITING_LINES * _WRITING_LINE_H + 40

# Title block height (reserved at the top of the page)
_TITLE_H = 230

# Colors (RGB)
_WHITE     = (255, 255, 255)
_BLACK     = (20,  20,  20)
_GRAY      = (185, 185, 185)
_DARK_GRAY = (80,  80,  80)
_ACCENT    = (185, 45,  45)   # red accent for missing-character label
_CARD_BG   = (248, 248, 248)  # very-light-gray card background

# Where generated pages are saved (relative to backend root)
_STATIC_DIR = Path(__file__).parent.parent / "static" / "sample_pages"

# Font search order: Windows first, then common Linux/macOS paths.
# All candidates have full Hebrew Unicode coverage.
_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialuni.ttf",    # Arial Unicode MS (Office install)
    r"C:\Windows\Fonts\arial.ttf",       # Arial — standard Hebrew block
    r"C:\Windows\Fonts\calibri.ttf",     # Calibri — Hebrew block
    r"C:\Windows\Fonts\times.ttf",       # Times New Roman
    r"C:\Windows\Fonts\tahoma.ttf",      # Tahoma — good for small sizes
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",   # Debian/Ubuntu
    "/System/Library/Fonts/Helvetica.ttc",               # macOS
]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _find_font(size: int) -> ImageFont.FreeTypeFont:
    """Return the first available Unicode font at *size* px, or PIL default."""
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    # Fallback: PIL's built-in bitmap font (no Hebrew, but won't crash).
    return ImageFont.load_default()


def _draw_dashed_line(
    draw: ImageDraw.ImageDraw,
    x0: int,
    y: int,
    x1: int,
    dash: int = 10,
    gap: int = 7,
    color: tuple = _GRAY,
    width: int = 2,
) -> None:
    """Draw a horizontal dashed line from (x0, y) to (x1, y)."""
    x = x0
    while x < x1:
        end = min(x + dash, x1)
        draw.line([(x, y), (end, y)], fill=color, width=width)
        x += dash + gap


def _centered_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    cx: int,
    y: int,
    color: tuple = _BLACK,
) -> int:
    """Draw *text* horizontally centred on *cx*; return the bottom y."""
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    draw.text((cx - w // 2, y), text, font=font, fill=color)
    return y + (bbox[3] - bbox[1])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate_text(text: str, user_bank: dict) -> dict:
    """
    Check which characters in *text* are absent from *user_bank*.

    Parameters
    ----------
    text : str
        The document text the user wants to render in their handwriting.
    user_bank : dict
        Mapping of character → glyph data.  Only the keys matter here.

    Returns
    -------
    dict
        {
            "ok": bool,
            "missing": list[str],      # unique chars not in bank
            "coverage_percent": float  # 0–100, two decimal places
        }
    """
    # Step 1 & 2 — unique characters, whitespace stripped
    whitespace = {" ", "\n", "\t", "\r"}
    unique_chars = {ch for ch in text if ch not in whitespace}

    if not unique_chars:
        return {"ok": True, "missing": [], "coverage_percent": 100.0}

    # Step 3 — compare against bank keys
    bank_keys = set(user_bank.keys())
    missing = sorted(unique_chars - bank_keys)   # sorted for deterministic output

    # Step 4 — coverage
    covered = len(unique_chars) - len(missing)
    coverage = round(covered / len(unique_chars) * 100, 2)

    return {
        "ok": len(missing) == 0,
        "missing": missing,
        "coverage_percent": coverage,
    }


def generate_sample_page(missing_chars: list[str]) -> str:
    """
    Generate an A4 PNG (300 DPI) with a writing-practice slot for every
    character in *missing_chars*.

    Each slot shows:
    - The character in a large display font
    - The instruction "Please write this character 3 times:"
    - Three dotted baseline lines for the user to write on

    Parameters
    ----------
    missing_chars : list[str]
        Characters that are absent from the user's glyph bank.

    Returns
    -------
    str
        Absolute path to the saved PNG file.
    """
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)

    # Pre-load fonts once (expensive on first call, cached by the OS after that)
    font_title = _find_font(_SZ_TITLE)
    font_sub   = _find_font(_SZ_SUB)
    font_char  = _find_font(_SZ_CHAR)
    font_label = _find_font(_SZ_LABEL)

    img  = Image.new("RGB", (_PAGE_W, _PAGE_H), _WHITE)
    draw = ImageDraw.Draw(img)

    # ------------------------------------------------------------------
    # Title block
    # ------------------------------------------------------------------
    title_cx = _PAGE_W // 2
    y = _MARGIN

    y = _centered_text(draw, "Handscript — Character Practice Sheet", font_title, title_cx, y, _BLACK)
    y += 16
    y = _centered_text(
        draw,
        "Write each character clearly 3 times on the lines provided.",
        font_sub,
        title_cx,
        y,
        _DARK_GRAY,
    )
    y += 20

    # Thin horizontal rule under the title
    draw.line([(_MARGIN, y), (_PAGE_W - _MARGIN, y)], fill=_GRAY, width=2)
    y += 30

    # ------------------------------------------------------------------
    # Character cards
    # ------------------------------------------------------------------
    for card_idx, char in enumerate(missing_chars):
        col = card_idx % _COLS
        row = card_idx // _COLS

        card_x = _MARGIN + col * _CARD_W
        card_y = y + row * (_CARD_H + 30)

        # Guard: stop drawing if we'd overflow the page
        if card_y + _CARD_H > _PAGE_H - _MARGIN:
            break

        inner_x0 = card_x + _CARD_PAD
        inner_x1 = card_x + _CARD_W - _CARD_PAD
        inner_cx  = (inner_x0 + inner_x1) // 2

        # Card background
        draw.rectangle(
            [card_x + 4, card_y + 4, card_x + _CARD_W - 4, card_y + _CARD_H - 4],
            fill=_CARD_BG,
            outline=_GRAY,
            width=1,
        )

        cy = card_y + 18

        # --- Missing-character display ---
        cy = _centered_text(draw, char, font_char, inner_cx, cy, _ACCENT)
        cy += 14

        # --- Instruction label ---
        cy = _centered_text(
            draw,
            "Please write this character 3 times:",
            font_label,
            inner_cx,
            cy,
            _DARK_GRAY,
        )
        cy += 18

        # --- Three writing slots ---
        for _ in range(_WRITING_LINES):
            slot_top    = cy
            slot_bottom = cy + _WRITING_LINE_H - 12

            # Light top boundary line
            draw.line([(inner_x0, slot_top), (inner_x1, slot_top)], fill=_GRAY, width=1)

            # Dashed baseline at the bottom of the slot
            _draw_dashed_line(draw, inner_x0, slot_bottom, inner_x1, color=_GRAY, width=2)

            cy += _WRITING_LINE_H

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------
    filename = f"sample_{uuid.uuid4().hex[:12]}.png"
    out_path = _STATIC_DIR / filename
    img.save(str(out_path), "PNG", dpi=(300, 300))

    return str(out_path)
