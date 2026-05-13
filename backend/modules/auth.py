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

# ── Firebase Admin initialisation ───────────────────────────────────────────

_firebase_app = None

def _get_firebase_app():
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app
    try:
        import firebase_admin
        from firebase_admin import credentials

        key_path = os.getenv("FIREBASE_KEY_PATH", "./serviceAccountKey.json")
        if not os.path.exists(key_path):
            logger.warning(
                "auth: serviceAccountKey.json not found at %s — "
                "token verification will be disabled. Set SKIP_AUTH=true for dev.",
                key_path,
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
        logger.error("auth: failed to initialise Firebase Admin: %s", exc)
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
        # firebase_admin not installed — fail open only if running locally
        if os.getenv("APP_ENV", "production") == "development":
            logger.warning("auth: firebase_admin unavailable, failing open in dev mode")
            return token  # trust the raw token in dev
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
