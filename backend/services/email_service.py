"""
Custom transactional email sender for HandScript.

Firebase's console blocks editing the built-in auth email templates for this
project, so instead of relying on Firebase to send verification / password-reset
emails, the backend:

  1. Generates the action link with the Firebase Admin SDK
     (generate_email_verification_link / generate_password_reset_link) — this
     returns the link WITHOUT Firebase sending any email.
  2. Sends our own fully-designed HTML email through SMTP (Gmail).

Delivery uses the Brevo (Sendinblue) transactional email HTTP API over HTTPS
(port 443) instead of raw SMTP. This is required because Railway blocks outbound
SMTP ports (25/465/587) — direct SMTP fails with "Network is unreachable".

Configuration is read from environment variables (never hard-coded):

  BREVO_API_KEY       the Brevo API key (SMTP & API → API Keys)
  BREVO_SENDER_EMAIL  verified sender address (falls back to SMTP_FROM / SMTP_USERNAME)
  EMAIL_FROM_NAME     display name (falls back to SMTP_FROM_NAME, default "HandScript")

The sender address must be verified in Brevo (Senders & IP → Senders).
If not fully configured, is_configured() returns False so callers can fall back
to Firebase's default delivery.
"""

import logging
import os

import requests

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _cfg() -> dict:
    return {
        "api_key":   os.getenv("BREVO_API_KEY", "").strip(),
        "from_addr": (
            os.getenv("BREVO_SENDER_EMAIL", "")
            or os.getenv("SMTP_FROM", "")
            or os.getenv("SMTP_USERNAME", "")
        ).strip(),
        "from_name": (
            os.getenv("EMAIL_FROM_NAME", "")
            or os.getenv("SMTP_FROM_NAME", "")
            or "HandScript"
        ).strip(),
    }


def is_configured() -> bool:
    """True only when the Brevo API key and a sender address are present."""
    c = _cfg()
    return bool(c["api_key"] and c["from_addr"])


# ---------------------------------------------------------------------------
# Low-level send via Brevo HTTP API (blocking — call via asyncio.to_thread)
# ---------------------------------------------------------------------------

def send_html(to_addr: str, subject: str, html: str) -> bool:
    """
    Send a single HTML email through the Brevo HTTP API (HTTPS, port 443).
    Returns True on success, False on any failure. Never raises — email
    delivery must not crash the auth flow.
    """
    if not is_configured():
        logger.warning("email_service: Brevo not configured — cannot send")
        return False

    c = _cfg()
    payload = {
        "sender": {"name": c["from_name"], "email": c["from_addr"]},
        "to":     [{"email": to_addr}],
        "subject": subject,
        "htmlContent": html,
    }
    headers = {
        "api-key":      c["api_key"],
        "Content-Type": "application/json",
        "accept":       "application/json",
    }

    try:
        r = requests.post(BREVO_API_URL, json=payload, headers=headers, timeout=15)
        if r.status_code in (200, 201, 202):
            logger.info("email_service: sent %r via Brevo", subject)
            return True
        logger.error(
            "email_service: Brevo send failed: HTTP %s %s",
            r.status_code, r.text[:300],
        )
        return False
    except requests.RequestException as exc:
        logger.error("email_service: Brevo request error: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Public helpers — verification + password reset
# ---------------------------------------------------------------------------

VERIFY_SUBJECT = "✍️ אמת את כתובת המייל שלך — HandScript"
RESET_SUBJECT  = "🔐 איפוס סיסמה — HandScript"


def send_verification_email(to_addr: str, link: str) -> bool:
    html = _VERIFY_HTML.replace("%LINK%", link)
    return send_html(to_addr, VERIFY_SUBJECT, html)


def send_password_reset_email(to_addr: str, link: str) -> bool:
    html = _RESET_HTML.replace("%LINK%", link)
    return send_html(to_addr, RESET_SUBJECT, html)


# ---------------------------------------------------------------------------
# HTML templates (designed for HandScript, RTL, dark theme).
# %LINK% is substituted with the Firebase action link at send time.
# ---------------------------------------------------------------------------

_VERIFY_HTML = """<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>אימות מייל — HandScript</title>
</head>
<body style="margin:0;padding:0;background-color:#0D1117;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0D1117;">
<tr>
<td align="center" style="padding:48px 20px;">

  <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- לוגו -->
    <tr>
      <td align="center" style="padding-bottom:36px;">
        <div style="font-size:56px;line-height:1;">✍️</div>
        <div style="margin-top:10px;font-size:26px;font-weight:800;color:#E8C98A;letter-spacing:-0.5px;">HandScript</div>
        <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.38);letter-spacing:0.3px;">כתב היד הדיגיטלי שלך</div>
      </td>
    </tr>

    <!-- כרטיס ראשי -->
    <tr>
      <td style="background-color:#161B22;border-radius:18px;border:1px solid rgba(255,255,255,0.09);padding:44px 40px;">

        <div style="font-size:22px;font-weight:800;color:#FFFFFF;margin-bottom:16px;line-height:1.3;">
          אמת את כתובת המייל שלך 📬
        </div>

        <div style="font-size:15px;color:rgba(255,255,255,0.62);line-height:1.8;margin-bottom:32px;">
          שלום!<br><br>
          תודה שנרשמת ל-HandScript.<br>
          לחץ על הכפתור למטה כדי לאמת את כתובת המייל שלך ולהתחיל ליצור את הפונט האישי שלך.
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <a href="%LINK%"
                 style="display:inline-block;background-color:#E8C98A;color:#111111;text-decoration:none;font-size:16px;font-weight:800;padding:18px 48px;border-radius:14px;letter-spacing:0.3px;">
                ✅ &nbsp; אמת את המייל שלך
              </a>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
          <tr>
            <td style="height:1px;background-color:rgba(255,255,255,0.08);"></td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
          <tr>
            <td style="background-color:rgba(232,201,138,0.07);border-radius:10px;border:1px solid rgba(232,201,138,0.15);padding:12px 18px;">
              <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.7;text-align:center;">
                📁 &nbsp; לא קיבלת את המייל? בדוק את תיבת הספאם שלך
              </div>
            </td>
          </tr>
        </table>

        <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.7;text-align:center;">
          הכפתור לא עובד? העתק והדבק את הכתובת הבאה בדפדפן שלך:<br>
          <span style="color:rgba(232,201,138,0.55);word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- הערת אבטחה -->
    <tr>
      <td style="padding:20px 4px 0;text-align:center;">
        <div style="font-size:12px;color:rgba(255,255,255,0.22);line-height:1.7;">
          אם לא נרשמת ל-HandScript, פשוט התעלם מהודעה זו.<br>
          הקישור יפוג תוך 24 שעות.
        </div>
      </td>
    </tr>

    <!-- פוטר -->
    <tr>
      <td style="padding-top:32px;text-align:center;">
        <div style="font-size:11px;color:rgba(255,255,255,0.15);">
          © 2025 HandScript · כל הזכויות שמורות
        </div>
      </td>
    </tr>

  </table>

</td>
</tr>
</table>

</body>
</html>"""


_RESET_HTML = """<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>איפוס סיסמה — HandScript</title>
</head>
<body style="margin:0;padding:0;background-color:#0A1628;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0A1628;">
<tr>
<td align="center" style="padding:48px 20px;">

  <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- לוגו -->
    <tr>
      <td align="center" style="padding-bottom:36px;">
        <div style="font-size:56px;line-height:1;">✍️</div>
        <div style="margin-top:10px;font-size:26px;font-weight:800;color:#7EC8E3;letter-spacing:-0.5px;">HandScript</div>
        <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.38);letter-spacing:0.3px;">כתב היד הדיגיטלי שלך</div>
      </td>
    </tr>

    <!-- כרטיס ראשי -->
    <tr>
      <td style="background-color:#0F1F3A;border-radius:18px;border:1px solid rgba(126,200,227,0.15);padding:44px 40px;">

        <div style="text-align:center;margin-bottom:20px;">
          <div style="display:inline-block;background-color:rgba(126,200,227,0.1);border:1.5px solid rgba(126,200,227,0.25);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:34px;text-align:center;">
            🔐
          </div>
        </div>

        <div style="font-size:22px;font-weight:800;color:#FFFFFF;margin-bottom:16px;line-height:1.3;text-align:center;">
          בקשת איפוס סיסמה
        </div>

        <div style="font-size:15px;color:rgba(255,255,255,0.62);line-height:1.8;margin-bottom:32px;text-align:center;">
          קיבלנו בקשה לאיפוס הסיסמה של חשבון ה-HandScript שלך.<br>
          לחץ על הכפתור למטה כדי לבחור סיסמה חדשה.
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <a href="%LINK%"
                 style="display:inline-block;background-color:#7EC8E3;color:#0A1628;text-decoration:none;font-size:16px;font-weight:800;padding:18px 48px;border-radius:14px;letter-spacing:0.3px;">
                🔑 &nbsp; אפס את הסיסמה
              </a>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
          <tr>
            <td style="height:1px;background-color:rgba(126,200,227,0.12);"></td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr>
            <td style="background-color:rgba(126,200,227,0.07);border-radius:10px;border:1px solid rgba(126,200,227,0.15);padding:12px 18px;">
              <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.7;text-align:center;">
                📁 &nbsp; לא קיבלת את המייל? בדוק את תיבת הספאם שלך
              </div>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
          <tr>
            <td style="background-color:rgba(126,200,227,0.07);border-radius:10px;border:1px solid rgba(126,200,227,0.15);padding:14px 18px;">
              <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:1.7;text-align:center;">
                ⚠️ &nbsp; אם לא ביקשת לאפס את הסיסמה שלך,<br>
                התעלם מהודעה זו. הסיסמה שלך לא תשתנה.
              </div>
            </td>
          </tr>
        </table>

        <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.7;text-align:center;">
          הכפתור לא עובד? העתק והדבק את הכתובת הבאה בדפדפן שלך:<br>
          <span style="color:rgba(126,200,227,0.5);word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- הערת תוקף -->
    <tr>
      <td style="padding:20px 4px 0;text-align:center;">
        <div style="font-size:12px;color:rgba(255,255,255,0.22);line-height:1.7;">
          הקישור לאיפוס הסיסמה יפוג תוך שעה אחת.
        </div>
      </td>
    </tr>

    <!-- פוטר -->
    <tr>
      <td style="padding-top:32px;text-align:center;">
        <div style="font-size:11px;color:rgba(255,255,255,0.15);">
          © 2025 HandScript · כל הזכויות שמורות
        </div>
      </td>
    </tr>

  </table>

</td>
</tr>
</table>

</body>
</html>"""
