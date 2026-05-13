"""Character extraction from handwriting samples."""

import base64
import logging
import os
from pathlib import Path

import cv2
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

# Route the module's logger to stdout so every logger.* call is visible in the
# uvicorn terminal without requiring external log configuration.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [extractor] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

_VISION_API_KEY = os.getenv("GOOGLE_VISION_API_KEY", "")
_VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
_CONFIDENCE_THRESHOLD = 0.7
_UNKNOWN = "UNKNOWN"

# Warn loudly at import time so the missing-key problem is caught immediately
# when the server starts, not silently during the first recognition call.
if not _VISION_API_KEY:
    logger.warning(
        "GOOGLE_VISION_API_KEY is not set in .env — "
        "all character recognition calls will return UNKNOWN. "
        "Add the key to backend/.env to enable real recognition."
    )

# Directory for debug images written during development.
_DEBUG_DIR = Path(__file__).parent.parent / "debug_output"


def preprocess_image(image_path: str) -> np.ndarray:
    """
    Load a handwriting image and return a clean binary image ready for
    character segmentation.

    Pipeline
    --------
    1. Load with OpenCV + resize to ≤ 2000 px longest side
    2. Grayscale conversion
    3. Bilateral filter  →  smooth noise while preserving ink edges
    4. Adaptive thresholding  →  binarise locally (handles uneven lighting)
    5. Morphological opening  →  remove isolated noise dots
    6. Morphological closing  →  bridge small gaps inside letter strokes
    7. Deskew  →  straighten text using Hough line detection
    """
    logger.info("preprocess_image: loading %s", image_path)

    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"Could not load image: {image_path}")

    h0, w0 = image.shape[:2]
    logger.info("preprocess_image: original size %dx%d", w0, h0)

    # Step 1 — Resize: cap longest side at 2000 px.
    max_side = 2000
    if max(h0, w0) > max_side:
        scale = max_side / max(h0, w0)
        image = cv2.resize(
            image,
            (int(w0 * scale), int(h0 * scale)),
            interpolation=cv2.INTER_AREA,
        )
        logger.info("preprocess_image: resized to %dx%d", image.shape[1], image.shape[0])

    # Step 2 — Grayscale.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Step 3 — Bilateral filter.
    # Reduces sensor/JPEG noise while keeping the sharp edges of ink strokes.
    # d=9, sigmaColor/Space=75 is the standard "light denoising" setting.
    filtered = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # Step 4 — Adaptive thresholding.
    # blockSize=21 (vs the original 11) handles the larger local illumination
    # gradients typical of phone photos shot under room lighting.
    # C=7 (vs 2) prevents faint background textures from being binarised as ink.
    binary = cv2.adaptiveThreshold(
        filtered,
        maxValue=255,
        adaptiveMethod=cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        thresholdType=cv2.THRESH_BINARY_INV,
        blockSize=21,
        C=7,
    )

    # Step 5 — Morphological opening: erode then dilate with a 2×2 kernel.
    # Removes isolated single-pixel noise dots that survive thresholding.
    kernel = np.ones((2, 2), dtype=np.uint8)
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    # Step 6 — Morphological closing: dilate then erode with a 2×2 kernel.
    # Bridges sub-pixel gaps inside letter strokes without merging neighbours.
    closed = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel)

    # Step 7 — Deskew.
    deskewed = _deskew(closed)

    # Save a debug image so the result can be inspected visually.
    _save_debug("1_preprocessed.png", deskewed)
    ink_pixels = int(np.count_nonzero(deskewed))
    logger.info(
        "preprocess_image: done — %dx%d, %d ink pixels (%.1f%%)",
        deskewed.shape[1], deskewed.shape[0],
        ink_pixels,
        100 * ink_pixels / deskewed.size,
    )

    return deskewed


def _save_debug(filename: str, image: np.ndarray) -> None:
    """Write *image* to debug_output/<filename>, creating the dir if needed."""
    try:
        _DEBUG_DIR.mkdir(exist_ok=True)
        cv2.imwrite(str(_DEBUG_DIR / filename), image)
    except Exception as exc:  # never crash the pipeline over a debug write
        logger.warning("Could not save debug image %s: %s", filename, exc)


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _deskew(binary: np.ndarray) -> np.ndarray:
    """
    Detect the dominant text angle via HoughLines and return the image
    rotated so that text baselines are horizontal.

    Returns the original image unchanged when no reliable angle can be
    determined (e.g. very sparse or blank images).
    """
    # HoughLines works on edges, not on filled blobs.  A Canny pass gives
    # cleaner, thinner edges than the raw binary mask.
    edges = cv2.Canny(binary, threshold1=50, threshold2=150, apertureSize=3)

    # Probabilistic Hough Transform returns line *segments*, which are easier
    # to filter than the infinite lines from the classical transform.
    #   rho=1          — 1-pixel resolution in distance space
    #   theta=π/180    — 1-degree resolution in angle space
    #   threshold=100  — a segment needs ≥ 100 votes to be reported
    #   minLineLength  — ignore very short segments (noise, punctuation dots)
    #   maxLineGap     — bridge gaps up to 10 px so dashed/broken baselines
    #                    still register as a single segment
    h, w = binary.shape[:2]
    min_line_length = max(w // 6, 40)

    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=100,
        minLineLength=min_line_length,
        maxLineGap=10,
    )

    if lines is None or len(lines) == 0:
        # No lines detected — image may be blank or too sparse to deskew.
        return binary

    # Compute the angle of every detected segment.
    # np.arctan2 returns radians in (-π, π); converting to degrees keeps
    # values in (-90°, 90°].  Text lines are near-horizontal, so we keep
    # only segments whose angle is within ±45° of horizontal.
    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle_deg = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if -45.0 <= angle_deg <= 45.0:
            angles.append(angle_deg)

    if not angles:
        return binary

    # Use the median rather than the mean to be robust against outlier
    # segments (vertical strokes, punctuation, borders).
    skew_angle = float(np.median(angles))

    # Skip rotation when the image is already nearly straight (< 0.5°
    # deviation).  Unnecessary rotation introduces interpolation artefacts.
    if abs(skew_angle) < 0.5:
        return binary

    # Rotate around the image centre, keeping the full canvas (no cropping).
    center = (w / 2.0, h / 2.0)
    rotation_matrix = cv2.getRotationMatrix2D(center, skew_angle, scale=1.0)
    rotated = cv2.warpAffine(
        binary,
        rotation_matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,   # fill new pixels with black (background)
    )

    return rotated


# ---------------------------------------------------------------------------
# Contour detection and filtering
# ---------------------------------------------------------------------------

# Area thresholds (pixels²).
# MIN: anything smaller is noise or a stray dot.
# MAX: raised from 15,000 to 40,000 — at 2000 px image width, a large Hebrew
#      letter (e.g. מ or ש) can easily occupy 120×160 px = 19,200 px².
#      15,000 was silently discarding valid characters.
_MIN_AREA = 80
_MAX_AREA = 40_000


def extract_bounding_boxes(binary_image: np.ndarray) -> list[dict]:
    """
    Locate individual character blobs in a binary image and return their
    bounding boxes sorted in Hebrew RTL reading order (right → left).

    Parameters
    ----------
    binary_image : np.ndarray
        White-on-black binary image produced by ``preprocess_image``.

    Returns
    -------
    list[dict]
        Each dict contains: x, y, w, h (bounding-box integers), area (float),
        index (int, 0-based position in RTL reading order).
    """

    # -------------------------------------------------------------------------
    # Step 1 — Find external contours.
    #
    # RETR_EXTERNAL retrieves only the outermost contour of each blob,
    # ignoring holes.  This is what we want for character isolation: the outer
    # boundary of an "aleph" or "bet" regardless of its inner loops.
    # CHAIN_APPROX_SIMPLE compresses horizontal/vertical/diagonal runs into
    # their two endpoints, saving memory without losing shape information.
    # -------------------------------------------------------------------------
    contours, _ = cv2.findContours(
        binary_image,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    logger.info("extract_bounding_boxes: %d raw contours found", len(contours))

    if not contours:
        logger.warning(
            "extract_bounding_boxes: zero contours — the preprocessed image "
            "may be blank.  Check debug_output/1_preprocessed.png."
        )

    valid = []
    too_small = too_large = 0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < _MIN_AREA:
            too_small += 1
        elif area > _MAX_AREA:
            too_large += 1
        else:
            x, y, w, h = cv2.boundingRect(contour)
            valid.append({"x": x, "y": y, "w": w, "h": h, "area": float(area)})

    logger.info(
        "extract_bounding_boxes: %d kept, %d too-small (<%.0f px²), %d too-large (>%.0f px²)",
        len(valid), too_small, _MIN_AREA, too_large, _MAX_AREA,
    )

    # -------------------------------------------------------------------------
    # Step 3 — Sort right-to-left for Hebrew RTL reading order.
    #
    # Hebrew is written and read right-to-left, so the first character in a
    # line has the largest x coordinate.  Sorting by x descending gives the
    # natural reading sequence that the downstream bank-building code expects.
    # -------------------------------------------------------------------------
    valid.sort(key=lambda b: b["x"], reverse=True)

    for i, box in enumerate(valid):
        box["index"] = i

    # Save a debug visualisation with bounding boxes drawn in green.
    annotated = draw_boxes(binary_image, valid)
    _save_debug("2_bounding_boxes.png", annotated)

    return valid


# ---------------------------------------------------------------------------
# Character cropping
# ---------------------------------------------------------------------------

def crop_character(
    original_image: np.ndarray,
    bbox: dict,
    padding: int = 4,
) -> np.ndarray:
    """
    Crop a single character out of *original_image* and return it as an RGBA
    array where the white (background) pixels are fully transparent.

    Parameters
    ----------
    original_image : np.ndarray
        The binary (or grayscale) source image — same spatial dimensions as
        the image that was passed to ``extract_bounding_boxes``.
    bbox : dict
        One element from the list returned by ``extract_bounding_boxes``.
    padding : int
        Extra pixels added on every side of the bounding box before cropping.
        Prevents the crop from shaving off thin stroke edges.

    Returns
    -------
    np.ndarray
        H×W×4 uint8 array (BGRA).  Ink pixels are black + fully opaque;
        background pixels are white + fully transparent.
    """
    h_img, w_img = original_image.shape[:2]

    # Expand the bounding box by *padding*, clamped to image bounds so we
    # never read outside the array.
    x1 = max(bbox["x"] - padding, 0)
    y1 = max(bbox["y"] - padding, 0)
    x2 = min(bbox["x"] + bbox["w"] + padding, w_img)
    y2 = min(bbox["y"] + bbox["h"] + padding, h_img)

    crop = original_image[y1:y2, x1:x2].copy()

    # Ensure the crop is single-channel so we can derive the alpha mask
    # regardless of whether the caller passed a binary or a BGR image.
    if crop.ndim == 3:
        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    else:
        crop_gray = crop

    # Build a 3-channel BGR base: ink pixels → black (0,0,0),
    # background pixels → white (255,255,255).
    # In our THRESH_BINARY_INV convention, ink = white (255) in the binary.
    # We invert so that the colour layer shows black ink on white — the
    # natural appearance for a glyph tile.
    bgr = cv2.cvtColor(cv2.bitwise_not(crop_gray), cv2.COLOR_GRAY2BGR)

    # Alpha channel: ink pixels (originally white in binary) → opaque (255);
    # background pixels (originally black) → transparent (0).
    # crop_gray already has ink=255, background=0, so it doubles as the mask.
    alpha = crop_gray

    # Merge into a 4-channel BGRA image.
    rgba = cv2.merge([bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2], alpha])

    return rgba


# ---------------------------------------------------------------------------
# Debug visualisation
# ---------------------------------------------------------------------------

def draw_boxes(image: np.ndarray, boxes: list[dict]) -> np.ndarray:
    """
    Draw a red bounding rectangle and RTL index label on each detected box.

    Parameters
    ----------
    image : np.ndarray
        Source image (binary, grayscale, or BGR).  A colour copy is made
        internally so the original is never mutated.
    boxes : list[dict]
        Output of ``extract_bounding_boxes``.

    Returns
    -------
    np.ndarray
        BGR image with annotations suitable for ``cv2.imwrite`` or display.
    """
    # Work on a BGR copy so we can draw coloured rectangles even if the
    # source is a single-channel binary image.
    if image.ndim == 2:
        annotated = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    else:
        annotated = image.copy()

    RED   = (0, 0, 255)    # BGR
    WHITE = (255, 255, 255)

    for box in boxes:
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]

        # Rectangle around the character blob.
        cv2.rectangle(annotated, (x, y), (x + w, y + h), RED, thickness=1)

        # Small index label above-left of the box so boxes don't overlap the
        # label when they are tightly packed.
        label = str(box["index"])
        label_origin = (x, max(y - 4, 10))
        cv2.putText(
            annotated,
            label,
            label_origin,
            fontFace=cv2.FONT_HERSHEY_SIMPLEX,
            fontScale=0.35,
            color=WHITE,
            thickness=1,
            lineType=cv2.LINE_AA,
        )

    return annotated


# ---------------------------------------------------------------------------
# Hebrew Unicode range (Basic Hebrew block: א–ת + final forms)
# ---------------------------------------------------------------------------

_HEBREW_START = 0x05D0  # א
_HEBREW_END   = 0x05EA  # ת

def _is_hebrew(char: str) -> bool:
    return len(char) == 1 and _HEBREW_START <= ord(char) <= _HEBREW_END


def _parse_bbox(
    bbox: dict, img_w: int, img_h: int
) -> list[tuple[int, int]]:
    """
    Extract pixel-coordinate vertices from a Vision API ``boundingBox`` dict.

    Vision API can return either:
      • ``vertices``           — pixel integers  {"x": 120, "y": 45}
      • ``normalizedVertices`` — 0.0-1.0 floats  {"x": 0.06, "y": 0.02}

    Returns a list of (x, y) int tuples, or [] when neither key is present.
    """
    raw = bbox.get("vertices", [])
    if raw:
        return [(int(v.get("x", 0)), int(v.get("y", 0))) for v in raw]

    norm = bbox.get("normalizedVertices", [])
    if norm:
        return [
            (int(v.get("x", 0) * img_w), int(v.get("y", 0) * img_h))
            for v in norm
        ]

    return []


# ---------------------------------------------------------------------------
# EXIF-aware image loader
# ---------------------------------------------------------------------------

def _load_upright(image_path: str) -> np.ndarray | None:
    """
    Load an image and apply any EXIF rotation so the pixels are always upright.

    cv2.imread silently ignores EXIF orientation tags, which means phone photos
    (especially portrait-mode shots) arrive rotated 90° or 180° relative to
    what the user sees in their gallery.  Vision API then sees a sideways page
    and returns zero characters.

    Pillow's ImageOps.exif_transpose reads the EXIF Orientation tag and
    physically rotates/flips the pixel data before we convert to OpenCV format.
    Falls back to plain cv2.imread when Pillow is unavailable or the file has
    no EXIF data (e.g. synthetic PNGs).
    """
    try:
        from PIL import Image as _PILImage, ImageOps as _ImageOps
        with _PILImage.open(image_path) as pil_img:
            pil_img = _ImageOps.exif_transpose(pil_img)
            pil_img = pil_img.convert("RGB")
            bgr = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
            logger.info("_load_upright: loaded via Pillow (EXIF-corrected)")
            return bgr
    except Exception as exc:
        logger.warning("_load_upright: Pillow failed (%s) — falling back to cv2.imread", exc)
        return cv2.imread(image_path, cv2.IMREAD_COLOR)


# ---------------------------------------------------------------------------
# Full-image recognition via DOCUMENT_TEXT_DETECTION (primary pipeline)
# ---------------------------------------------------------------------------

def build_bank_from_image(image_path: str) -> dict[str, list[np.ndarray]]:
    """
    Send the full handwriting photo to Vision API using DOCUMENT_TEXT_DETECTION,
    then crop each recognized Hebrew character from the original image.

    Why DOCUMENT_TEXT_DETECTION instead of per-crop TEXT_DETECTION
    -------------------------------------------------------------
    Vision API is designed to see text in context.  Sending a 60×80 px crop
    of a single letter gives it no baseline, no neighbours, no line structure —
    recognition accuracy drops to near-zero for Hebrew.  Sending the full page
    lets the model use all available context; character-level bounding boxes
    are still returned inside ``fullTextAnnotation.pages[].blocks[].paragraphs
    [].words[].symbols[]``, so we get both the label AND the crop location in
    one round-trip.

    Returns
    -------
    dict[str, list[np.ndarray]]
        ``{ "א": [crop1, crop2, ...], "ב": [...], ... }``
        Each crop is a BGR uint8 array (the padded region from the original
        colour image) ready to be stored by ``firebase_client.save_character_bank``.
    """
    if not _VISION_API_KEY:
        logger.error(
            "build_bank_from_image: GOOGLE_VISION_API_KEY is empty — "
            "set it in backend/.env and restart the server."
        )
        return {}

    # ── Load + EXIF-rotate + resize ──────────────────────────────────────────
    # cv2.imread ignores EXIF orientation tags, which causes phone photos to
    # arrive sideways or upside-down.  Pillow's exif_transpose applies the
    # stored rotation before we touch the pixels, so Vision API always receives
    # an upright image regardless of how the phone was held.
    image = _load_upright(image_path)
    if image is None:
        raise FileNotFoundError(f"Could not load image: {image_path}")

    h0, w0 = image.shape[:2]
    logger.info("build_bank_from_image: loaded %dx%d (EXIF-corrected) from %s", w0, h0, image_path)

    max_side = 2000
    if max(h0, w0) > max_side:
        scale = max_side / max(h0, w0)
        image = cv2.resize(image, (int(w0 * scale), int(h0 * scale)), interpolation=cv2.INTER_AREA)
        logger.info("build_bank_from_image: resized to %dx%d", image.shape[1], image.shape[0])

    h, w = image.shape[:2]

    # ── Encode to JPEG for the API call ──────────────────────────────────────
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    b64 = base64.b64encode(buf.tobytes()).decode("utf-8")

    # ── Call Vision API ───────────────────────────────────────────────────────
    payload = {
        "requests": [{
            "image": {"content": b64},
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
        }]
    }

    logger.info("build_bank_from_image: sending to Vision API (%d KB)…", len(b64) // 1024)
    try:
        resp = requests.post(
            _VISION_URL,
            params={"key": _VISION_API_KEY},
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.error("build_bank_from_image: Vision API request failed: %s", exc)
        return {}

    data = resp.json()

    if "error" in data:
        logger.error("build_bank_from_image: API-level error: %s", data["error"])
        return {}

    responses = data.get("responses", [{}])
    if "error" in responses[0]:
        logger.error("build_bank_from_image: per-image error: %s", responses[0]["error"])
        return {}

    # ── Parse character-level symbols ─────────────────────────────────────────
    full_text = responses[0].get("fullTextAnnotation", {})
    if not full_text:
        # Log a snippet of the raw response so we can see what came back.
        raw_preview = str(responses[0])[:500]
        logger.warning(
            "build_bank_from_image: Vision API returned no fullTextAnnotation.\n"
            "Raw response preview: %s", raw_preview
        )
        return {}

    # Log the full detected text immediately — this is the fastest way to verify
    # that Vision API is reading the image correctly.
    detected_text = full_text.get("text", "").replace("\n", " ").strip()
    logger.info("build_bank_from_image: Vision API detected text: %r", detected_text[:200])

    if not detected_text:
        logger.warning(
            "build_bank_from_image: fullTextAnnotation exists but text is empty — "
            "image may be blank, blurry, or the lighting is insufficient."
        )
        return {}

    bank: dict[str, list[np.ndarray]] = {}
    total_symbols = 0
    skipped_non_hebrew = 0
    skipped_no_bbox = 0
    pad = 4  # pixels of padding around each crop

    for page in full_text.get("pages", []):
        for block in page.get("blocks", []):
            for paragraph in block.get("paragraphs", []):
                for word in paragraph.get("words", []):
                    for symbol in word.get("symbols", []):
                        total_symbols += 1
                        char = symbol.get("text", "").strip()

                        if not _is_hebrew(char):
                            skipped_non_hebrew += 1
                            continue

                        # Vision API may return either pixel-coordinate 'vertices'
                        # or float 'normalizedVertices' (0.0–1.0). Handle both.
                        pts = _parse_bbox(
                            symbol.get("boundingBox", {}), img_w=w, img_h=h
                        )
                        if not pts:
                            skipped_no_bbox += 1
                            continue

                        xs = [p[0] for p in pts]
                        ys = [p[1] for p in pts]
                        x1 = max(0,     min(xs) - pad)
                        y1 = max(0,     min(ys) - pad)
                        x2 = min(w - 1, max(xs) + pad)
                        y2 = min(h - 1, max(ys) + pad)

                        if x2 <= x1 or y2 <= y1:
                            skipped_no_bbox += 1
                            continue

                        crop = image[y1:y2, x1:x2].copy()
                        if crop.size == 0:
                            continue

                        bank.setdefault(char, []).append(crop)

    logger.info(
        "build_bank_from_image: %d symbols total → %d Hebrew kept, "
        "%d non-Hebrew, %d no-bbox → %d unique chars: %s",
        total_symbols,
        total_symbols - skipped_non_hebrew - skipped_no_bbox,
        skipped_non_hebrew,
        skipped_no_bbox,
        len(bank),
        sorted(bank.keys()),
    )

    # Save a debug image showing Vision API bounding boxes.
    _save_vision_debug(image, full_text)

    return bank


def _save_vision_debug(image: np.ndarray, full_text_annotation: dict) -> None:
    """Draw Vision API character bounding boxes on the original image and save."""
    try:
        debug = image.copy()
        for page in full_text_annotation.get("pages", []):
            for block in page.get("blocks", []):
                for paragraph in block.get("paragraphs", []):
                    for word in paragraph.get("words", []):
                        for symbol in word.get("symbols", []):
                            char = symbol.get("text", "").strip()
                            vertices = symbol.get("boundingBox", {}).get("vertices", [])
                            if len(vertices) < 4:
                                continue
                            pts = [(v.get("x", 0), v.get("y", 0)) for v in vertices]
                            color = (0, 200, 0) if _is_hebrew(char) else (100, 100, 100)
                            for i in range(4):
                                cv2.line(debug, pts[i], pts[(i + 1) % 4], color, 1)
        _save_debug("3_vision_boxes.png", debug)
    except Exception as exc:
        logger.warning("_save_vision_debug failed: %s", exc)


# ---------------------------------------------------------------------------
# Google Cloud Vision — single character recognition
# ---------------------------------------------------------------------------

def _image_to_base64(char_image: np.ndarray) -> str:
    """Encode a numpy image array as a base64 PNG string for the Vision API."""
    success, buffer = cv2.imencode(".png", char_image)
    if not success:
        raise ValueError("cv2.imencode failed — array may be empty or malformed")
    return base64.b64encode(buffer.tobytes()).decode("utf-8")


def _parse_vision_response(response: dict) -> str:
    """
    Extract the recognised character from a single Vision API response dict.

    The API returns textAnnotations as a list; element 0 is the full-page
    aggregate (the joined text), elements 1+ are individual word entities.
    For a single-character crop, element 0 contains the character we want.

    Confidence field behaviour
    --------------------------
    TEXT_DETECTION does not guarantee a per-annotation confidence score.
    When the field is absent we treat the result as accepted (the API chose
    to return it, which implies high internal confidence).  We only reject
    when the score is explicitly below the threshold.
    """
    annotations = response.get("textAnnotations", [])

    if not annotations:
        # API returned no text — genuinely unrecognised region.
        return _UNKNOWN

    # description may contain the detected character plus trailing whitespace
    # or newlines added by the API; strip and take the first character only.
    description = annotations[0].get("description", "").strip()
    if not description:
        return _UNKNOWN

    # Confidence is optional in TEXT_DETECTION responses.
    confidence = annotations[0].get("confidence")
    if confidence is not None and confidence < _CONFIDENCE_THRESHOLD:
        return _UNKNOWN

    # Return only the first code-point.  For Hebrew, a single glyph is always
    # one Unicode character, so this is always correct.
    return description[0]


def recognize_character(char_image_array: np.ndarray) -> str:
    """
    Send a single character image to Google Cloud Vision and return the
    detected Hebrew character.

    Parameters
    ----------
    char_image_array : np.ndarray
        Cropped character image (any channel count accepted).

    Returns
    -------
    str
        The single detected character, or ``"UNKNOWN"`` when:
          - the API is unreachable or returns an error
          - confidence is below 0.7
          - no text is detected in the image
    """
    if not _VISION_API_KEY:
        logger.error("GOOGLE_VISION_API_KEY is not set — cannot call Vision API")
        return _UNKNOWN

    try:
        b64 = _image_to_base64(char_image_array)
    except ValueError as exc:
        logger.error("Image encoding failed: %s", exc)
        return _UNKNOWN

    payload = {
        "requests": [
            {
                "image": {"content": b64},
                "features": [{"type": "TEXT_DETECTION", "maxResults": 1}],
                # Hint the API that content is Hebrew to improve accuracy.
                "imageContext": {"languageHints": ["he"]},
            }
        ]
    }

    try:
        resp = requests.post(
            _VISION_URL,
            params={"key": _VISION_API_KEY},
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.error("Vision API request failed: %s", exc)
        return _UNKNOWN

    data = resp.json()

    # Top-level API errors (wrong key, quota exceeded, etc.) appear as an
    # "error" key at the root of the response rather than inside "responses".
    if "error" in data:
        logger.error("Vision API error: %s", data["error"])
        return _UNKNOWN

    responses = data.get("responses", [{}])
    # A per-image error (e.g. image too small) surfaces inside responses[i].
    if "error" in responses[0]:
        logger.error("Vision API per-image error: %s", responses[0]["error"])
        return _UNKNOWN

    return _parse_vision_response(responses[0])


# ---------------------------------------------------------------------------
# Google Cloud Vision — batch recognition
# ---------------------------------------------------------------------------

def recognize_batch(char_images: list[np.ndarray]) -> list[str]:
    """
    Recognise multiple character images in a single API round-trip.

    The Vision API accepts up to 16 images per call; this function chunks
    larger batches automatically so callers don't need to worry about limits.

    Parameters
    ----------
    char_images : list[np.ndarray]
        Character crops in the same order they should appear in the output.

    Returns
    -------
    list[str]
        Recognised characters in the same order as the input.  Failed or
        low-confidence slots contain ``"UNKNOWN"``.
    """
    if not char_images:
        return []

    if not _VISION_API_KEY:
        logger.error(
            "recognize_batch: GOOGLE_VISION_API_KEY is empty — "
            "returning UNKNOWN for all %d images. "
            "Set the key in backend/.env and restart the server.",
            len(char_images),
        )
        return [_UNKNOWN] * len(char_images)

    logger.info("recognize_batch: sending %d images to Vision API", len(char_images))

    # Vision API hard limit per request.
    _CHUNK_SIZE = 16

    results: list[str] = []

    for chunk_start in range(0, len(char_images), _CHUNK_SIZE):
        chunk = char_images[chunk_start : chunk_start + _CHUNK_SIZE]

        # Build one request entry per image in this chunk.
        api_requests = []
        failed_indices: set[int] = set()

        for local_idx, img in enumerate(chunk):
            try:
                b64 = _image_to_base64(img)
                api_requests.append(
                    {
                        "image": {"content": b64},
                        "features": [{"type": "TEXT_DETECTION", "maxResults": 1}],
                        "imageContext": {"languageHints": ["he"]},
                    }
                )
            except ValueError as exc:
                # Keep a placeholder so the index mapping stays intact.
                logger.error("Encoding failed for image %d: %s", chunk_start + local_idx, exc)
                api_requests.append(None)
                failed_indices.add(local_idx)

        # Replace None placeholders with a dummy entry the API will accept
        # (a 1×1 white PNG) so response indices stay aligned.
        _DUMMY_B64 = _image_to_base64(np.ones((1, 1), dtype=np.uint8) * 255)
        sanitised = [
            r if r is not None
            else {
                "image": {"content": _DUMMY_B64},
                "features": [{"type": "TEXT_DETECTION", "maxResults": 1}],
            }
            for r in api_requests
        ]

        try:
            resp = requests.post(
                _VISION_URL,
                params={"key": _VISION_API_KEY},
                json={"requests": sanitised},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            logger.error("Vision API batch request failed: %s", exc)
            results.extend([_UNKNOWN] * len(chunk))
            continue

        if "error" in data:
            logger.error("Vision API error: %s", data["error"])
            results.extend([_UNKNOWN] * len(chunk))
            continue

        for local_idx, vision_response in enumerate(data.get("responses", [])):
            if local_idx in failed_indices:
                results.append(_UNKNOWN)
            elif "error" in vision_response:
                logger.error(
                    "Per-image error at index %d: %s",
                    chunk_start + local_idx,
                    vision_response["error"],
                )
                results.append(_UNKNOWN)
            else:
                results.append(_parse_vision_response(vision_response))

        # Guard against the API returning fewer responses than we sent.
        while len(results) < chunk_start + len(chunk):
            results.append(_UNKNOWN)

    recognized = [r for r in results if r != _UNKNOWN]
    logger.info(
        "recognize_batch: done — %d/%d recognized: %s",
        len(recognized), len(results), recognized,
    )
    return results


# ---------------------------------------------------------------------------
# Quick smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import glob
    import sys

    base_dir  = os.path.join(os.path.dirname(__file__), "..")
    test_dir  = os.path.join(base_dir, "test_images")

    candidates = (
        glob.glob(os.path.join(test_dir, "*.png"))
        + glob.glob(os.path.join(test_dir, "*.jpg"))
        + glob.glob(os.path.join(test_dir, "*.jpeg"))
    )

    if not candidates:
        print(f"No test images found in {test_dir}/")
        print("Create the folder and drop a handwriting photo in it, then re-run.")
        sys.exit(1)

    test_image_path = candidates[0]
    print(f"Processing: {test_image_path}")

    # --- preprocess ---
    binary = preprocess_image(test_image_path)
    out_pre = os.path.join(base_dir, "test_output_preprocessed.png")
    cv2.imwrite(out_pre, binary)
    print(f"Saved preprocessed image  → {out_pre}")

    # --- bounding boxes ---
    boxes = extract_bounding_boxes(binary)
    print(f"Detected {len(boxes)} character candidates")

    # --- visualisation ---
    annotated = draw_boxes(binary, boxes)
    out_viz = os.path.join(base_dir, "test_output_boxes.png")
    cv2.imwrite(out_viz, annotated)
    print(f"Saved box visualisation   → {out_viz}")

    # --- crop first 5 characters ---
    crops_dir = os.path.join(base_dir, "test_output_crops")
    os.makedirs(crops_dir, exist_ok=True)
    for box in boxes[:5]:
        rgba = crop_character(binary, box, padding=4)
        crop_path = os.path.join(crops_dir, f"char_{box['index']:03d}.png")
        cv2.imwrite(crop_path, rgba)
    print(f"Saved first 5 character crops → {crops_dir}/")
    print(f"Output shape: {binary.shape}, dtype: {binary.dtype}")
