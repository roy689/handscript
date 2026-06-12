# HandScript

**כתב היד שלך, הופך לפונט.** אפליקציית מובייל לזיהוי וסינתזה של כתב יד (בעברית
ובלטינית): המשתמש מצלם/מצייר דגימות של כל תו, השרת בונה מאגר אישי, והמשתמש מקליד
טקסט ומקבל תמונה של הטקסט בכתב היד האישי שלו.

> מסמך זה הוא מקור האמת היחיד לפרויקט — מאחד את כל מסמכי ההמשך (handoff) הקודמים.

---

## תוכן עניינים

- [ארכיטקטורה](#ארכיטקטורה)
- [Production — שירותים וכתובות](#production--שירותים-וכתובות)
- [מבנה הפרויקט](#מבנה-הפרויקט)
- [שפת העיצוב — Ink & Parchment](#שפת-העיצוב--ink--parchment)
- [זרימת הליבה: לכידה → המרה → תוצאה](#זרימת-הליבה-לכידה--המרה--תוצאה)
- [בחירת Variants (גיוון דגימות)](#בחירת-variants-גיוון-דגימות)
- [מערכת טיפוגרפיה, ריווח ועובי קו](#מערכת-טיפוגרפיה-ריווח-ועובי-קו)
- [משתני סביבה](#משתני-סביבה)
- [הרצה מקומית ופריסה](#הרצה-מקומית-ופריסה)
- [תכונות שמומשו](#תכונות-שמומשו)
- [משימות פתוחות / TODO](#משימות-פתוחות--todo)
- [טיפים להמשך פיתוח](#טיפים-להמשך-פיתוח)

---

## ארכיטקטורה

```
Mobile (React Native + Expo SDK 54, New Architecture)
        │  HTTPS
        ▼
Railway  ──►  Backend (FastAPI + Python 3.11, Gunicorn + 2× Uvicorn)
        │
        ├──►  Firebase (Auth + Firestore + Cloud Storage)
        ├──►  Google Cloud Vision API (OCR לעברית)
        ├──►  Brevo (שליחת מיילים טרנזקציוניים, HTTP API)
        └──►  Sentry (ניטור שגיאות)
```

- כל מפתחות Firebase/הסודות נשארים בשרת; המובייל מדבר רק מול ה-backend.
- ה-backend פורס אוטומטית ב-Railway בכל דחיפה ל-`master` (לא `main`!).

---

## Production — שירותים וכתובות

| שירות | כתובת / מזהה |
|---|---|
| Railway Backend | `https://handscript-production-2667.up.railway.app` |
| GitHub Repo | `https://github.com/roy689/handscript` (branch: **master**) |
| Firebase Project | `a-written-scanner` (תוכנית Blaze) |
| Firebase Storage Bucket | `a-written-scanner.firebasestorage.app` |
| EAS Project ID | `28b061a5-77c0-4634-871b-f9e473e9ba81` |
| Bundle ID | `com.roey.handscript` (iOS + Android) |
| Brevo sender | `handscript3@gmail.com` (מאומת) |
| Sentry | `handscript-backend` |

בדיקת בריאות: `curl https://handscript-production-2667.up.railway.app/health` → `{"status":"ok"}`

> ⚠️ **אבטחה:** אל תכניסו ערכי סוד (API keys, service account) לקבצים שנדחפים ל-git.
> הם מוגדרים רק ב-Railway → Variables וב-`.env` מקומי (שב-`.gitignore`).

---

## מבנה הפרויקט

```
handscript/
├── backend/                     FastAPI על Railway
│   ├── main.py                  כל ה-endpoints (~2000 שורות)
│   ├── modules/
│   │   ├── auth.py              Firebase Admin SDK auth
│   │   ├── extractor.py         Vision API + OpenCV — חילוץ תווים
│   │   ├── firebase_storage.py  Firestore + Cloud Storage (production, lazy init)
│   │   ├── local_storage.py     אחסון דיסק (dev בלבד)
│   │   ├── synthesizer.py       בחירת variants + רינדור (shuffled-deck)
│   │   ├── layout.py            פריסת A4 + אפקט צילום
│   │   └── validator.py         בדיקת כיסוי תווים
│   ├── services/
│   │   ├── auth_service.py      פרוקסי Firebase Auth + שליחת מיילים
│   │   ├── email_service.py     שליחת מיילי HTML דרך Brevo
│   │   ├── logo.py              לוגו עגול ל-/static/logo_round.png
│   │   ├── firebase_service.py  מנוי + usage
│   │   └── config.py            הפניית firebase_client משותפת
│   ├── requirements.txt · Dockerfile · railway.json · .env.example
│
├── mobile/                      React Native + Expo SDK 54
│   ├── App.tsx                  Root navigator + RTL + ErrorBoundary + אתחול פרסומות
│   ├── app.json                 הגדרות Expo, plugins, extra (client IDs, AdMob)
│   ├── generate-icons.js        מייצר אייקונים עגולים מ-logo.png (jimp)
│   ├── assets/logo.png          הלוגו הרשמי
│   ├── screens/                 ראה "זרימת הליבה" למטה
│   └── src/
│       ├── config.ts            לוגיקת BACKEND_URL
│       ├── theme.ts             מערכת העיצוב
│       ├── services/            firebase.ts, auth.ts, ads.ts, subscription.ts
│       ├── components/          AdBanner, NativeAdCard, AppOpenAdManager, ...
│       ├── hooks/               useExitInterstitial
│       └── utils/               api.ts, haptics.ts, offlineQueue.ts
│
├── firestore.rules · storage.rules   (deny-by-default)
└── README.md                    ← המסמך הזה
```

---

## שפת העיצוב — Ink & Parchment

מוגדרת ב-`mobile/src/theme.ts`. "דיו וקלף": משטחי קלף חמים, דיו חום-כהה, ודגש
כחול עט-נובע.

| תפקיד | בהיר | כהה |
|---|---|---|
| רקע עמוד | `#F4EFE6` | `#1A1714` |
| כרטיס | `#FDFAF4` | `#242018` |
| דיו (טקסט ראשי) | `#1E1812` | `#EDE6DA` |
| Accent (כחול עט) | `#1E3A5F` | `#5B9BD6` |
| מסגרת | `#DEDAD1` | `#3A3028` |

גופן **Heebo** · פינות `radius.lg = 18` · צללים בגוון דיו חם.

---

## זרימת הליבה: לכידה → המרה → תוצאה

**מסכים (`mobile/screens/`):** Onboarding (התחברות/הרשמה + Google) · VerifyEmail ·
ForgotPassword · CharacterList (מאגר) · CharacterConfig · CharacterCapture →
CharacterSampleReview (שמירה) · CharacterVariants (ניהול דגמים) ·
HandwritingCustomizer · Editor → Preview → FinalView · Profile · Settings · Paywall ·
Privacy · Terms · Contact.

**זרימת ההמרה (Editor → Preview → FinalView):**

1. **EditorScreen** — המשתמש מקליד; ניקוי תווי Unicode בלתי-נראים בכל הקלדה
   (U+200B–200F, 202A–202E, 2060–206F, FEFF) למניעת "כתב מחשב". בלחיצת "המר":
   `Keyboard.dismiss()`, אימות תווים (`/validate`), משיכת גליפים (`/glyphs`), וניווט.
   ספירת השימוש **לא** גדלה כאן.
2. **PreviewScreen** — לב המעבר. שתי שכבות: ציור מקומי מיידי (canvas) + רינדור
   אמיתי מהשרת (`/convert-both` עם `preview=true`, debounce ~600ms). זה מבטיח
   שהתצוגה בעריכה תואמת לקובץ הסופי. בחירת ה-variants משכפלת את לוגיקת השרת.
3. **FinalViewScreen** — מקבל את `previewUrls` ומציג מיד **ללא רינדור נוסף** (נאמנות
   מלאה — בדיוק מה שהמשתמש ראה). ברקע קורא **`/finalize`** ששומר את אותם בתים
   לאחסון קבוע ומגדיל את ספירת השימוש פעם אחת. שמירה/שיתוף/ייצוא ממתינים לקבצים
   הקבועים. מצב "נקי" ומצב "צילום" נטענים מראש להחלפה מיידית.

> **עיקרון נאמנות:** מנוע הסינתזה **אינו דטרמיניסטי** (אקראיות בבחירת variants, רעידה,
> ריווח, רעש). לכן הסופי זהה לתצוגה רק ע"י **שימוש חוזר באותו קובץ רינדור**, לא רינדור
> מחדש. `/finalize` מעלה את הבתים הקיימים; אם נמחקו, הוא מחזיר `expired` והלקוח מרנדר מחדש.

---

## בחירת Variants (גיוון דגימות)

מבטיח שכל דגימה של אות מופיעה לסירוגין (ולא תמיד אותה אחת).

- **Shuffled deck:** לכל אות נוצרת חפיסה של כל האינדקסים בסדר אקראי; מוציאים
  אחד-אחד עד שהחפיסה ריקה ואז מערבבים מחדש → כל variant מופיע פעם אחת לפני חזרה.
- **שרת** (`synthesizer.py`, `VariantPicker`): `_pick_queues` (חפיסה לכל אות),
  `_cache` (LRU 200 תמונות). `pick()` שולף מהחפיסה.
- **לקוח** (`PreviewScreen`): משכפל את הלוגיקה עם `seededRand` בנוסחת **Mulberry32**
  (hash שלם, התפלגות אחידה) כדי שתצוגה ושרת יבחרו אותו דבר לכל מיקום.

**Firestore:**
```
character_banks/{user_id}/chars/{char_hex}/
  character: "א"
  variants: [{ url, storage_path, added_at }]   # עד 5
  count, updated_at
```

---

## מערכת טיפוגרפיה, ריווח ועובי קו

ב-`backend/modules/synthesizer.py`:

```
_LINE_HEIGHT = 180px · _TARGET_CHAR_H = 80px · _BASELINE_Y_RATIO = 0.62
baseline_y = 112px ·  char_height = round(80 × h_ratio)
top_y = baseline_y − round(char_height × asc_ratio)   ← נקודת ההדבקה של הגליף
```

- `_CHAR_HEIGHT_RATIO` / `_CHAR_ASCENDER_RATIO` — טבלאות מלאות לכל תו (עברית כולל
  סופיות, ספרות, לטינית, פיסוק, מתמטיקה).
- `asc_ratio = 1.0` יושב על baseline · `>1.0` ascender · `<1.0` descender (ך, ן, g, j).
- **ריווח אותיות**: נמדד דיו-לדיו (`_hcrop_to_ink`). מיפוי `slider×0.3 − 8`; מינימום
  שלילי = חפיפה קלה (השרת מגביל ל-max −25% מרוחב אות ממוצע).
- **ריווח מילים**: נמדד דיו-לדיו. מיפוי `slider×0.85`; מינימום 0 = מילים צמודות.
- **עובי קו**: `normalize_stroke_width` (יעד `_STROKE_RATIO = 0.075`) רץ **תמיד**
  ברינדור (גם preview) וגם בשמירת דגימות חדשות → עובי אחיד בתצוגה ובסופי.

---

## משתני סביבה

**Backend** (Railway → Variables, או `backend/.env`):

| משתנה | תיאור |
|---|---|
| `APP_ENV` | `production` / `development` |
| `SERVER_HOST` · `TRUSTED_HOSTS` · `ALLOWED_ORIGINS` · `WEB_CONCURRENCY` | רשת/CORS |
| `FIREBASE_SERVICE_ACCOUNT` | JSON של service account (סוד) |
| `FIREBASE_STORAGE_BUCKET` | `a-written-scanner.firebasestorage.app` |
| `FIREBASE_WEB_API_KEY` | מפתח Web (לפרוקסי האימות) |
| `GOOGLE_VISION_API_KEY` | OCR |
| `BREVO_API_KEY` · `BREVO_SENDER_EMAIL` · `EMAIL_FROM_NAME` | שליחת מיילים |
| `SENTRY_DSN` · `SENTRY_TRACES_SAMPLE_RATE` · `ENABLE_DEBUG_ENDPOINTS` | אופציונלי |

> `SKIP_AUTH` **אסור** בייצור.

**Mobile** (`mobile/app.json` → `extra`):
`BACKEND_URL` · `GOOGLE_WEB_CLIENT_ID` (מוגדר) · `GOOGLE_IOS_CLIENT_ID` (TODO) ·
`ADMOB_BANNER_ID` / `_INTERSTITIAL_ID` / `_APP_OPEN_ID` / `_NATIVE_ID` (כרגע placeholders).
מזהי AdMob App ID תחת `plugins` (`androidAppId`/`iosAppId`).

---

## הרצה מקומית ופריסה

**Backend (dev):**
```cmd
cd backend
venv\Scripts\activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Mobile (dev):**
```cmd
cd mobile
npm install
npx expo start --dev-client --clear --lan
```

**בנייה (פרסומות/Google דורשים build native — לא Expo Go):**
```cmd
cd mobile
node generate-icons.js                                  REM אייקונים עגולים
eas build --profile preview --platform android          REM APK עצמאי לבדיקה
```

**Git / פריסה:**
```cmd
cd "C:\Users\Roey\OneDrive\Desktop\New folder\handscript"
git add <files>
git status                      REM ודא שאין .env / serviceAccountKey
git commit -m "..."
git push origin master          REM Railway פורס תוך 3–7 דקות
```

**כלל אצבע:** שינוי ב-`backend/` → רק `git push`. שינוי ב-`mobile/` → `eas build` חדש + התקנה.

---

## תכונות שמומשו

**אימות וחשבון:** Email/Password (פרוקסי בשרת), אימות מייל, איפוס סיסמה, אישור תנאים,
מחיקת חשבון. Rate limiting (20/דק' כללי, 6/דק' המרה, 3/דק' איפוס). הגנות path-traversal,
TrustedHost, HTTPS-redirect, וכללי Firestore/Storage deny-by-default.

**מיילי אימות/איפוס מותאמים:** קונסולת Firebase חוסמת עריכת תבניות, ולכן ה-backend
מייצר את הקישור (Admin SDK) ושולח מייל HTML מעוצב (Ink & Parchment, לוגו עגול)
דרך **Brevo HTTP API** — לא SMTP, כי Railway חוסם פורטי SMTP יוצאים. קוד:
`services/email_service.py` + `auth_service.py`. בדיקה: `backend/test_smtp.py`.

**התחברות Google:** ממומש בקוד (`@react-native-google-signin` + `/auth/signin-google`).
Google מופעל ב-Firebase Auth, ו-`GOOGLE_WEB_CLIENT_ID` אמיתי הוכנס. נותר: iOS client ID
+ `iosUrlScheme`, SHA-1 לאנדרואיד, ו-build native.

**פרסומות AdMob (חינמיים):** `react-native-google-mobile-ads` **16.3.3** (נדרש ל-Expo
54 / RN 0.81). `src/services/ads.ts` + קומפוננטות:
App Open (חזרה מרקע, cap 4 דק'), Native (במאגר), Interstitial (יציאה מ-FinalView /
אחרי סקירת דגימות, cap 3 דק'), Banners (מסכים שקטים). ללא פרסומות במצלמה/עורך/preview
חי/onboarding/תוצאה ראשונה. `shouldShowAds()` מרוכז להשבתה עתידית ל-Pro.

**מיתוג:** אייקון, adaptive-icon, splash ו-favicon נוצרים מ-`logo.png` (`generate-icons.js`,
jimp), **עגולים** על רקע קלף.

**סינתזה ונאמנות:** Shuffled-deck variant selection (שרת + לקוח Mulberry32), endpoint
`/finalize` לשמירת הרינדור המדויק בלי רינדור מחדש, ריווח דיו-לדיו, ונרמול עובי קו עקבי.

**תיקוני באגים מרכזיים:**
- **500 בשמירת תו** — `save-character-samples` קרא `_invalidate_bank_cache(body.user_id)`
  אך למודל אין `user_id` (מגיע מה-JWT כ-`uid`). ה-`AttributeError` החזיר 500 *אחרי*
  השמירה (התו נשמר אך הוצגה שגיאה). תוקן ל-`uid`.
- **500 ב-`/convert-both`** — `ImportError: prefetch_bank_images` ו-`NameError: _STROKE_RATIO`
  מגרסאות ישנות; מתוקנים בקוד הנוכחי (שני הסמלים מוגדרים ב-`synthesizer.py`).

---

## משימות פתוחות / TODO

**להשלמה לפני release:**
- להחליף מזהי בדיקה של AdMob (App ID + יחידות) במזהים אמיתיים; להוסיף מסך הסכמת
  פרטיות (UMP/GDPR).
- להשלים Google Sign-In: iOS client ID + `iosUrlScheme`, SHA-1 לאנדרואיד.
- **Apple Sign-In** — חובה ל-iOS release אם יש כניסה חברתית. לא מומש.
- אימות טפסים אחיד, מצבי ריק/טעינה/שגיאה אחידים בכל המסכים.
- EAS production build + TestFlight + Play Internal testing.

**אחזקה/אופטימיזציה:**
- להוריד את רמת ה-DEBUG של `modules.synthesizer` בפרודקשן (כמות לוגים גבוהה גרמה
  ל-Railway להפיל לוגים).
- נרמול חד-פעמי של עובי קו לדגימות **קיימות** (כרגע רק חדשות מנורמלות בשמירה).
- caching ל-`load_character_bank`, retry על קריאות Firebase, CDN לקבצים סטטיים.
- לבטל את סיסמת האפליקציה הישנה של Gmail (הוחלפה ב-Brevo).

---

## טיפים להמשך פיתוח

- **Grep לפני Read** — חיפוש ממוקד עדיף על קריאת קבצים שלמים. `main.py` הוא ~2000 שורות.
- **Read עם offset/limit** — קרא רק את החלק הרלוונטי; השתמש בעץ המבנה כמפה.
- **דחיפה תכופה** — אל תצבור שינויים לא-committed; ודא תמיד שאין `.env`/מפתחות בדחיפה.
- **הסביבה הלינוקסית** (git/python/build מהצ'אט) לא תמיד זמינה במחשב הזה
  (`HYPERVISOR_VIRT_DISABLED`); המשתמש מריץ פקודות מהמסוף בעצמו.

---

**משתמש:** רועי · `r0534571051@gmail.com` · ישראל · עברית · RTL
