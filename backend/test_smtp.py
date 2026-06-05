"""
Standalone SMTP self-test for HandScript.

Run this locally to confirm your Gmail App Password and SMTP settings work,
without going through the whole backend / deploy cycle.

Usage (PowerShell), from the backend/ folder:

    $env:SMTP_HOST="smtp.gmail.com"
    $env:SMTP_PORT="587"
    $env:SMTP_SECURITY="starttls"
    $env:SMTP_USERNAME="handscript3@gmail.com"
    $env:SMTP_PASSWORD="<16-char app password, NO spaces>"
    $env:SMTP_FROM="handscript3@gmail.com"
    python test_smtp.py you@example.com

It prints a clear success message, or the exact SMTP error (e.g. bad password).
"""

import os
import sys

from services import email_service


def main() -> int:
    to = sys.argv[1] if len(sys.argv) > 1 else os.getenv("SMTP_USERNAME", "")
    if not to:
        print("Usage: python test_smtp.py <recipient-email>")
        return 2

    print("Config check:")
    print(f"  host       = {os.getenv('SMTP_HOST')!r}")
    print(f"  port       = {os.getenv('SMTP_PORT')!r}")
    print(f"  security   = {os.getenv('SMTP_SECURITY')!r}")
    print(f"  username   = {os.getenv('SMTP_USERNAME')!r}")
    print(f"  password   = {'<set, %d chars>' % len(os.getenv('SMTP_PASSWORD', '')) if os.getenv('SMTP_PASSWORD') else '<EMPTY>'}")
    print(f"  from       = {os.getenv('SMTP_FROM')!r}")
    print(f"  is_configured() -> {email_service.is_configured()}")
    print()

    if not email_service.is_configured():
        print("❌ SMTP is not fully configured — set the env vars above.")
        return 1

    html = "<h2>HandScript SMTP test ✅</h2><p>אם קיבלת את זה — ה-SMTP עובד.</p>"
    ok = email_service.send_html(to, "HandScript SMTP test", html)
    if ok:
        print(f"✅ Sent test email to {to}. Check the inbox (and spam).")
        return 0
    print("❌ Send failed — see the error logged above (likely a bad App Password).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
