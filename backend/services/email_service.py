"""
Custom transactional email sender for HandScript.

Firebase's console blocks editing the built-in auth email templates for this
project, so instead of relying on Firebase to send verification / password-reset
emails, the backend:

  1. Generates the action link with the Firebase Admin SDK
     (generate_email_verification_link / generate_password_reset_link) — this
     returns the link WITHOUT Firebase sending any email.
  2. Sends our own fully-designed HTML email.

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

Email design follows the app's "Ink & Parchment" design system (theme.ts):
warm parchment surfaces, fountain-pen Prussian-blue accent, warm-ink browns,
the Heebo typeface, and artisanal rounded corners.
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

VERIFY_SUBJECT = "אימות כתובת המייל שלך — HandScript"
RESET_SUBJECT  = "איפוס הסיסמה שלך — HandScript"


def send_verification_email(to_addr: str, link: str) -> bool:
    html = _VERIFY_HTML.replace("%LINK%", link)
    return send_html(to_addr, VERIFY_SUBJECT, html)


def send_password_reset_email(to_addr: str, link: str) -> bool:
    html = _RESET_HTML.replace("%LINK%", link)
    return send_html(to_addr, RESET_SUBJECT, html)


# ---------------------------------------------------------------------------
# HTML templates — "Ink & Parchment" design system, Hebrew RTL.
# Palette: parchment #F4EFE6 · cream card #FDFAF4 · Prussian-blue accent
# #1E3A5F · warm ink #1E1812/#6B5744/#9E8A78 · linen border #DEDAD1.
# %LINK% is substituted with the Firebase action link at send time.
# ---------------------------------------------------------------------------

_VERIFY_HTML = """<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>אימות כתובת המייל — HandScript</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap');
  body { margin:0; padding:0; }
  a { text-decoration:none; }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F4EFE6;font-family:'Heebo','Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4EFE6;">
<tr>
<td align="center" style="padding:40px 20px;">

  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- ── סמל המותג ──────────────────────────────────────────────── -->
    <tr>
      <td align="center" style="padding-bottom:28px;">
        <img src="https://raw.githubusercontent.com/roy689/handscript/master/mobile/assets/logo.png" width="260" alt="HandScript" style="display:block;margin:0 auto;width:260px;max-width:72%;height:auto;border:0;">
        <div style="margin-top:10px;font-size:13px;color:#9E8A78;letter-spacing:0.2px;">כתב היד שלך, הופך לפונט</div>
      </td>
    </tr>

    <!-- ── כרטיס ראשי ─────────────────────────────────────────────── -->
    <tr>
      <td style="background-color:#FDFAF4;border-radius:18px;border:1px solid #DEDAD1;padding:40px 38px;">

        <div style="font-size:22px;font-weight:800;color:#1E1812;margin:0 0 14px;line-height:1.35;">
          ברוך הבא ל-HandScript
        </div>

        <div style="font-size:15px;color:#6B5744;line-height:1.85;margin:0 0 30px;">
          עוד צעד קטן ואתה בפנים. אמת את כתובת המייל שלך כדי להתחיל ליצור פונט אישי מכתב היד שלך.
        </div>

        <!-- כפתור פעולה -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:30px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#1E3A5F" style="border-radius:12px;">
                    <a href="%LINK%" style="display:inline-block;padding:16px 46px;font-size:16px;font-weight:700;color:#FDFAF4;background-color:#1E3A5F;border-radius:12px;">
                      אימות כתובת המייל
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- מפריד -->
        <div style="height:1px;background-color:#EDE9E1;margin:0 0 22px;"></div>

        <!-- הערת ספאם -->
        <div style="font-size:13px;color:#9E8A78;line-height:1.7;text-align:center;margin:0 0 18px;">
          לא רואה את המייל בתיבה? כדאי לבדוק גם בתיקיית הספאם.
        </div>

        <!-- קישור חלופי -->
        <div style="font-size:12px;color:#9E8A78;line-height:1.7;text-align:center;">
          הכפתור לא עובד? אפשר להעתיק את הקישור הזה לדפדפן:<br>
          <span style="color:#1E3A5F;word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- ── הערה מתחת לכרטיס ───────────────────────────────────────── -->
    <tr>
      <td style="padding:20px 6px 0;text-align:center;">
        <div style="font-size:12px;color:#9E8A78;line-height:1.75;">
          הקישור תקף ל-24 שעות. אם לא נרשמת ל-HandScript, אפשר פשוט להתעלם מהמייל הזה.
        </div>
      </td>
    </tr>

    <!-- ── פוטר ───────────────────────────────────────────────────── -->
    <tr>
      <td style="padding-top:26px;text-align:center;">
        <div style="font-size:11px;color:#C9B8A8;letter-spacing:0.2px;">
          © 2026 HandScript · נוצר בכתב ידך
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
<meta name="x-apple-disable-message-reformatting">
<title>איפוס הסיסמה — HandScript</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap');
  body { margin:0; padding:0; }
  a { text-decoration:none; }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F4EFE6;font-family:'Heebo','Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4EFE6;">
<tr>
<td align="center" style="padding:40px 20px;">

  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- ── סמל המותג ──────────────────────────────────────────────── -->
    <tr>
      <td align="center" style="padding-bottom:28px;">
        <img src="https://raw.githubusercontent.com/roy689/handscript/master/mobile/assets/logo.png" width="260" alt="HandScript" style="display:block;margin:0 auto;width:260px;max-width:72%;height:auto;border:0;">
        <div style="margin-top:10px;font-size:13px;color:#9E8A78;letter-spacing:0.2px;">כתב היד שלך, הופך לפונט</div>
      </td>
    </tr>

    <!-- ── כרטיס ראשי ─────────────────────────────────────────────── -->
    <tr>
      <td style="background-color:#FDFAF4;border-radius:18px;border:1px solid #DEDAD1;padding:40px 38px;">

        <div style="font-size:22px;font-weight:800;color:#1E1812;margin:0 0 14px;line-height:1.35;">
          איפוס הסיסמה שלך
        </div>

        <div style="font-size:15px;color:#6B5744;line-height:1.85;margin:0 0 30px;">
          קיבלנו בקשה לאיפוס הסיסמה לחשבון ה-HandScript שלך. לחץ על הכפתור כדי לבחור סיסמה חדשה.
        </div>

        <!-- כפתור פעולה -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:30px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#1E3A5F" style="border-radius:12px;">
                    <a href="%LINK%" style="display:inline-block;padding:16px 46px;font-size:16px;font-weight:700;color:#FDFAF4;background-color:#1E3A5F;border-radius:12px;">
                      בחירת סיסמה חדשה
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- הערת אבטחה -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
          <tr>
            <td style="background-color:#FDF2E0;border:1px solid #F0DEC0;border-radius:12px;padding:14px 18px;">
              <div style="font-size:13px;color:#A85A0A;line-height:1.7;text-align:center;">
                לא ביקשת לאפס סיסמה? אפשר להתעלם מההודעה — הסיסמה שלך תישאר ללא שינוי.
              </div>
            </td>
          </tr>
        </table>

        <!-- מפריד -->
        <div style="height:1px;background-color:#EDE9E1;margin:0 0 22px;"></div>

        <!-- הערת ספאם -->
        <div style="font-size:13px;color:#9E8A78;line-height:1.7;text-align:center;margin:0 0 18px;">
          לא רואה את המייל בתיבה? כדאי לבדוק גם בתיקיית הספאם.
        </div>

        <!-- קישור חלופי -->
        <div style="font-size:12px;color:#9E8A78;line-height:1.7;text-align:center;">
          הכפתור לא עובד? אפשר להעתיק את הקישור הזה לדפדפן:<br>
          <span style="color:#1E3A5F;word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- ── הערה מתחת לכרטיס ───────────────────────────────────────── -->
    <tr>
      <td style="padding:20px 6px 0;text-align:center;">
        <div style="font-size:12px;color:#9E8A78;line-height:1.75;">
          הקישור לאיפוס תקף לשעה אחת בלבד.
        </div>
      </td>
    </tr>

    <!-- ── פוטר ───────────────────────────────────────────────────── -->
    <tr>
      <td style="padding-top:26px;text-align:center;">
        <div style="font-size:11px;color:#C9B8A8;letter-spacing:0.2px;">
          © 2026 HandScript · נוצר בכתב ידך
        </div>
      </td>
    </tr>

  </table>

</td>
</tr>
</table>

</body>
</html>"""
