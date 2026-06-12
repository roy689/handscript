# HandScript

**כתב היד שלך, הופך לפונט.** אפליקציית מובייל שלוכדת את כתב היד של המשתמש (תו-תו),
ומאפשרת לייצר ממנו מסמכים בכתב היד האישי שלו.

מונורפו הכולל אפליקציית React Native (Expo), שרת Python (FastAPI), וטיפוסים
משותפים ב-TypeScript.

---

## תוכן עניינים

- [מבנה הפרויקט](#מבנה-הפרויקט)
- [שפת העיצוב — Ink & Parchment](#שפת-העיצוב--ink--parchment)
- [mobile/ — אפליקציית React Native](#mobile--אפליקציית-react-native)
- [backend/ — שרת FastAPI](#backend--שרת-fastapi)
- [משתני סביבה](#משתני-סביבה)
- [פריסה (Deployment)](#פריסה-deployment)
- [תכונות שמומשו](#תכונות-שמומשו)
- [משימות פתוחות / TODO](#משימות-פתוחות--todo)

---

## מבנה הפרויקט

```
handscript/
├── mobile/      React Native (Expo SDK 54) app
├── backend/     Python FastAPI server (deployed on Railway)
└── shared/      Shared TypeScript types and constants
```

- **Backend** מתארח ב-**Railway** ופורס אוטומטית בכל דחיפה ל-`master`:
  `https://handscript-production-2667.up.railway.app`
- **Mobile** נבנה עם **EAS** (`eas build`). פרסומות והתחברות Google דורשות build
  native — הן **לא** עובדות ב-Expo Go.
- **Firebase project:** `a-written-scanner` (Auth + Firestore + Storage).

**כלל אצבע לפריסה:**
- שינוי תחת `backend/` → רק `git push` (Railway פורס, בלי build לאפליקציה).
- שינוי תחת `mobile/` (קוד, `app.json`, אייקונים, פרסומות) → צריך `eas build`
  חדש והתקנה מחדש על המכשיר.

---

## שפת העיצוב — Ink & Parchment

מוגדרת ב-`mobile/src/theme.ts`. אסתטיקה של "דיו וקלף": משטחי קלף חמים, דיו
חום-כהה, ודגש כחול עט-נובע.

| תפקיד | בהיר | כהה |
|---|---|---|
| רקע עמוד | `#F4EFE6` | `#1A1714` |
| כרטיס | `#FDFAF4` | `#242018` |
| דיו (טקסט ראשי) | `#1E1812` | `#EDE6DA` |
| דיו משני | `#6B5744` | `#A09484` |
| Accent (כחול עט) | `#1E3A5F` | `#5B9BD6` |
| מסגרת | `#DEDAD1` | `#3A3028` |

- גופן: **Heebo** (400/600/700/800).
- פינות מעוגלות אומנותיות (`radius.lg = 18`), צללים בגוון דיו חם.

---

## mobile/ — אפליקציית React Native

**Tech:** React Native 0.81 · Expo SDK 54 · TypeScript · New Architecture.

**חבילות מרכזיות:**

| חבילה | תפקיד |
|---|---|
| `@react-navigation/native` + `native-stack` + `bottom-tabs` | ניווט |
| `expo-camera` | צילום כתב יד |
| `expo-image-manipulator` | חיתוך/שינוי גודל לפני העלאה |
| `expo-media-library` / `expo-sharing` / `expo-print` | שמירה ושיתוף תוצרים |
| `firebase` | Auth בצד הלקוח |
| `@react-native-google-signin/google-signin` | התחברות עם Google |
| `react-native-google-mobile-ads` (**16.3.3**) | פרסומות AdMob |

**מסכים עיקריים (`mobile/screens/`):**

- `OnboardingScreen` — התחברות / הרשמה (כולל כפתור Google), עם לוגו עגול.
- `VerifyEmailScreen` / `ForgotPasswordScreen` — אימות מייל ואיפוס סיסמה.
- `CharacterListScreen` — מאגר האותיות (מכיל פרסומת native).
- `CharacterCaptureScreen` → `CharacterSampleReviewScreen` — לכידת דגימות של תו ושמירה.
- `CharacterVariantsScreen` — צפייה/מחיקה של דגימות שמורות.
- `HandwritingCustomizerScreen` — מכוון פרמטרים (גודל, ריווח, רעידת שורה) עם תצוגה חיה.
- `EditorScreen` → `PreviewScreen` → `FinalViewScreen` — הקלדת טקסט, המרה לכתב יד, ותוצאה סופית.
- `ProfileScreen` / `SettingsScreen` / `ContactScreen` / `Privacy` / `Terms`.

**הרצה (פיתוח):**
```bash
cd mobile
npm install
npx expo start --dev-client   # dev client — לא Expo Go (בגלל מודולים native)
```

**בנייה עצמאית להתקנה ישירה (עם פרסומות):**
```bash
eas build --profile preview --platform android
```

**אייקון ומסך פתיחה:** נוצרים מ-`assets/logo.png` ע"י `generate-icons.js`
(משתמש ב-`jimp`), בצורה **עגולה** על רקע קלף:
```bash
node generate-icons.js   # מייצר icon.png, adaptive-icon.png, splash-icon.png, favicon.png
```

---

## backend/ — שרת FastAPI

**Tech:** Python 3.11 · FastAPI · Uvicorn/Gunicorn · OpenCV · Pillow · NumPy ·
firebase-admin.

**זרימת ליבה:** לכידת דגימות → חילוץ תו (סף, הסרת קווי מחברת, נרמול עובי קו,
וקטוריזציה ב-potrace) → אחסון ב-Firebase Storage/Firestore → סינתזה (`synthesizer`)
שמרכיבה עמוד בכתב היד מהדגימות.

**Endpoints עיקריים:**

| נתיב | תיאור |
|---|---|
| `POST /auth/login` · `/auth/signup` · `/auth/signin-google` · `/auth/refresh` | פרוקסי אימות (מחזיק את מפתחות Firebase בשרת) |
| `POST /auth/reset-password` · `/auth/resend-verification` · `/auth/check-verification` | זרימות מייל |
| `POST /save-character-samples` | שמירת דגימות של תו |
| `GET /character/{uid}/{char}/variants` · `DELETE .../variant/{i}` | צפייה/מחיקת דגימות |
| `POST /convert` · `/convert-both` · `/glyphs` | המרת טקסט לכתב יד |
| `GET /subscription/{uid}` · `GET /health` | שונות |

**שירותים/מודולים מרכזיים:**
- `services/auth_service.py` — פרוקסי Firebase Auth + שליחת מיילים מותאמים.
- `services/email_service.py` — שליחת מיילי HTML דרך **Brevo HTTP API**.
- `services/logo.py` — מייצר לוגו עגול בהפעלה ומגיש ב-`/static/logo_round.png`.
- `modules/extractor.py`, `modules/synthesizer.py` — חילוץ וסינתזת כתב יד.
- `modules/firebase_storage.py` — Firestore + Storage (אתחול עצל).

**הרצה (מקומית):**
```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows  (mac/linux: source venv/bin/activate)
pip install -r requirements.txt
uvicorn main:app --reload
```
העתק `.env.example` ל-`.env` ומלא ערכים לפני הרצה.

---

## משתני סביבה

**Backend (Railway → Variables, או `backend/.env` מקומית):**

| משתנה | תיאור |
|---|---|
| `APP_ENV` | `production` / `development` |
| `FIREBASE_SERVICE_ACCOUNT` | JSON של חשבון השירות (או `FIREBASE_CREDENTIALS_JSON` / נתיב קובץ מקומי) |
| `FIREBASE_STORAGE_BUCKET` | `a-written-scanner.firebasestorage.app` |
| `FIREBASE_WEB_API_KEY` | מפתח Web של Firebase (לפרוקסי האימות) |
| `GOOGLE_VISION_API_KEY` | (אם בשימוש) |
| `SERVER_HOST` · `ALLOWED_ORIGINS` · `TRUSTED_HOSTS` | רשת/CORS בפרודקשן |
| `BREVO_API_KEY` | מפתח Brevo לשליחת מיילים |
| `BREVO_SENDER_EMAIL` | כתובת שולח מאומתת ב-Brevo (נופל ל-`SMTP_FROM`) |
| `EMAIL_FROM_NAME` | שם השולח (ברירת מחדל: `HandScript`) |
| `SENTRY_DSN` · `ENABLE_DEBUG_ENDPOINTS` | אופציונלי |

**Mobile (`mobile/app.json` → `extra`):**

| משתנה | תיאור |
|---|---|
| `BACKEND_URL` | כתובת ה-backend ב-Railway |
| `GOOGLE_WEB_CLIENT_ID` | מזהה OAuth מ-Firebase (מוגדר) |
| `GOOGLE_IOS_CLIENT_ID` | TODO — דורש רישום אפליקציית iOS |
| `ADMOB_BANNER_ID` / `ADMOB_INTERSTITIAL_ID` / `ADMOB_APP_OPEN_ID` / `ADMOB_NATIVE_ID` | מזהי יחידות פרסומת (כרגע placeholders — בדיקה ב-dev) |

מזהי ה-AdMob App ID נמצאים תחת `plugins` ב-`app.json` (`androidAppId`/`iosAppId`).

---

## פריסה (Deployment)

- **Backend:** דחיפה ל-`master` ב-GitHub → Railway בונה ופורס אוטומטית.
- **Mobile:** `eas build --profile <preview|development> --platform android` →
  התקנת ה-APK על המכשיר. `development` דורש שרת Metro רץ; `preview` עצמאי.

---

## תכונות שמומשו

### מיילי אימות ואיפוס סיסמה (מותאמים אישית)

- קונסולת Firebase **חוסמת עריכה** של תבניות המייל המובנות בפרויקט הזה, ולכן
  המיילים מורכבים ונשלחים מה-backend.
- זרימה: ה-backend מייצר את קישור הפעולה דרך Firebase Admin SDK
  (`generate_email_verification_link` / `generate_password_reset_link`), ואז
  שולח מייל HTML מעוצב.
- שליחה דרך **Brevo HTTP API** (HTTPS) ולא SMTP — כי Railway חוסם פורטי SMTP
  יוצאים (25/465/587); SMTP ישיר נכשל ב-`Network is unreachable`.
- עיצוב המייל תואם את שפת **Ink & Parchment**, עם הלוגו האמיתי כעיגול בכותרת.
- קוד: `backend/services/email_service.py`, מחובר ל-`auth_service.py`. בדיקה:
  `backend/test_smtp.py`.

### התחברות עם Google

- ממומש בקוד (mobile `src/services/auth.ts` + backend `/auth/signin-google`).
  הושלם: Google מופעל ב-Firebase Auth, ו-`GOOGLE_WEB_CLIENT_ID` אמיתי ב-`app.json`.
- נותר: מזהה iOS + `iosUrlScheme`, טביעת SHA-1 של אנדרואיד ב-Firebase, ו-build native.

### פרסומות AdMob (למשתמשים חינמיים)

- ספרייה: `react-native-google-mobile-ads` **16.3.3** (נדרש ל-Expo 54 / RN 0.81;
  גרסה 14.x נכשלה בקומפילציה).
- מימוש ב-`mobile/src/services/ads.ts` + קומפוננטות:
  - **App Open** — בחזרה מהרקע (cap 4 דק') — `AppOpenAdManager`.
  - **Native** — בתוך מאגר האותיות — `NativeAdCard`.
  - **Interstitial** — ביציאה מ-FinalView ואחרי סקירת דגימות (cap 3 דק') — `useExitInterstitial`.
  - **Banners** — במסכים שקטים (Variants, Settings, Profile, Contact, Privacy, Terms, Customizer) — `AdBanner`.
  - ללא פרסומות: מצלמה, עורך, תצוגה חיה, onboarding, תוצאה ראשונה.
- `shouldShowAds()` מרוכז כדי לאפשר השבתה ל-Pro בעתיד.

### מיתוג — אייקון ומסך פתיחה

- נוצרים מ-`assets/logo.png` ע"י `mobile/generate-icons.js` (jimp), בצורה
  **עגולה** על רקע קלף. רקעי splash/adaptive ב-`app.json` הוגדרו ל-`#F4EFE6`.

### תיקוני באגים

- **500 בשמירת תו** — `save-character-samples` שמר את התו אך אז קרא ל-
  `_invalidate_bank_cache(body.user_id)`, ולמודל הבקשה אין `user_id` (הוא מגיע
  מה-JWT כ-`uid`). ה-`AttributeError` החזיר 500 *אחרי* השמירה, כך שהתו נשמר אך
  המשתמש ראה שגיאה. תוקן לשימוש ב-`uid` (`backend/main.py`).

---

## משימות פתוחות / TODO

- להחליף מזהי בדיקה של AdMob (App ID + יחידות) במזהים אמיתיים; להוסיף מסך הסכמת
  פרטיות (UMP/GDPR) לפני production.
- להשלים הגדרת Google Sign-In: מזהה iOS, `iosUrlScheme`, ו-SHA-1 לאנדרואיד.
- לבטל את סיסמת האפליקציה הישנה של Gmail (אם עוד לא בוטלה) — היא הוחלפה ב-Brevo.
- לשקול הורדת רמת ה-DEBUG של `modules.synthesizer` ב-production (כמות לוגים גבוהה).
