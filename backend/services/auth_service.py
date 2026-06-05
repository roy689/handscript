"""
Firebase Auth REST proxy.

Moves FIREBASE_WEB_API_KEY from the mobile bundle to the backend environment.
The mobile app never sees Firebase credentials — it only talks to these endpoints.

Firebase REST docs:
  https://firebase.google.com/docs/reference/rest/auth
"""

import asyncio
import logging
import os

import httpx

from services import email_service

logger = logging.getLogger(__name__)

FIREBASE_WEB_API_KEY: str = os.getenv("FIREBASE_WEB_API_KEY", "")

# Fail at startup if the key is missing — prevents silent auth failures later.
if not FIREBASE_WEB_API_KEY:
    logger.warning(
        "FIREBASE_WEB_API_KEY is not set. "
        "Auth proxy endpoints will return 503 until it is configured."
    )

_ID_TOOLKIT = "https://identitytoolkit.googleapis.com/v1/accounts"
_TOKEN_EP   = "https://securetoken.googleapis.com/v1/token"

# Map Firebase error codes → Hebrew user-facing messages
_ERROR_MAP: dict[str, str] = {
    "EMAIL_NOT_FOUND":             "כתובת האימייל אינה קיימת במערכת.",
    "INVALID_PASSWORD":            "סיסמה שגויה.",
    "INVALID_EMAIL":               "כתובת האימייל אינה תקינה.",
    "INVALID_LOGIN_CREDENTIALS":   "פרטי ההתחברות שגויים.",
    "USER_DISABLED":               "החשבון הושהה. פנה לתמיכה.",
    "EMAIL_EXISTS":                "כתובת האימייל כבר רשומה.",
    "WEAK_PASSWORD":               "הסיסמה חלשה מדי — לפחות 6 תווים.",
    "TOO_MANY_ATTEMPTS_TRY_LATER": "יותר מדי ניסיונות. נסה שוב מאוחר יותר.",
    "INVALID_REFRESH_TOKEN":       "הסשן פג תוקף. אנא התחבר מחדש.",
    "TOKEN_EXPIRED":               "הסשן פג תוקף. אנא התחבר מחדש.",
    "USER_NOT_FOUND":              "משתמש לא נמצא.",
}


def _map_error(firebase_code: str) -> str:
    """Translate Firebase error code to Hebrew; strip optional trailing detail."""
    key = firebase_code.split(" :")[0].strip()
    return _ERROR_MAP.get(key, "שגיאת אימות. נסה שוב.")


def _check_api_key() -> None:
    if not FIREBASE_WEB_API_KEY:
        raise RuntimeError(
            "FIREBASE_WEB_API_KEY is not set. "
            "Add it to the Railway environment variables."
        )


def _ensure_admin() -> None:
    """
    Make sure the Firebase Admin SDK is initialised before using fb_auth.

    The active storage module (firebase_storage in prod, local_storage in dev)
    initialises the SDK lazily — only on the first Firestore/Storage call. The
    custom-email flow calls Admin SDK auth functions (generate_*_link,
    verify_id_token) which need an initialised app, and these can run before any
    storage op (e.g. a password-reset request). So we trigger the active
    client's init explicitly here. Idempotent and safe to call repeatedly.
    """
    import firebase_admin
    if firebase_admin._apps:
        return
    try:
        from services import config as _svc_config
        client = getattr(_svc_config, "firebase_client", None)
        init = getattr(client, "_ensure_init", None) or getattr(client, "_init", None)
        if init:
            init()
    except Exception as exc:
        logger.warning("_ensure_admin: could not initialise Firebase Admin: %s", exc)


async def sign_in(email: str, password: str) -> dict:
    """Authenticate with email + password. Returns idToken, refreshToken, etc."""
    email = email.strip().lower()
    _check_api_key()
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{_ID_TOOLKIT}:signInWithPassword?key={FIREBASE_WEB_API_KEY}",
            json={"email": email, "password": password, "returnSecureToken": True},
        )
    if r.status_code != 200:
        code = r.json().get("error", {}).get("message", "LOGIN_FAILED")
        logger.warning("sign_in failed for %s: %s", email, code)
        raise ValueError(_map_error(code))
    d = r.json()
    return {
        "idToken":      d["idToken"],
        "refreshToken": d["refreshToken"],
        "expiresIn":    d["expiresIn"],
        "uid":          d["localId"],
        "email":        d["email"],
    }


async def sign_up(email: str, password: str) -> dict:
    """Create a new Firebase Auth account. Returns idToken, refreshToken, etc."""
    email = email.strip().lower()
    _check_api_key()

    # Pre-check: reject if this email is already registered (case-insensitive).
    # Firebase itself may allow duplicate emails if the project setting is off,
    # so we enforce uniqueness here via the Admin SDK before touching the REST API.
    try:
        import firebase_admin.auth as fb_auth
        try:
            fb_auth.get_user_by_email(email)
            # If we get here the user already exists — raise EMAIL_EXISTS
            raise ValueError(_map_error("EMAIL_EXISTS"))
        except fb_auth.UserNotFoundError:
            pass  # email is free — proceed
    except ValueError:
        raise  # re-raise EMAIL_EXISTS
    except Exception as exc:
        # Admin SDK unavailable or mis-configured — log and continue; Firebase
        # itself will still reject truly duplicate emails when enabled.
        logger.warning("sign_up: could not pre-check email existence: %s", exc)

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{_ID_TOOLKIT}:signUp?key={FIREBASE_WEB_API_KEY}",
            json={"email": email, "password": password, "returnSecureToken": True},
        )
    if r.status_code != 200:
        code = r.json().get("error", {}).get("message", "SIGNUP_FAILED")
        logger.warning("sign_up failed for %s: %s", email, code)
        raise ValueError(_map_error(code))
    d = r.json()
    return {
        "idToken":      d["idToken"],
        "refreshToken": d["refreshToken"],
        "expiresIn":    d["expiresIn"],
        "uid":          d["localId"],
        "email":        d["email"],
    }


async def sign_in_with_idp(
    *,
    provider_id: str,
    id_token: str | None = None,
    access_token: str | None = None,
) -> dict:
    """
    Federated sign-in via Firebase's signInWithIdp REST endpoint.

    `provider_id` must be one of Firebase's documented values:
        google.com, apple.com, facebook.com, ...

    For Google, pass the OAuth `id_token` from the native Google SDK.
    For Apple, pass the `identityToken` returned by Apple's authentication
    framework as `id_token`. The nonce-based binding is enforced client-side
    by the native SDK; Firebase verifies the token signature against the
    Apple/Google JWKS.

    Returns the same shape as sign_in / sign_up so the rest of the auth
    pipeline (token storage, refresh, etc.) doesn't need a special case.
    """
    _check_api_key()

    if not id_token and not access_token:
        raise ValueError("sign_in_with_idp requires id_token or access_token")

    parts = [f"providerId={provider_id}"]
    if id_token:
        parts.append(f"id_token={id_token}")
    if access_token:
        parts.append(f"access_token={access_token}")
    post_body = "&".join(parts)

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{_ID_TOOLKIT}:signInWithIdp?key={FIREBASE_WEB_API_KEY}",
            json={
                "postBody":          post_body,
                "requestUri":        "http://localhost",
                "returnSecureToken": True,
                "returnIdpCredential": False,
            },
        )

    if r.status_code != 200:
        code = r.json().get("error", {}).get("message", "FEDERATED_LOGIN_FAILED")
        logger.warning("sign_in_with_idp failed (%s): %s", provider_id, code)
        raise ValueError(_map_error(code))

    d = r.json()
    return {
        "idToken":      d["idToken"],
        "refreshToken": d["refreshToken"],
        "expiresIn":    d["expiresIn"],
        "uid":          d["localId"],
        "email":        d.get("email", "").strip().lower(),
    }


async def refresh_id_token(refresh_token: str) -> dict:
    """Exchange a refresh token for a new ID token."""
    _check_api_key()
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{_TOKEN_EP}?key={FIREBASE_WEB_API_KEY}",
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        )
    if r.status_code != 200:
        code = r.json().get("error", {}).get("message", "REFRESH_FAILED")
        raise ValueError(_map_error(code))
    d = r.json()
    return {
        "idToken":      d["id_token"],
        "refreshToken": d["refresh_token"],
        "expiresIn":    d["expires_in"],
    }


async def _firebase_send_oob(payload: dict) -> bool:
    """
    Fallback: ask Firebase to generate AND send the email itself
    (used only when custom SMTP is not configured). Never raises.
    """
    _check_api_key()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{_ID_TOOLKIT}:sendOobCode?key={FIREBASE_WEB_API_KEY}",
                json=payload,
            )
        if r.status_code != 200:
            logger.warning("sendOobCode: Firebase returned %d: %s", r.status_code, r.text[:200])
            return False
        return True
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        logger.warning("sendOobCode request failed: %s", exc)
        return False


async def send_password_reset(email: str) -> bool:
    """
    Send a password-reset email with the custom HandScript HTML template.

    Flow: generate the reset link via the Admin SDK (no email is sent by
    Firebase), then deliver our own designed email through SMTP. Falls back to
    Firebase's default delivery when SMTP is not configured.

    Returns True on success, False on failure. Never raises — and never reveals
    whether the email exists (the caller always returns ok=True to the client).
    """
    email = email.strip().lower()

    # No custom SMTP → let Firebase generate and send its default template.
    if not email_service.is_configured():
        return await _firebase_send_oob({"requestType": "PASSWORD_RESET", "email": email})

    try:
        _ensure_admin()
        import firebase_admin.auth as fb_auth
        try:
            link = await asyncio.to_thread(fb_auth.generate_password_reset_link, email)
        except fb_auth.UserNotFoundError:
            # Email not registered — silently succeed to prevent enumeration.
            logger.info("password_reset: no account for that address — skipping send")
            return True
    except Exception as exc:
        logger.error("password_reset: link generation failed: %s", exc)
        return False

    return await asyncio.to_thread(email_service.send_password_reset_email, email, link)


async def send_email_verification(id_token: str) -> bool:
    """
    Send an email-verification link with the custom HandScript HTML template.

    Flow: resolve the user's email from the id_token via the Admin SDK, generate
    the verification link (no email is sent by Firebase), then deliver our own
    designed email through SMTP. Falls back to Firebase's default delivery when
    SMTP is not configured.

    Returns True on success, False on error. Never raises — a failed send must
    not abort the signup flow.
    """
    # No custom SMTP → let Firebase generate and send its default template.
    if not email_service.is_configured():
        return await _firebase_send_oob({"requestType": "VERIFY_EMAIL", "idToken": id_token})

    try:
        _ensure_admin()
        import firebase_admin.auth as fb_auth
        decoded = await asyncio.to_thread(fb_auth.verify_id_token, id_token)
        user    = await asyncio.to_thread(fb_auth.get_user, decoded["uid"])
        email   = (user.email or "").strip().lower()
        if not email:
            logger.warning("send_email_verification: user has no email on record")
            return False
        link = await asyncio.to_thread(fb_auth.generate_email_verification_link, email)
    except Exception as exc:
        logger.error("send_email_verification: link generation failed: %s", exc)
        return False

    return await asyncio.to_thread(email_service.send_verification_email, email, link)


def check_email_verified(uid: str) -> bool:
    """
    Return True if the Firebase Auth user has verified their email address.

    Uses the Admin SDK so the result is always fresh (not cached from an
    ID token that was issued before verification happened).

    Raises ValueError with a Hebrew message if the user is not found or the
    Admin SDK is unavailable.
    """
    try:
        import firebase_admin.auth as fb_auth
        user = fb_auth.get_user(uid)
        return bool(user.email_verified)
    except Exception as exc:
        logger.warning("check_email_verified failed for uid=%s: %s", uid, exc)
        raise ValueError("לא ניתן לבדוק סטטוס אימות. נסה שוב.") from exc


async def delete_account(uid: str) -> None:
    """Delete a Firebase Auth account by uid using the Admin SDK."""
    try:
        import firebase_admin.auth as fb_auth
        fb_auth.delete_user(uid)
        logger.info("Firebase Auth account deleted for uid=%s", uid)
    except Exception as exc:
        logger.error("Failed to delete Firebase Auth account uid=%s: %s", uid, exc)
        raise
