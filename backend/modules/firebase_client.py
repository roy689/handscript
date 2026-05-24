"""
Firebase / Firestore and Storage operations for the Handscript glyph bank.

DEPRECATED — this module is no longer imported by main.py.
Production uses `firebase_storage.py`; development uses `local_storage.py`.
Retained for reference until firebase_storage.py is fully validated.
"""

import logging
import os
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np
import firebase_admin
from firebase_admin import credentials, firestore, storage
from dotenv import load_dotenv

from modules.validator import validate_text

load_dotenv()

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Firestore schema
#
#   users/{user_id}/                      ← user document (future: profile)
#   users/{user_id}/chars/{char_doc_id}   ← one doc per character
#     character : str          the actual glyph, e.g. "א"
#     variants  : list[dict]  up to MAX_VARIANTS image records
#       each variant: { url, storage_path, added_at }
#     count     : int
#     updated_at: datetime
#
# Storage layout
#   users/{user_id}/chars/{char_doc_id}/variant_{n}.png
# ---------------------------------------------------------------------------

_MAX_VARIANTS = 5   # hard cap on stored samples per character

# ---------------------------------------------------------------------------
# Lazy Firebase initialisation
# ---------------------------------------------------------------------------

_db: Any = None       # google.cloud.firestore.Client
_bucket: Any = None   # google.cloud.storage.Bucket


def _init() -> None:
    """
    Initialise Firebase Admin SDK exactly once per process.

    Credential resolution order:
      1. FIREBASE_CREDENTIALS_JSON  — raw JSON string (used in Railway / CI)
      2. FIREBASE_CREDENTIALS_PATH  — path to a local serviceAccountKey.json file
    """
    global _db, _bucket

    if _db is not None:
        return   # already initialised

    bucket_name = os.getenv("FIREBASE_STORAGE_BUCKET", "")
    if not bucket_name:
        raise RuntimeError("FIREBASE_STORAGE_BUCKET is not set in environment")

    cred_json = os.getenv("FIREBASE_CREDENTIALS_JSON", "")
    cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "")

    if cred_json:
        import json as _json
        cred = credentials.Certificate(_json.loads(cred_json))
    elif cred_path:
        if not os.path.exists(cred_path):
            raise FileNotFoundError(f"Firebase credentials file not found: {cred_path}")
        cred = credentials.Certificate(cred_path)
    else:
        raise RuntimeError(
            "Firebase credentials not configured. "
            "Set FIREBASE_CREDENTIALS_JSON (Railway) or FIREBASE_CREDENTIALS_PATH (local)."
        )

    # Guard against double-init when FastAPI reloads the module in --reload mode
    try:
        app = firebase_admin.get_app()
    except ValueError:
        app = firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})

    _db     = firestore.client(app=app)
    _bucket = storage.bucket(app=app)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _char_doc_id(char: str) -> str:
    """
    Convert a Unicode character to a safe Firestore document ID.

    Firestore document IDs may not contain '/', and Hebrew characters are
    technically allowed but cause display issues in the Firebase console.
    Using the hex code-point avoids both problems and stays human-readable.

    Example: 'א' → 'U05D0', 'a' → 'U0061'
    """
    return f"U{ord(char):04X}"


def _chars_ref(user_id: str):
    """Return the `chars` subcollection reference for *user_id*."""
    return _db.collection("users").document(user_id).collection("chars")


def _encode_image(image: np.ndarray) -> bytes:
    """Encode a numpy image array (any channel count) to PNG bytes."""
    success, buf = cv2.imencode(".png", image)
    if not success:
        raise ValueError("cv2.imencode failed — image may be empty or malformed")
    return buf.tobytes()


def _upload_variant(user_id: str, char: str, index: int, image_bytes: bytes) -> dict:
    """
    Upload one character image PNG to Firebase Storage and return its record.

    The download token is set manually so the URL is permanent and usable
    by the mobile Firebase client SDK without signed-URL infrastructure.

    Returns
    -------
    dict  { storage_path, url, added_at }
    """
    doc_id       = _char_doc_id(char)
    blob_path    = f"users/{user_id}/chars/{doc_id}/variant_{index:02d}.png"
    download_token = str(uuid.uuid4())

    blob = _bucket.blob(blob_path)
    blob.upload_from_string(image_bytes, content_type="image/png")

    # Attach the Firebase download token so the mobile SDK can resolve it.
    # This must be patched after upload because upload_from_string does not
    # forward custom metadata.
    blob.metadata = {"firebaseStorageDownloadTokens": download_token}
    blob.patch()

    encoded_path = urllib.parse.quote(blob_path, safe="")
    download_url = (
        f"https://firebasestorage.googleapis.com/v0/b/{_bucket.name}"
        f"/o/{encoded_path}?alt=media&token={download_token}"
    )

    return {
        "storage_path": blob_path,
        "url":          download_url,
        "added_at":     datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def save_character_bank(user_id: str, bank: dict) -> bool:
    """
    Persist a character bank to Firestore and Firebase Storage.

    Parameters
    ----------
    user_id : str
    bank : dict
        Keys are characters (str).  Values may be:
        - np.ndarray  — a single glyph image (RGBA or grayscale)
        - list[np.ndarray] — multiple variant images for the same character
        - bytes — pre-encoded PNG bytes
        Characters with existing docs are overwritten.

    Returns
    -------
    bool  True on full success, False if any character failed (partial saves
          are committed so the bank is never left empty after a single error).
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    all_ok = True
    batch  = _db.batch()   # group Firestore writes for atomic commit

    for char, value in bank.items():
        doc_id  = _char_doc_id(char)
        doc_ref = _chars_ref(user_id).document(doc_id)

        # Normalise value to a list of image arrays
        if isinstance(value, np.ndarray):
            images = [value]
        elif isinstance(value, bytes):
            images = [value]
        elif isinstance(value, list):
            images = value[:_MAX_VARIANTS]
        else:
            logger.warning("Unsupported bank value type for '%s': %s", char, type(value))
            all_ok = False
            continue

        variants: list[dict] = []
        for idx, img in enumerate(images):
            try:
                raw = img if isinstance(img, bytes) else _encode_image(img)
                variant = _upload_variant(user_id, char, idx, raw)
                variants.append(variant)
            except Exception as exc:
                logger.error("Storage upload failed for '%s' variant %d: %s", char, idx, exc)
                all_ok = False

        if not variants:
            continue   # nothing to save for this character

        batch.set(
            doc_ref,
            {
                "character":  char,
                "variants":   variants,
                "count":      len(variants),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    try:
        batch.commit()
    except Exception as exc:
        logger.error("Firestore batch commit failed: %s", exc)
        return False

    logger.info("Saved bank for user '%s' — %d characters", user_id, len(bank))
    return all_ok


def load_character_bank(user_id: str) -> dict:
    """
    Load the user's character bank from Firestore.

    Returns
    -------
    dict
        Keys are characters (str); values are the Firestore doc dicts
        (contain variants, count, updated_at).
        Returns {} when the user has no bank or on any Firebase error.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return {}

    try:
        docs = _chars_ref(user_id).stream()
        bank = {}
        for doc in docs:
            data = doc.to_dict()
            char = data.get("character")
            if char:
                bank[char] = data
        return bank
    except Exception as exc:
        logger.error("Failed to load bank for user '%s': %s", user_id, exc)
        return {}


def get_missing_chars(user_id: str, text: str) -> list[str]:
    """
    Return the list of characters in *text* that are absent from the user's
    glyph bank.

    Delegates filtering to ``validate_text`` so the whitespace-stripping and
    coverage logic stays in one place.

    Parameters
    ----------
    user_id : str
    text : str
        Document text the user wants to render in their handwriting.

    Returns
    -------
    list[str]
        Missing characters in sorted order, or [] when all are covered.
        Returns all unique characters in *text* when Firebase is unavailable
        (conservative: treat an empty bank as fully missing).
    """
    bank = load_character_bank(user_id)
    result = validate_text(text, bank)
    return result["missing"]


def update_character_variants(
    user_id: str,
    char: str,
    new_images: list[np.ndarray],
) -> bool:
    """
    Add new handwriting samples for an existing character, up to MAX_VARIANTS.

    Existing variants are preserved; new images are appended until the cap is
    reached.  Images beyond the cap are silently dropped — the caller should
    use ``load_character_bank`` to check the current count before calling.

    Parameters
    ----------
    user_id : str
    char : str
        The character to update, e.g. "א".
    new_images : list[np.ndarray]
        One or more new glyph crops for this character.

    Returns
    -------
    bool  True on success, False on any Firebase or encoding error.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    doc_id  = _char_doc_id(char)
    doc_ref = _chars_ref(user_id).document(doc_id)

    try:
        snapshot = doc_ref.get()
        existing_variants: list[dict] = []
        if snapshot.exists:
            existing_variants = snapshot.to_dict().get("variants", [])
    except Exception as exc:
        logger.error("Failed to read existing variants for '%s': %s", char, exc)
        return False

    # How many slots remain before hitting the cap?
    slots_remaining = _MAX_VARIANTS - len(existing_variants)
    if slots_remaining <= 0:
        logger.info(
            "Character '%s' for user '%s' already has %d/%d variants — skipping",
            char, user_id, len(existing_variants), _MAX_VARIANTS,
        )
        return True   # not an error; cap is already met

    images_to_add = new_images[:slots_remaining]
    start_index   = len(existing_variants)
    new_variants  = []

    for offset, img in enumerate(images_to_add):
        try:
            raw     = _encode_image(img)
            variant = _upload_variant(user_id, char, start_index + offset, raw)
            new_variants.append(variant)
        except Exception as exc:
            logger.error(
                "Storage upload failed for '%s' new variant %d: %s",
                char, start_index + offset, exc,
            )
            # Continue — upload as many as possible

    if not new_variants:
        logger.error("All variant uploads failed for '%s'", char)
        return False

    merged = existing_variants + new_variants

    try:
        doc_ref.set(
            {
                "character":  char,
                "variants":   merged,
                "count":      len(merged),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            merge=False,   # full replace so count stays consistent
        )
    except Exception as exc:
        logger.error("Firestore write failed for '%s': %s", char, exc)
        return False

    logger.info(
        "Updated '%s' for user '%s': %d -> %d variants",
        char, user_id, len(existing_variants), len(merged),
    )
    return True


def check_is_pro_user(user_id: str) -> bool:
    """
    Return True if *user_id* has an active Pro subscription in Firestore.

    Firestore path: ``subscriptions/{user_id}``
    Required fields:
        status    : "active"
        expiresAt : Firestore Timestamp (optional; if absent, treat as no expiry)
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    try:
        snap = _db.collection("subscriptions").document(user_id).get()
        if not snap.exists:
            return False
        data = snap.to_dict()
        if data.get("status") != "active":
            return False
        expires_at = data.get("expiresAt")
        if expires_at is not None:
            # Firestore Timestamp has a .timestamp() method; datetime objects work too
            exp_ts = (
                expires_at.timestamp()
                if hasattr(expires_at, "timestamp")
                else expires_at
            )
            if exp_ts < datetime.now(timezone.utc).timestamp():
                return False
        return True
    except Exception as exc:
        logger.error("check_is_pro_user failed for '%s': %s", user_id, exc)
        return False


def save_output_document(
    user_id: str,
    image_array: np.ndarray,
    text: str,
) -> str | None:
    """
    Upload a rendered page to Firebase Storage and record metadata in Firestore.

    Storage path : ``users/{user_id}/output/{timestamp}.png``
    Firestore    : ``users/{user_id}/documents/{doc_id}``
                   fields: text, storage_path, url, created_at, char_count

    Returns
    -------
    str | None
        Public download URL on success, ``None`` on any failure.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return None

    try:
        image_bytes = _encode_image(image_array)
    except Exception as exc:
        logger.error("Failed to encode output image: %s", exc)
        return None

    timestamp  = int(datetime.now(timezone.utc).timestamp())
    filename   = f"{timestamp}.png"
    url        = upload_rendered_page(user_id, filename, image_bytes)
    if url is None:
        return None

    blob_path = f"users/{user_id}/output/{filename}"
    try:
        doc_ref = (
            _db.collection("users")
            .document(user_id)
            .collection("documents")
            .document()          # auto-ID
        )
        doc_ref.set({
            "text":         text,
            "char_count":   len(text),
            "storage_path": blob_path,
            "url":          url,
            "created_at":   datetime.now(timezone.utc).isoformat(),
        })
    except Exception as exc:
        logger.error("Firestore metadata write failed for output doc: %s", exc)
        # URL is already valid — return it even if metadata write fails

    return url


def increment_usage(user_id: str) -> None:
    """
    Increment the conversion counter for *user_id* for today (UTC).

    Firestore path: ``usage/{user_id}``
    Field         : ``YYYY-MM-DD`` → integer count (incremented atomically)
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        ref = _db.collection("usage").document(user_id)
        ref.set({today: firestore.Increment(1)}, merge=True)
    except Exception as exc:
        logger.error("increment_usage failed for user '%s': %s", user_id, exc)


def get_usage_count(user_id: str) -> int:
    """
    Return how many conversions *user_id* has performed today (UTC).

    Returns 0 on any Firebase error so callers can apply a safe default.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        snap = _db.collection("usage").document(user_id).get()
        if not snap.exists:
            return 0
        return int(snap.to_dict().get(today, 0))
    except Exception as exc:
        logger.error("get_usage_count failed for user '%s': %s", user_id, exc)
        return 0


def delete_character(user_id: str, char: str) -> bool:
    """
    Delete all saved variants for a single character from Firestore and Storage.

    Removes:
    - The Firestore document at ``users/{user_id}/chars/{doc_id}``
    - All Storage blobs under ``users/{user_id}/chars/{doc_id}/``
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    try:
        doc_id  = _char_doc_id(char)
        doc_ref = _chars_ref(user_id).document(doc_id)

        # Delete Storage blobs for this character
        prefix = f"users/{user_id}/chars/{doc_id}/"
        blobs  = list(_bucket.list_blobs(prefix=prefix))
        if blobs:
            _bucket.delete_blobs(blobs)
            logger.info("delete_character: removed %d blobs for '%s'", len(blobs), char)

        # Delete Firestore document
        doc_ref.delete()

        logger.info("delete_character: deleted '%s' for user '%s'", char, user_id)
        return True
    except Exception as exc:
        logger.error("delete_character failed for '%s'/'%s': %s", user_id, char, exc)
        return False


def delete_character_variant(user_id: str, char: str, index: int) -> bool:
    """
    Delete one variant by index and re-index the remaining variants.

    Steps:
    1. Load the current Firestore document for this character.
    2. Remove the variant at *index* from the variants list.
    3. Delete its Storage blob.
    4. Re-upload remaining variants under consecutive indices (variant_00, variant_01 …)
       so the Storage paths stay tightly packed and the Firestore list stays valid.
    5. Write the updated variants list back to Firestore.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    doc_id  = _char_doc_id(char)
    doc_ref = _chars_ref(user_id).document(doc_id)

    try:
        snapshot = doc_ref.get()
        if not snapshot.exists:
            logger.warning("delete_character_variant: no doc for '%s'/'%s'", user_id, char)
            return False

        variants: list[dict] = snapshot.to_dict().get("variants", [])
        if index < 0 or index >= len(variants):
            logger.warning(
                "delete_character_variant: index %d out of range (0–%d) for '%s'",
                index, len(variants) - 1, char,
            )
            return False

        # Delete the Storage blob for the removed variant
        removed = variants[index]
        removed_path = removed.get("storage_path", "")
        if removed_path:
            try:
                _bucket.blob(removed_path).delete()
                logger.info("delete_character_variant: deleted blob %s", removed_path)
            except Exception as exc:
                logger.warning("delete_character_variant: blob delete failed: %s", exc)

        # Build the new ordered list (drop the removed index)
        remaining = [v for i, v in enumerate(variants) if i != index]

        # Re-number existing blobs so indices stay consecutive.
        # We download each remaining blob, re-upload at the new index path, delete the old one.
        reindexed: list[dict] = []
        for new_idx, variant in enumerate(remaining):
            old_path = variant.get("storage_path", "")
            expected_path = f"users/{user_id}/chars/{doc_id}/variant_{new_idx:02d}.png"

            if old_path and old_path != expected_path:
                try:
                    old_blob = _bucket.blob(old_path)
                    img_bytes = old_blob.download_as_bytes()
                    new_record = _upload_variant(user_id, char, new_idx, img_bytes)
                    old_blob.delete()
                    reindexed.append(new_record)
                except Exception as exc:
                    logger.error(
                        "delete_character_variant: re-index blob %d failed: %s", new_idx, exc,
                    )
                    reindexed.append(variant)   # keep old record as fallback
            else:
                reindexed.append(variant)

        doc_ref.set(
            {
                "character":  char,
                "variants":   reindexed,
                "count":      len(reindexed),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            merge=False,
        )

        logger.info(
            "delete_character_variant: '%s'[%d] deleted, %d variants remain",
            char, index, len(reindexed),
        )
        return True

    except Exception as exc:
        logger.error(
            "delete_character_variant failed for '%s'/'%s'[%d]: %s",
            user_id, char, index, exc,
        )
        return False


def clear_character_bank(user_id: str) -> bool:
    """
    Delete all character data for *user_id* from Firestore and Storage.

    Removes every document in ``users/{user_id}/chars/`` and every blob
    under the ``users/{user_id}/chars/`` Storage prefix.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    try:
        # Delete Firestore char docs
        docs = list(_chars_ref(user_id).stream())
        if docs:
            batch = _db.batch()
            for doc in docs:
                batch.delete(doc.reference)
            batch.commit()

        # Delete Storage blobs
        prefix = f"users/{user_id}/chars/"
        blobs  = list(_bucket.list_blobs(prefix=prefix))
        if blobs:
            _bucket.delete_blobs(blobs)

        logger.info("Cleared character bank for user '%s'", user_id)
        return True
    except Exception as exc:
        logger.error("clear_character_bank failed for '%s': %s", user_id, exc)
        return False


def delete_user_data(user_id: str) -> bool:
    """
    Delete all Firestore and Storage data for *user_id*.

    Removes:
    - Character bank (chars subcollection + Storage blobs)
    - Output documents subcollection + Storage blobs
    - ``usage/{user_id}`` document
    - ``subscriptions/{user_id}`` document
    - ``users/{user_id}`` document itself
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return False

    try:
        # 1. Character bank
        clear_character_bank(user_id)

        # 2. Output documents subcollection
        docs_ref = (
            _db.collection("users").document(user_id).collection("documents")
        )
        output_docs = list(docs_ref.stream())
        if output_docs:
            batch = _db.batch()
            for doc in output_docs:
                batch.delete(doc.reference)
            batch.commit()

        # 3. Output Storage blobs
        output_blobs = list(_bucket.list_blobs(prefix=f"users/{user_id}/output/"))
        if output_blobs:
            _bucket.delete_blobs(output_blobs)

        # 4. Top-level Firestore documents
        _db.collection("usage").document(user_id).delete()
        _db.collection("subscriptions").document(user_id).delete()
        _db.collection("users").document(user_id).delete()

        logger.info("Deleted all data for user '%s'", user_id)
        return True
    except Exception as exc:
        logger.error("delete_user_data failed for '%s': %s", user_id, exc)
        return False


def upload_rendered_page(
    user_id: str,
    filename: str,
    image_bytes: bytes,
) -> str | None:
    """
    Upload a rendered page PNG to Firebase Storage and return its download URL.

    The file is stored at ``users/{user_id}/output/{filename}`` in the bucket.
    A permanent Firebase download token is attached so the mobile client can
    fetch the image without signed-URL infrastructure.

    Parameters
    ----------
    user_id : str
    filename : str
        Destination filename, e.g. ``"page_01.png"``.
    image_bytes : bytes
        Raw PNG bytes to upload.

    Returns
    -------
    str | None
        Permanent download URL on success, ``None`` on any failure.
    """
    try:
        _init()
    except (RuntimeError, FileNotFoundError) as exc:
        logger.error("Firebase init failed: %s", exc)
        return None

    try:
        blob_path      = f"users/{user_id}/output/{filename}"
        download_token = str(uuid.uuid4())

        blob = _bucket.blob(blob_path)
        blob.upload_from_string(image_bytes, content_type="image/png")

        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        blob.patch()

        encoded_path = urllib.parse.quote(blob_path, safe="")
        download_url = (
            f"https://firebasestorage.googleapis.com/v0/b/{_bucket.name}"
            f"/o/{encoded_path}?alt=media&token={download_token}"
        )

        logger.info("Uploaded rendered page for user '%s': %s", user_id, blob_path)
        return download_url

    except Exception as exc:
        logger.error(
            "Failed to upload rendered page '%s' for user '%s': %s",
            filename, user_id, exc,
        )
        return None
