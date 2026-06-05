"""
Standalone email self-test for HandScript (Brevo HTTP API).

Confirms your Brevo API key + verified sender work, without going through the
whole backend / deploy cycle.

Usage (PowerShell), from the backend/ folder:

    $env:BREVO_API_KEY="xkeysib-...."
    $env:BREVO_SENDER_EMAIL="handscript3@gmail.com"   # must be a verified Brevo sender
    python test_smtp.py you@example.com

It prints a clear success message, or the exact API error.
"""

import os
import sys

from services import email_service


def main() -> int:
    to = sys.argv[1] if len(sys.argv) > 1 else os.getenv("BREVO_SENDER_EMAIL", "")
    if not to:
        print("Usage: python test_smtp.py <recipient-email>")
        return 2

    cfg = email_service._cfg()
    print("Config check:")
    print(f"  api_key    = {'<set, %d chars>' % len(cfg['api_key']) if cfg['api_key'] else '<EMPTY>'}")
    print(f"  sender     = {cfg['from_addr']!r}")
    print(f"  from_name  = {cfg['from_name']!r}")
    print(f"  is_configured() -> {email_service.is_configured()}")
    print()

    if not email_service.is_configured():
        print("❌ Not configured — set BREVO_API_KEY and a sender address.")
        return 1

    html = "<h2>HandScript email test ✅</h2><p>אם קיבלת את זה — Brevo עובד.</p>"
    ok = email_service.send_html(to, "HandScript email test", html)
    if ok:
        print(f"✅ Sent test email to {to}. Check the inbox (and spam).")
        return 0
    print("❌ Send failed — see the error logged above.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
