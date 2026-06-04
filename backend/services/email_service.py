"""
Custom transactional email sender for HandScript.

Firebase's console blocks editing the built-in auth email templates for this
project, so instead of relying on Firebase to send verification / password-reset
emails, the backend:

  1. Generates the action link with the Firebase Admin SDK
     (generate_email_verification_link / generate_password_reset_link) — this
     returns the link WITHOUT Firebase sending any email.
  2. Sends our own fully-designed HTML email through SMTP (Gmail).

SMTP configuration is read from environment variables (never hard-coded):

  SMTP_HOST       e.g. smtp.gmail.com
  SMTP_PORT       e.g. 587
  SMTP_USERNAME   the full Gmail address
  SMTP_PASSWORD   the 16-char Gmail App Password (NOT the account password)
  SMTP_FROM       the From address (defaults to SMTP_USERNAME)
  SMTP_FROM_NAME  display name (default "HandScript")
  SMTP_SECURITY   "starttls" (port 587, default) or "ssl" (port 465)

If SMTP is not fully configured, is_configured() returns False so callers can
fall back to Firebase's default delivery.
"""

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _cfg() -> dict:
    return {
        "host":      os.getenv("SMTP_HOST", "").strip(),
        "port":      int(os.getenv("SMTP_PORT", "587") or "587"),
        "username":  os.getenv("SMTP_USERNAME", "").strip(),
        "password":  os.getenv("SMTP_PASSWORD", ""),
        "from_addr": (os.getenv("SMTP_FROM", "") or os.getenv("SMTP_USERNAME", "")).strip(),
        "from_name": os.getenv("SMTP_FROM_NAME", "HandScript").strip(),
        "security":  os.getenv("SMTP_SECURITY", "starttls").strip().lower(),
    }


def is_configured() -> bool:
    """True only when the minimum SMTP settings are present."""
    c = _cfg()
    return bool(c["host"] and c["username"] and c["password"] and c["from_addr"])


# ---------------------------------------------------------------------------
# Low-level SMTP send (blocking — call via asyncio.to_thread)
# ---------------------------------------------------------------------------

def send_html(to_addr: str, subject: str, html: str) -> bool:
    """
    Send a single HTML email. Returns True on success, False on any failure.
    Never raises — email delivery must not crash the auth flow.
    """
    if not is_configured():
        logger.warning("email_service: SMTP not configured — cannot send")
        return False

    c = _cfg()
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = formataddr((c["from_name"], c["from_addr"]))
    msg["To"]      = to_addr
    # Plain-text fallback for clients that don't render HTML.
    msg.set_content(
        "המייל הזה מכיל תוכן HTML. אם אינך רואה אותו, פתח אותו בלקוח דואר שתומך ב-HTML."
    )
    msg.add_alternative(html, subtype="html")

    try:
        if c["security"] == "ssl":
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(c["host"], c["port"], context=context, timeout=15) as s:
                s.login(c["username"], c["password"])
                s.send_message(msg)
        else:  # starttls (default)
            with smtplib.SMTP(c["host"], c["port"], timeout=15) as s:
                s.ehlo()
                s.starttls(context=ssl.create_default_context())
                s.ehlo()
                s.login(c["username"], c["password"])
                s.send_message(msg)
        logger.info("email_service: sent %r to recipient", subject)
        return True
    except (smtplib.SMTPException, OSError) as exc:
        logger.error("email_service: send failed: %s", exc)
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
