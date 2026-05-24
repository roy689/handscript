"""
Firebase ID-token verification for the Handscript API.

Every endpoint calls `require_auth` as a FastAPI dependency.
It extracts the Bearer token from the Authorization header,
verifies it with the Firebase Admin SDK, and returns the
verified uid — which endpoints then compare against the
user_id in the request body.

If SKIP_AUTH=true in the environment (dev mode only), verification
is bypassed and the uid is read from X-Dev-User-Id header (default: "dev-user").
"""

import logging
import os

from fastapi import Header, HTTPException, status

logger = logging.getLogger(__name__)

_SKIP_AUTH = os.getenv("SKIP_AUTH", "false").lower() == "true"
if _SKIP_AUTH and os.getenv("APP_ENV") == "production":
    raise RuntimeError("SKIP_AUTH cannot be enabled in production — remove it from Railway env vars")

# ── Firebase Admin initialisation ───────────────────────────────────────────

_firebase_app = None


def _resolve_key_path() -> str | None:
    """Find serviceAccountKey.json, preferring out-of-repo locations."""
    candidates = [
        os.getenv("FIREBASE_KEY_PATH"),
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
        os.path.join(os.getenv("LOCALAPPDATA", ""), "handscript", "serviceAccountKey.json"),
        "./serviceAccountKey.json",
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None


def _get_firebase_app():
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app
    try:
        import firebase_admin
        from firebase_admin import credentials

        key_path = _resolve_key_path()
        if not key_path:
            if os.getenv("APP_ENV") == "production":
                raise RuntimeError(
                    "serviceAccountKey.json not found in production. "
                    "Set FIREBASE_KEY_PATH or GOOGLE_APPLICATION_CREDENTIALS env var, "
                    "or place the key at %LOCALAPPDATA%/handscript/serviceAccountKey.json. "
                    "Without this, all auth requests will fail."
                )
            logger.warning(
                "auth: serviceAccountKey.json not found — "
                "token verification will be disabled. Set SKIP_AUTH=true for dev.",
            )
            return None

        cred = credentials.Certificate(key_path)
        _firebase_app = firebase_admin.initialize_app(cred)
        logger.info("auth: Firebase Admin SDK initialised from %s", key_path)
        return _firebase_app
    except ImportError:
        logger.warning("auth: firebase_admin not installed — run `pip install firebase-admin`")
        return None
    except Exception as exc:
        logger.error("auth: failed to initialise Firebase Admin: %s", exc, exc_info=True)
        if os.getenv("APP_ENV") == "production":
            raise
        return None


# Attempt initialisation at import time (non-fatal if it fails)
_get_firebase_app()


# ── Dependency ───────────────────────────────────────────────────────────────

async def require_auth(
    authorization: str | None = Header(default=None),
    x_dev_user_id: str | None = Header(default=None),
) -> str:
    """
    FastAPI dependency. Returns the verified Firebase uid.

    Raises HTTP 401 if the token is missing or invalid.
    """
    if _SKIP_AUTH:
        uid = x_dev_user_id or "dev-user"
        logger.debug("auth: SKIP_AUTH mode — uid=%s", uid)
        return uid

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="חסר Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.removeprefix("Bearer ").strip()

    try:
        import firebase_admin.auth as fb_auth
        decoded = fb_auth.verify_id_token(token)
        uid = decoded["uid"]
        logger.debug("auth: verified uid=%s", uid)
        return uid
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="שירות האימות אינו זמין",
        )
    except Exception as exc:
        logger.warning("auth: token verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="טוקן לא תקין או פג תוקף",
            headers={"WWW-Authenticate": "Bearer"},
        )


def assert_same_user(verified_uid: str, requested_uid: str) -> None:
    """Raise 403 if the verified uid doesn't match the requested user_id."""
    if verified_uid != requested_uid:
        logger.warning(
            "auth: uid mismatch — verified=%s requested=%s",
            verified_uid, requested_uid,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="אין הרשאה לגשת לנתונים של משתמש אחר",
        )
