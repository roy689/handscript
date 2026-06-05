# הוראות לעיצוב תבניות מייל — HandScript
## (למסור לקלוד קוד המחובר לכרום)

---

## המשימה
יש להיכנס לקונסולת Firebase של פרויקט HandScript ולהחליף את שתי תבניות המייל (אימות כתובת מייל + שחזור סיסמה) בתבניות HTML מעוצבות המופיעות בהמשך מסמך זה.

---

## שלב 1 — כניסה לקונסולת Firebase

1. נווט ל: `https://console.firebase.google.com`
2. אם תתבקש להתחבר, התחבר עם חשבון Google של הפרויקט.
3. ברשימת הפרויקטים, חפש פרויקט בשם **handscript** (או כל שם הכולל את המילה handscript) ולחץ עליו.

---

## שלב 2 — ניווט לתבניות המייל

1. בתפריט הניווט השמאלי, לחץ על **Build** (בנייה).
2. בתפריט שנפתח, לחץ על **Authentication**.
3. בראש הדף שנטען, לחץ על הלשונית **Templates** (תבניות).
4. תראה 4 תבניות: Email address verification / Password reset / Email address change / SMS verification. צריך לערוך **רק** את שתי הראשונות.

---

## שלב 3 — עריכת תבנית אימות כתובת מייל

1. לחץ על **Email address verification**.
2. לחץ על סמל עיפרון העריכה (Edit template).
3. **שנה את Subject** (נושא המייל) ל:
   ```
   ✍️ אמת את כתובת המייל שלך — HandScript
   ```
4. **מחק את כל תוכן ה-Message** (גוף המייל) והדבק במקומו את ה-HTML הבא **בדיוק כפי שהוא**:

```html
<!DOCTYPE html>
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

    <!-- ── לוגו ─────────────────────────────────────────────────── -->
    <tr>
      <td align="center" style="padding-bottom:36px;">
        <div style="font-size:56px;line-height:1;">✍️</div>
        <div style="margin-top:10px;font-size:26px;font-weight:800;color:#E8C98A;letter-spacing:-0.5px;">HandScript</div>
        <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.38);letter-spacing:0.3px;">כתב היד הדיגיטלי שלך</div>
      </td>
    </tr>

    <!-- ── כרטיס ראשי ────────────────────────────────────────────── -->
    <tr>
      <td style="background-color:#161B22;border-radius:18px;border:1px solid rgba(255,255,255,0.09);padding:44px 40px;">

        <!-- כותרת -->
        <div style="font-size:22px;font-weight:800;color:#FFFFFF;margin-bottom:16px;line-height:1.3;">
          אמת את כתובת המייל שלך 📬
        </div>

        <!-- גוף -->
        <div style="font-size:15px;color:rgba(255,255,255,0.62);line-height:1.8;margin-bottom:32px;">
          שלום!<br><br>
          תודה שנרשמת ל-HandScript.<br>
          לחץ על הכפתור למטה כדי לאמת את כתובת המייל שלך ולהתחיל ליצור את הפונט האישי שלך.
        </div>

        <!-- כפתור CTA -->
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

        <!-- הפרדה -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
          <tr>
            <td style="height:1px;background-color:rgba(255,255,255,0.08);"></td>
          </tr>
        </table>

        <!-- הערת ספאם -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
          <tr>
            <td style="background-color:rgba(232,201,138,0.07);border-radius:10px;border:1px solid rgba(232,201,138,0.15);padding:12px 18px;">
              <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.7;text-align:center;">
                📁 &nbsp; לא קיבלת את המייל? בדוק את תיבת הספאם שלך
              </div>
            </td>
          </tr>
        </table>

        <!-- קישור חלופי -->
        <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.7;text-align:center;">
          הכפתור לא עובד? העתק והדבק את הכתובת הבאה בדפדפן שלך:<br>
          <span style="color:rgba(232,201,138,0.55);word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- ── הערת אבטחה ─────────────────────────────────────────────── -->
    <tr>
      <td style="padding:20px 4px 0;text-align:center;">
        <div style="font-size:12px;color:rgba(255,255,255,0.22);line-height:1.7;">
          אם לא נרשמת ל-HandScript, פשוט התעלם מהודעה זו.<br>
          הקישור יפוג תוך 24 שעות.
        </div>
      </td>
    </tr>

    <!-- ── פוטר ───────────────────────────────────────────────────── -->
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
</html>
```

5. לחץ **Save** (שמור).

---

## שלב 4 — עריכת תבנית שחזור סיסמה

1. חזור ללשונית **Templates**.
2. לחץ על **Password reset**.
3. לחץ על סמל עיפרון העריכה (Edit template).
4. **שנה את Subject** ל:
   ```
   🔐 איפוס סיסמה — HandScript
   ```
5. **מחק את כל תוכן ה-Message** והדבק במקומו את ה-HTML הבא **בדיוק כפי שהוא**:

```html
<!DOCTYPE html>
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

    <!-- ── לוגו ─────────────────────────────────────────────────── -->
    <tr>
      <td align="center" style="padding-bottom:36px;">
        <div style="font-size:56px;line-height:1;">✍️</div>
        <div style="margin-top:10px;font-size:26px;font-weight:800;color:#7EC8E3;letter-spacing:-0.5px;">HandScript</div>
        <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.38);letter-spacing:0.3px;">כתב היד הדיגיטלי שלך</div>
      </td>
    </tr>

    <!-- ── כרטיס ראשי ────────────────────────────────────────────── -->
    <tr>
      <td style="background-color:#0F1F3A;border-radius:18px;border:1px solid rgba(126,200,227,0.15);padding:44px 40px;">

        <!-- אייקון נעילה -->
        <div style="text-align:center;margin-bottom:20px;">
          <div style="display:inline-block;background-color:rgba(126,200,227,0.1);border:1.5px solid rgba(126,200,227,0.25);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:34px;text-align:center;">
            🔐
          </div>
        </div>

        <!-- כותרת -->
        <div style="font-size:22px;font-weight:800;color:#FFFFFF;margin-bottom:16px;line-height:1.3;text-align:center;">
          בקשת איפוס סיסמה
        </div>

        <!-- גוף -->
        <div style="font-size:15px;color:rgba(255,255,255,0.62);line-height:1.8;margin-bottom:32px;text-align:center;">
          קיבלנו בקשה לאיפוס הסיסמה של חשבון ה-HandScript שלך.<br>
          לחץ על הכפתור למטה כדי לבחור סיסמה חדשה.
        </div>

        <!-- כפתור CTA -->
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

        <!-- הפרדה -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
          <tr>
            <td style="height:1px;background-color:rgba(126,200,227,0.12);"></td>
          </tr>
        </table>

        <!-- הערת ספאם -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr>
            <td style="background-color:rgba(126,200,227,0.07);border-radius:10px;border:1px solid rgba(126,200,227,0.15);padding:12px 18px;">
              <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.7;text-align:center;">
                📁 &nbsp; לא קיבלת את המייל? בדוק את תיבת הספאם שלך
              </div>
            </td>
          </tr>
        </table>

        <!-- אזהרת אבטחה -->
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

        <!-- קישור חלופי -->
        <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.7;text-align:center;">
          הכפתור לא עובד? העתק והדבק את הכתובת הבאה בדפדפן שלך:<br>
          <span style="color:rgba(126,200,227,0.5);word-break:break-all;">%LINK%</span>
        </div>

      </td>
    </tr>

    <!-- ── הערת תוקף ──────────────────────────────────────────────── -->
    <tr>
      <td style="padding:20px 4px 0;text-align:center;">
        <div style="font-size:12px;color:rgba(255,255,255,0.22);line-height:1.7;">
          הקישור לאיפוס הסיסמה יפוג תוך שעה אחת.
        </div>
      </td>
    </tr>

    <!-- ── פוטר ───────────────────────────────────────────────────── -->
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
</html>
```

6. לחץ **Save** (שמור).

---

## שלב 5 — אימות (אופציונלי אך מומלץ)

1. חזור לתבנית Email address verification.
2. לחץ על **Send test email** (שלח מייל בדיקה).
3. הכנס כתובת מייל בדיקה ולחץ שלח.
4. בדוק שהמייל מגיע ונראה כמצופה.
5. חזור על הפעולה גם עבור תבנית Password reset.

---

## הערות חשובות

- אל תמחק את משתני הטמפלייט `%LINK%` — הם הכרחיים כדי שהקישור יעבוד.
- אם Firebase מציג שגיאה על HTML — ודא שהדבקת את הקוד בשדה **Message** ולא בשדה Subject.
- אם יש בעיה עם שמירת ה-HTML המלא, נסה ללחוץ מחוץ לשדה ולחזור לשמור.
