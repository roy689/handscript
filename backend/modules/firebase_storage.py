"""
Firebase Cloud Storage + Firestore storage layer.
Replaces local_storage.py — same public interface, data stored in the cloud.

Firebase Storage layout:
  banks/{user_id}/chars/{char_hex}/variant_{n}.png
  renders/{user_id}/{filename}.png

Firestore layout:
  character_banks/{user_id}/chars/{char_hex}
    → { character, count, variants: [{url, storage_path, added_at}], updated_at }
  usage/{user_id}/days/{YYYY-MM-DD} → { count }
  subscriptions/{user_id}          → { status, expiresAt }
"""

import io
import json
import logging
import os
import urllib.parse
import uuid
from datetime import datetime, timezone

import numpy as np
import firebase_admin
from firebase_admin import credentials, firestore, storage

logger = logging.getLogger(__name__)

_MAX_VARIANTS = 5


# ── Lazy initialisation (Fix #4) ─────────────────────────────────────────────

_initialised   = False
_db_cache      = None    # google.cloud.firestore.Client
_bucket_cache  = None    # google.cloud.storage.Bucket


def _ensure_init() -> None:
    """
    Idempotent Firebase Admin SDK initialisation.

    Runs on first call rather than at import time so that a missing/invalid
    FIREBASE_SERVICE_ACCOUNT does not crash the entire server at startup —
    instead, individual requests will fail with a clear error message.

    Credential resolution order (most-secure → fallback):
      1. FIREBASE_SERVICE_ACCOUNT   — raw JSON string (Railway secret)
      2. FIREBASE_CREDENTIALS_JSON  — alias supported for legacy configs
      3. firebase_credentials.json  — file in cwd
      4. serviceAccountKey.json     — file in cwd
      5. GOOGLE_APPLICATION_CREDENTIALS — gcloud ADC
    """
    global _initialised
    if _initialised:
        return

    # If another module already initialised the SDK, just mark and exit
    if firebase_admin._apps:
        _initialised = True
        return

    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT") or os.getenv("FIREBASE_CREDENTIALS_JSON")
    if sa_json:
        try:
            cred = credentials.Certificate(json.loads(sa_json))
        except Exception as exc:
            logger.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var: %s", exc)
            raise RuntimeError(f"Invalid FIREBASE_SERVICE_ACCOUNT JSON: {exc}") from exc
    elif os.path.exists("firebase_credentials.json"):
        cred = credentials.Certificate("firebase_credentials.json")
    elif os.path.exists("serviceAccountKey.json"):
        cred = credentials.Certificate("serviceAccountKey.json")
    else:
        try:
            cred = credentials.ApplicationDefault()
        except Exception as exc:
            raise RuntimeError(
                "No Firebase credentials available. Set FIREBASE_SERVICE_ACCOUNT "
                "(JSON contents) in Railway, or GOOGLE_APPLICATION_CREDENTIALS to a "
                "service account file path."
            ) from exc

    bucket_name = os.getenv(
        "FIREBASE_STORAGE_BUCKET", "a-written-scanner.firebasestorage.app"
    )
    firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})
    logger.info("Firebase Admin initialised — bucket: %s", bucket_name)
    _initialised = True


# ── Cached client accessors (Fix #6 — avoid connection storm) ────────────────

def _db():
    """Return a cached Firestore client (one per process)."""
    global _db_cache
    _ensure_init()
    if _db_cache is None:
        _db_cache = firestore.client()
    return _db_cache


def _bucket():
    """Return a cached Storage bucket (one per process)."""
    global _bucket_cache
    _ensure_init()
    if _bucket_cache is None:
        _bucket_cache = storage.bucket()
    return _bucket_cache


def _char_hex(char: str) -> str:
    return "".join(f"U{ord(c):04X}" for c in char)


def _blob_name(user_id: str, char: str, idx: int) -> str:
    return f"banks/{user_id}/chars/{_char_hex(char)}/variant_{idx}.png"


def _to_png_bytes(img) -> bytes:
    if isinstance(img, (bytes, bytearray)):
        return bytes(img)
    if isinstance(img, np.ndarray):
        from PIL import Image as PILImage
        if img.ndim == 3 and img.shape[2] == 4:
            pil = PILImage.fromarray(img, mode="RGBA")
        elif img.ndim == 3 and img.shape[2] == 3:
            pil = PILImage.fromarray(img, mode="RGB")
        else:
            pil = PILImage.fromarray(img)
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        return buf.getvalue()
    raise ValueError(f"Unsupported image type: {type(img)}")


def _upload_blob(blob_name: str, data: bytes, content_type: str = "image/png") -> str:
    """
    Upload bytes to Cloud Storage and return a tokenized download URL.

    Uses Firebase's `firebaseStorageDownloadTokens` metadata field so the
    resulting URL contains a UUID-v4 token that must match for the file to be
    served.  Knowing the storage path alone is no longer enough — the token is
    cryptographically unguessable (122 bits of entropy).

    Replaces the previous `blob.make_public()` which made every uploaded file
    world-readable by URL.  That leaked user signatures to anyone who could
    guess a Firebase uid.

    Metadata is set BEFORE upload (single API call) instead of using a
    follow-up `blob.patch()` — saves a round-trip per upload.
    """
    token = str(uuid.uuid4())
    blob = _bucket().blob(blob_name)
    blob.metadata = {"firebaseStorageDownloadTokens": token}
    blob.upload_from_string(data, content_type=content_type)
    encoded_path = urllib.parse.quote(blob_name, safe="")
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{_bucket().name}"
        f"/o/{encoded_path}?alt=media&token={token}"
    )


# ── Public interface (mirrors local_storage.py) ───────────────────────────────

def configure(server_base_url: str) -> None:
    """No-op: URLs come from Firebase Storage, not the local server."""
    pass


def save_character_bank(user_id: str, bank: dict) -> bool:
    db = _db()
    all_ok = True

    for char, value in bank.items():
        try:
            if isinstance(value, np.ndarray):
                images = [value]
            elif isinstance(value, list):
                images = value[:_MAX_VARIANTS]
            elif isinstance(value, (bytes, bytearray)):
                images = [value]
            else:
                logger.warning("Unsupported value type for '%s': %s", char, type(value))
                all_ok = False
                continue

            char_ref = (
                db.collection("character_banks")
                .document(user_id)
                .collection("chars")
                .document(_char_hex(char))
            )
            doc = char_ref.get()
            existing_variants = doc.to_dict().get("variants", []) if doc.exists else []
            new_variants = list(existing_variants)

            for img in images:
                if len(new_variants) >= _MAX_VARIANTS:
                    break
                if isinstance(img, tuple):
                    img = img[0]   # discard svg_text
                try:
                    png_bytes = _to_png_bytes(img)
                    idx = len(new_variants)
                    bname = _blob_name(user_id, char, idx)
                    url = _upload_blob(bname, png_bytes)
                    new_variants.append({
                        "url": url,
                        "storage_path": bname,
                        "added_at": datetime.now(timezone.utc).isoformat(),
                    })
                except Exception as exc:
                    logger.error("Failed to upload variant for char %r: %s", char, exc)

            char_ref.set({
                "character": char,
                "variants": new_variants,
                "count": len(new_variants),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            logger.info(
                "Saved %d variants for char '%s' (user=%s)", len(new_variants), char, user_id
            )
        except Exception as exc:
            logger.error("Failed to save char '%s': %s", char, exc)
            all_ok = False

    return all_ok


def load_character_bank(user_id: str) -> dict:
    db = _db()
    bank: dict = {}
    try:
        chars_ref = (
            db.collection("character_banks")
            .document(user_id)
            .collection("chars")
        )
        for doc in chars_ref.stream():
            data = doc.to_dict()
            char = data.get("character")
            if char:
                bank[char] = data
    except Exception as exc:
        logger.error("load_character_bank failed for '%s': %s", user_id, exc)
    return bank


def upload_rendered_page(user_id: str, filename: str, image_bytes: bytes) -> str:
    bname = f"renders/{user_id}/{filename}"
    return _upload_blob(bname, image_bytes)


def upload_rendered_page_bytes(user_id: str, filename: str, image_bytes: bytes) -> str:
    return upload_rendered_page(user_id, filename, image_bytes)


def delete_character_variant(user_id: str, char: str, index: int) -> bool:
    db = _db()
    try:
        char_ref = (
            db.collection("character_banks")
            .document(user_id)
            .collection("chars")
            .document(_char_hex(char))
        )
        doc = char_ref.get()
        if not doc.exists:
            return False

        data = doc.to_dict()
        variants = data.get("variants", [])
        if index < 0 or index >= len(variants):
            return False

        bname = variants[index].get("storage_path", "")
        if bname:
            try:
                _bucket().blob(bname).delete()
            except Exception:
                pass

        variants.pop(index)

        if not variants:
            char_ref.delete()
            return True

        char_ref.set({
            **data,
            "variants": variants,
            "count": len(variants),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception as exc:
        logger.error("delete_character_variant failed: %s", exc)
        return False


def delete_character(user_id: str, char: str) -> bool:
    db = _db()
    try:
        char_ref = (
            db.collection("character_banks")
            .document(user_id)
            .collection("chars")
            .document(_char_hex(char))
        )
        doc = char_ref.get()
        if doc.exists:
            for v in doc.to_dict().get("variants", []):
                bname = v.get("storage_path", "")
                if bname:
                    try:
                        _bucket().blob(bname).delete()
                    except Exception:
                        pass
            char_ref.delete()
        return True
    except Exception as exc:
        logger.error("delete_character failed: %s", exc)
        return False


def delete_user_data(user_id: str) -> bool:
    db = _db()
    try:
        chars_ref = (
            db.collection("character_banks")
            .document(user_id)
            .collection("chars")
        )
        for doc in chars_ref.stream():
            for v in doc.to_dict().get("variants", []):
                bname = v.get("storage_path", "")
                if bname:
                    try:
                        _bucket().blob(bname).delete()
                    except Exception:
                        pass
            doc.reference.delete()
        for blob in _bucket().list_blobs(prefix=f"renders/{user_id}/"):
            try:
                blob.delete()
            except Exception:
                pass
        return True
    except Exception as exc:
        logger.error("delete_user_data failed: %s", exc)
        return False


def clear_character_bank(user_id: str) -> bool:
    return delete_user_data(user_id)


def increment_usage(user_id: str) -> None:
    db = _db()
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        ref = (
            db.collection("usage")
            .document(user_id)
            .collection("days")
            .document(today)
        )
        ref.set({"count": firestore.Increment(1)}, merge=True)
    except Exception as exc:
        logger.error("increment_usage failed: %s", exc)


def check_is_pro_user(user_id: str) -> bool:
    db = _db()
    try:
        doc = db.collection("subscriptions").document(user_id).get()
        if doc.exists:
            data = doc.to_dict()
            if data.get("status") == "active":
                exp = data.get("expiresAt")
                if exp is None:
                    return True
                exp_dt = exp.ToDatetime(tzinfo=timezone.utc) if hasattr(exp, "ToDatetime") else exp
                if exp_dt > datetime.now(timezone.utc):
                    return True
    except Exception as exc:
        logger.error("check_is_pro_user failed: %s", exc)
    return False


def get_usage_count(user_id: str) -> int:
    db = _db()
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        doc = (
            db.collection("usage")
            .document(user_id)
            .collection("days")
            .document(today)
            .get()
        )
        if doc.exists:
            return doc.to_dict().get("count", 0)
    except Exception as exc:
        logger.error("get_usage_count failed: %s", exc)
    return 0
