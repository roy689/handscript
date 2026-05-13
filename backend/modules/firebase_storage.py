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
from datetime import datetime, timezone

import numpy as np
import firebase_admin
from firebase_admin import credentials, firestore, storage

logger = logging.getLogger(__name__)

_MAX_VARIANTS = 5


# ── Initialisation ────────────────────────────────────────────────────────────

def _init() -> None:
    if firebase_admin._apps:
        return

    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")
    if sa_json:
        try:
            sa_dict = json.loads(sa_json)
            cred = credentials.Certificate(sa_dict)
        except Exception as exc:
            logger.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var: %s", exc)
            raise
    elif os.path.exists("firebase_credentials.json"):
        cred = credentials.Certificate("firebase_credentials.json")
    elif os.path.exists("serviceAccountKey.json"):
        cred = credentials.Certificate("serviceAccountKey.json")
    else:
        cred = credentials.ApplicationDefault()

    bucket_name = os.getenv(
        "FIREBASE_STORAGE_BUCKET", "a-written-scanner.firebasestorage.app"
    )
    firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})
    logger.info("Firebase Admin initialised — bucket: %s", bucket_name)


_init()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _db():
    return firestore.client()


def _bucket():
    return storage.bucket()


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
    blob = _bucket().blob(blob_name)
    blob.upload_from_string(data, content_type=content_type)
    blob.make_public()
    return blob.public_url


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
