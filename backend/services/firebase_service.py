"""
Firestore / Storage proxy helpers.

Exposes subscription and usage data to authenticated mobile clients
without granting them direct Firestore access.
All heavy lifting is delegated to the active firebase_client module
(local_storage in dev, firebase_storage in production).
"""

import logging
import sys

logger = logging.getLogger(__name__)


def _client():
    """Return the active firebase_client module (set by main.py at startup)."""
    from services import config as _cfg  # noqa: PLC0415
    return _cfg.firebase_client


def get_subscription_status(user_id: str) -> dict:
    """Return whether the user has an active Pro subscription."""
    try:
        is_pro = _client().check_is_pro_user(user_id)
        return {"isPro": is_pro}
    except Exception as exc:
        logger.warning("get_subscription_status failed for uid=%s: %s", user_id, exc)
        return {"isPro": False}


def get_usage(user_id: str) -> dict:
    """Return today's usage count for the user."""
    try:
        count = _client().get_usage_count(user_id)
        return {"count": count}
    except Exception as exc:
        logger.warning("get_usage failed for uid=%s: %s", user_id, exc)
        return {"count": 0}
