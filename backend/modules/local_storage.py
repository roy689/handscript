"""
Local-disk replacement for firebase_client.

Images are stored under:
  backend/data/banks/{user_id}/chars/{char_hex}/variant_{n}.png
Metadata is stored as JSON alongside each character folder.
Rendered pages are stored under:
  backend/static/sample_pages/{filename}
"""

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_DATA_DIR   = Path(__file__).parent.parent / "data" / "banks"
_STATIC_DIR = Path(__file__).parent.parent / "static" / "sample_pages"

_MAX_VARIANTS = 5
_SERVER_BASE   = ""   # set at startup via configure()

# Per-(user_id, char) locks to prevent concurrent write races (B3)
_char_locks: dict[tuple, threading.Lock] = {}
_locks_guard = threading.Lock()

def _get_char_lock(user_id: str, char: str) -> threading.Lock:
    key = (user_id, char)
    with _locks_guard:
        return _char_locks.setdefault(key, threading.Lock())


def configure(server_base_url: str) -> None:
    """Call once at startup with the server's base URL, e.g. 'http://172.20.10.9:8000'."""
    global _SERVER_BASE
    _SERVER_BASE = server_base_url.rstrip("/")


_SAFE_UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

def _safe_uid(user_id: str) -> str:
    """Validate user_id to prevent path traversal attacks."""
    if not _SAFE_UID_RE.fullmatch(user_id):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return user_id


def _char_dir(user_id: str, char: str) -> Path:
    user_id = _safe_uid(user_id)
    char_hex = f"U{ord(char):04X}"
    return _DATA_DIR / user_id / "chars" / char_hex


def _meta_path(user_id: str, char: str) -> Path:
    return _char_dir(user_id, char) / "meta.json"


def _variant_url(user_id: str, char: str, idx: int) -> str:
    char_hex = f"U{ord(char):04X}"
    path = f"/banks/{user_id}/chars/{char_hex}/variant_{idx}.png"
    return f"{_SERVER_BASE}{path}"


def save_character_bank(user_id: str, bank: dict) -> bool:
    all_ok = True
    for char, value in bank.items():
        with _get_char_lock(user_id, char):
            try:
                d = _char_dir(user_id, char)
                d.mkdir(parents=True, exist_ok=True)

                if isinstance(value, np.ndarray):
                    images = [value]
                elif isinstance(value, list):
                    images = value[:_MAX_VARIANTS]
                elif isinstance(value, bytes):
                    images = [value]
                else:
                    logger.warning("Unsupported value type for '%s': %s", char, type(value))
                    all_ok = False
                    continue

                # Load existing metadata so we append rather than overwrite
                meta_file = _meta_path(user_id, char)
                if meta_file.exists():
                    try:
                        existing = json.loads(meta_file.read_text(encoding="utf-8"))
                        existing_variants = existing.get("variants", [])
                    except (json.JSONDecodeError, IOError):
                        logger.error("Corrupted metadata for %s/%s — resetting", user_id, char)
                        existing_variants = []
                else:
                    existing_variants = []

                new_variants = list(existing_variants)
                for idx, img in enumerate(images):
                    file_idx = len(new_variants)
                    if file_idx >= _MAX_VARIANTS:
                        break
                    variant_path = d / f"variant_{file_idx}.png"

                    # img may be a plain ndarray or a (ndarray, svg_text) tuple
                    svg_text = None
                    if isinstance(img, tuple):
                        img, svg_text = img

                    if isinstance(img, bytes):
                        variant_path.write_bytes(img)
                    elif isinstance(img, np.ndarray):
                        # img is RGBA (R,G,B,A); cv2.imwrite expects BGRA for PNG with alpha
                        if img.ndim == 3 and img.shape[2] == 4:
                            bgra = cv2.cvtColor(img, cv2.COLOR_RGBA2BGRA)
                        else:
                            bgra = img
                        cv2.imwrite(str(variant_path), bgra)
                    else:
                        logger.warning("Skipping unknown image type: %s", type(img))
                        continue

                    entry: dict = {
                        "url":          _variant_url(user_id, char, file_idx),
                        "storage_path": str(variant_path),
                        "added_at":     datetime.now(timezone.utc).isoformat(),
                    }
                    if svg_text:
                        # Store SVG alongside PNG for future font export
                        svg_path = d / f"variant_{file_idx}.svg"
                        svg_path.write_text(svg_text, encoding="utf-8")
                        entry["svg_path"] = str(svg_path)
                    new_variants.append(entry)

                meta = {
                    "character":  char,
                    "variants":   new_variants,
                    "count":      len(new_variants),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                meta_tmp = meta_file.with_suffix(".json.tmp")
                meta_tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(meta_tmp, meta_file)  # atomic rename (B4)
                logger.info("Saved %d variants for char '%s'", len(new_variants), char)

            except Exception as exc:
                logger.error("Failed to save char '%s': %s", char, exc)
                all_ok = False

    return all_ok


def load_character_bank(user_id: str) -> dict:
    user_dir = _DATA_DIR / user_id / "chars"
    if not user_dir.exists():
        return {}

    bank = {}
    for meta_file in user_dir.glob("*/meta.json"):
        try:
            data = json.loads(meta_file.read_text(encoding="utf-8"))
            char = data.get("character")
            if char:
                # Always rebuild URLs from storage_path so a changed server IP
                # never causes stale/unreachable image URLs.
                for v in data.get("variants", []):
                    sp = v.get("storage_path", "")
                    if sp:
                        try:
                            rel = Path(sp).relative_to(_DATA_DIR)
                            v["url"] = f"{_SERVER_BASE}/banks/{rel.as_posix()}?v={int(Path(sp).stat().st_mtime)}"
                        except (ValueError, OSError):
                            pass
                bank[char] = data
        except Exception as exc:
            logger.error("Failed to read meta %s: %s", meta_file, exc)

    return bank


_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}\.(png|jpg|jpeg|pdf)$")


def upload_rendered_page(user_id: str, filename: str, image_bytes: bytes) -> str:
    if not _SAFE_FILENAME_RE.fullmatch(filename):
        raise ValueError(f"invalid filename: {filename!r}")
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)
    dest = _STATIC_DIR / filename
    dest.write_bytes(image_bytes)
    return f"{_SERVER_BASE}/static/sample_pages/{filename}"


def increment_usage(user_id: str) -> None:
    pass

def check_is_pro_user(user_id: str) -> bool:
    return True  # treat all users as pro in local dev

def get_usage_count(user_id: str) -> int:
    return 0

def get_bank_version(user_id: str) -> int:
    # Local dev has no version tracking — 0 mirrors a legacy/unversioned bank.
    return 0


# ── Render cache stubs (REWRITE_PLAN §3.5) ───────────────────────────────────
# In local dev, "cache" is just a sub-directory under the static folder.
# The interface mirrors firebase_storage.py so main.py can call either.

_CACHE_DIR = Path(__file__).parent.parent / "static" / "render_cache"


def _cache_prefix(uid: str, render_hash: str) -> Path:
    _safe_uid(uid)
    p = _CACHE_DIR / uid / render_hash
    p.mkdir(parents=True, exist_ok=True)
    return p


def store_render_cache(
    uid: str,
    render_hash: str,
    preview_clean: list,
    preview_photo: list,
    final_clean:   list,
    final_photo:   list,
    manifest:      dict,
) -> dict:
    """Write rendered pages to the local cache directory."""
    d = _cache_prefix(uid, render_hash)
    clean_urls: list[str] = []
    photo_urls: list[str] = []

    for i, data in enumerate(preview_clean):
        p = d / f"preview_clean_{i:02d}.webp"
        p.write_bytes(data)
        clean_urls.append(f"{_SERVER_BASE}/static/render_cache/{uid}/{render_hash}/preview_clean_{i:02d}.webp")

    for i, data in enumerate(preview_photo):
        p = d / f"preview_photo_{i:02d}.webp"
        p.write_bytes(data)
        photo_urls.append(f"{_SERVER_BASE}/static/render_cache/{uid}/{render_hash}/preview_photo_{i:02d}.webp")

    for i, data in enumerate(final_clean):
        (d / f"final_clean_{i:02d}.png").write_bytes(data)

    for i, data in enumerate(final_photo):
        (d / f"final_photo_{i:02d}.png").write_bytes(data)

    full_manifest = {
        **manifest,
        "n_pages": len(preview_clean),
        "uid":     uid,
    }
    (d / "manifest.json").write_text(
        json.dumps(full_manifest, ensure_ascii=False), encoding="utf-8"
    )
    logger.info("local store_render_cache: %d pages, hash=%s", len(preview_clean), render_hash[:8])
    return {"clean_urls": clean_urls, "photo_urls": photo_urls}


def check_render_cache(uid: str, render_hash: str) -> "dict | None":
    """Return URLs if cache exists on disk, else None."""
    d = _CACHE_DIR / uid / render_hash
    manifest_path = d / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        n_pages = manifest.get("n_pages", 0)
        if n_pages == 0:
            return None

        clean_urls: list[str] = []
        photo_urls: list[str] = []
        base = f"{_SERVER_BASE}/static/render_cache/{uid}/{render_hash}"

        for i in range(n_pages):
            for kind, out in [("clean", clean_urls), ("photo", photo_urls)]:
                p = d / f"preview_{kind}_{i:02d}.webp"
                if not p.exists():
                    return None
                out.append(f"{base}/preview_{kind}_{i:02d}.webp")

        logger.info("local cache HIT: hash=%s uid=%s", render_hash[:8], uid)
        return {"clean_urls": clean_urls, "photo_urls": photo_urls, "manifest": manifest}
    except Exception as exc:
        logger.warning("check_render_cache local: %s", exc)
        return None


def get_render_manifest(uid: str, render_hash: str) -> "dict | None":
    """Read manifest from local cache."""
    p = _CACHE_DIR / uid / render_hash / "manifest.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def promote_from_cache(uid: str, render_hash: str, doc_id: str) -> "dict | None":
    """
    Copy cached final PNGs to a permanent local path.
    In local dev, 'permanent' just means a different sub-directory.
    """
    import shutil
    src_dir  = _CACHE_DIR / uid / render_hash
    dest_dir = _STATIC_DIR.parent / "documents" / uid / doc_id
    dest_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = src_dir / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        n_pages  = manifest.get("n_pages", 0)
        if n_pages == 0:
            return None

        clean_urls: list[str] = []
        photo_urls: list[str] = []

        for i in range(n_pages):
            for kind, out in [("clean", clean_urls), ("photo", photo_urls)]:
                src  = src_dir  / f"final_{kind}_{i:02d}.png"
                dest = dest_dir / f"page_{kind}_{i:02d}.png"
                if not src.exists():
                    logger.warning("promote_from_cache local: missing %s", src)
                    return None
                shutil.copy2(src, dest)
                out.append(f"{_SERVER_BASE}/documents/{uid}/{doc_id}/page_{kind}_{i:02d}.png")

        logger.info("local promote_from_cache: %d pages → %s", n_pages, dest_dir)
        return {"clean_urls": clean_urls, "photo_urls": photo_urls}
    except Exception as exc:
        logger.error("promote_from_cache local: %s", exc)
        return None

def upload_rendered_page_bytes(user_id: str, filename: str, image_bytes: bytes) -> str:
    return upload_rendered_page(user_id, filename, image_bytes)


def delete_character_variant(user_id: str, char: str, index: int) -> bool:
    """Delete one variant by index and re-index the remaining ones."""
    import shutil
    d = _char_dir(user_id, char)
    meta_file = _meta_path(user_id, char)
    try:
        if not meta_file.exists():
            return False
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        variants = meta.get("variants", [])
        if index < 0 or index >= len(variants):
            return False

        # Remove the image file for the deleted variant
        old_path = Path(variants[index].get("storage_path", ""))
        if old_path.exists():
            old_path.unlink(missing_ok=True)
        svg_path = Path(variants[index].get("svg_path", ""))
        if svg_path.exists():
            svg_path.unlink(missing_ok=True)

        # Remove from list
        variants.pop(index)

        # Re-index: rename remaining files to fill the gap
        for new_idx, v in enumerate(variants):
            old_p = Path(v["storage_path"])
            new_p = d / f"variant_{new_idx}.png"
            if old_p != new_p and old_p.exists():
                old_p.rename(new_p)
            v["storage_path"] = str(new_p)
            v["url"] = _variant_url(user_id, char, new_idx)
            if "svg_path" in v:
                old_svg = Path(v["svg_path"])
                new_svg = d / f"variant_{new_idx}.svg"
                if old_svg != new_svg and old_svg.exists():
                    old_svg.rename(new_svg)
                v["svg_path"] = str(new_svg)

        if not variants:
            # No variants left — remove the whole character folder
            shutil.rmtree(d, ignore_errors=True)
            return True

        meta["variants"]   = variants
        meta["count"]      = len(variants)
        meta_tmp = meta_file.with_suffix(".json.tmp")
        meta_tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(meta_tmp, meta_file)  # atomic rename (B4)
        return True
    except Exception as exc:
        logger.error("delete_character_variant failed for '%s'/'%s'[%d]: %s", user_id, char, index, exc)
        return False


def delete_character(user_id: str, char: str) -> bool:
    """Delete all saved variants for a single character."""
    import shutil
    d = _char_dir(user_id, char)
    try:
        if d.exists():
            shutil.rmtree(d)
        return True
    except Exception as exc:
        logger.error("delete_character failed for '%s'/'%s': %s", user_id, char, exc)
        return False


def delete_user_data(user_id: str) -> bool:
    """Delete all data for a user (alias of clear_character_bank for full deletion)."""
    return clear_character_bank(user_id)


def clear_character_bank(user_id: str) -> bool:
    import shutil
    user_id = _safe_uid(user_id)
    user_dir = (_DATA_DIR / user_id).resolve()
    # Prevent path traversal: ensure resolved path is inside _DATA_DIR
    if not str(user_dir).startswith(str(_DATA_DIR.resolve())):
        logger.error("clear_character_bank: path traversal attempt for '%s'", user_id)
        return False
    try:
        if user_dir.exists():
            shutil.rmtree(user_dir)
        return True
    except Exception as exc:
        logger.error("clear_character_bank failed for '%s': %s", user_id, exc)
        return False
