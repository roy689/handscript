# HandScript — סקירה מעמיקה: סליידרים ומסך עריכה
_נוצר 2026-06-13 | קוד: PreviewScreen.tsx, EditorScreen.tsx, FinalViewScreen.tsx, synthesizer.py_

---

## תמצית

PreviewScreen מציג 6 סליידרים (0-100) שממפים לפרמטרי backend בפיקסלים, בנוסף לעורך טקסט, בוחר צבע דיו, ובוחר רקע דף. כל ערכי הסליידר עוברים דרך 3 מסלולים עצמאיים — `/layout` (תצוגה חיה), `/convert-both` (תצוגה מדויקת), ו-FinalViewScreen → `/finalize` — שחייבים להיות זהים זה לזה.

---

## מצב נוכחי — ממפה פרמטרים

```
slider (0-100) → backend
──────────────────────────────────────────────────────────────────
charHeight   : 40 + s×0.9          → 40–130 px      (טבעי: 80px @ slider≈44)
letterSpacing: s×0.30 – 8          → -8 — +22 px    (טבעי: ~9px @ slider≈57)
wordSpacing  : s×0.85              → 0–85 px        (טבעי: ~62px @ slider≈73)
baselineJitter: s×0.25             → 0–25% σ        (☞ ראה באג #B1)
slant        : s×0.4               → 0–40 px        (נטייה ≤0.5px = ישר)
inkBlobs     : s×0.002             → 0–0.20 הסתברות (עודכן מ-0.003 היום)
```

**ברירות מחדל שנשלחות מ-EditorScreen (בפיקסלים backend):**
```
charHeight=85  → slider=50   ✓ טבעי כמעט
letterSpacing=9  → slider=57 ✓ ריווח טבעי
wordSpacing=42   → slider=49 ✓ פרק קריא
baselineJitter=3 → slider=12 ✓ קפיצה עדינה מאוד
slant=6          → slider=15 ✓ נטייה עדינה
inkBlobs=0.02    → slider=10 ✓ 2% כתמי דיו
```

---

## 🔴 באגים קריטיים

### B1 — baselineJitter מקסימום 25% הוא גבוה מדי
**קובץ:** PreviewScreen.tsx (ונגזרות)
**תיאור:** בסליידר=100 מקבלים σ=25% מגובה הגליף. עבור אות בגובה 85px: הטיה של ±21px (σ=1), ±42px (σ=2) — אותיות קופצות שורה שלמה אחת. בכתב יד אנושי רגיל הטיית בסיס היא 3-8%, מקסימום ריאלי הוא 15%.
**תיקון:** שינוי נוסחה מ-`s×0.25` ל-`s×0.15` (טווח 0-15%)
**משפיע על:** PreviewScreen×3 מקומות, FinalViewScreen, EditorScreen initState inverse
**סטטוס:** ✅ תוקן 2026-06-13 (`s×0.25` → `s×0.15` ב-PreviewScreen×3 + FinalViewScreen)

### B2 — גובה אות מינימלי בסליידר=0 אינו קריא
**קובץ:** PreviewScreen.tsx (PreviewSliderRow)
**תיאור:** בסליידר=0 → `char_height=40px`. בגדר הצגה על מסך הטלפון: `40 × (notebookW/2480) ≈ 5.6px` — אות בלתי קריאה לחלוטין. המשתמש עלול לגרור לאפס ולא להבין למה הטקסט "נעלם".
**תיקון:** הוספת `minimumValue={20}` לסליידר charHeight בלבד → מינימום `40+20×0.9=58px`
**משפיע על:** PreviewSliderRow (צריך prop `min` אופציונלי)
**סטטוס:** ✅ תוקן 2026-06-13 (`PreviewSliderRow` קיבל props `min` ו-`max`; charHeight min=20, wordSpacing min=5)

### B3 — accessibilityHint לעריכת טקסט שגוי
**קובץ:** PreviewScreen.tsx (שורה ~861)
**תיאור:** הטקסט `"מאפשר מחיקת תווים ורדת שורה — לא ניתן להוסיף תווים חדשים"` שגוי: המשתמש *כן* יכול להוסיף תווים חדשים — הם פשוט יוצגו בגופן רגיל אם אינם במאגר. הטקסט מטעה משתמשי מסייע גישה.
**תיקון:** שינוי ל-`"ניתן לערוך חופשי; תווים שאינם במאגר יוצגו בגופן רגיל"`
**סטטוס:** ✅ תוקן 2026-06-13

---

## 🟡 בעיות משמעותיות

### S1 — אין מונה תווים בעורך הטקסט
**קובץ:** PreviewScreen.tsx
**תיאור:** TextInput מוגבל ל-MAX_TEXT_LEN תווים אך המשתמש אינו רואה כמה תווים נשארו. הוא לומד על המגבלה רק כשהקלדה פוסקת בפתאומיות.
**תיקון:** הוספת `<Text>{editableText.length}/{MAX_TEXT_LEN}</Text>` מתחת ל-TextInput, עם צבע אדום כאשר מעל 90%.
**סטטוס:** 🔲 טרם תוקן

### S2 — ריווח מילה בסליידר=0 → מילים נוגעות זו בזו
**קובץ:** PreviewScreen.tsx
**תיאור:** בסליידר=0 → `word_spacing=0` → `_rand_word_gap()` מחזיר `max(0, gauss(0, 0)) = 0` — מילים נוגעות ממש. זה תקין טכנית אך מבלבל את המשתמש שמזיז לקצה ולא מבין למה הטקסט נראה "שבור".
**תיקון:** הוספת `minimumValue={5}` לסליידר wordSpacing → `word_spacing_min=4.25px` (מילים כמעט נוגעות אבל לא ממש).
**אלטרנטיבה:** שינוי formula ל-`5 + s×0.80` (מינימום 5px, מקסימום 85px) — אבל זה שובר drafts קיימים.
**סטטוס:** 🔲 טרם תוקן

### S3 — Draft key לא כולל מזהה משתמש
**קובץ:** PreviewScreen.tsx (`const DRAFT_KEY = 'preview_draft'`)
**תיאור:** כל המשתמשים על אותה מכשיר חולקים את אותו draft. אם בן משפחה פתח את האפליקציה, טיוטת העיצוב שלו תוטען למשתמש הבא.
**תיקון:** שנה ל-`` `preview_draft_${userId}` `` — צריך לקרוא את userId *לפני* ה-AsyncStorage.getItem.
**אזהרה:** migration — drafts קיימים עם המפתח הישן לא יוטענו.
**סטטוס:** 🔲 טרם תוקן

### S4 — Draft אינו מתיישן
**קובץ:** PreviewScreen.tsx
**תיאור:** טיוטה מלפני חודשים תוטען לדוקומנט חדש לחלוטין, והמשתמש יתבלבל מאיפה הגדרות העיצוב הישנות הגיעו.
**תיקון:** שמירת `timestamp` עם ה-draft; אם גיל הטיוטה > 7 ימים — דלג על טעינה.
**סטטוס:** 🔲 טרם תוקן

### S5 — TextInput לא נסגר אוטומטית
**קובץ:** PreviewScreen.tsx
**תיאור:** אחרי עריכת טקסט, המשתמש צריך ללחוץ ✕ ידנית. לא קיים `onBlur` שסוגר את editMode אוטומטית, ולא קיים `returnKeyType="done"` שסוגר מקלדת.
**תיקון:** הוספת `returnKeyType="done"` + `blurOnSubmit={false}` (כדי ש-multiline ישמור Enter) ו/או `onSubmitEditing={() => setEditMode(false)}`.
**הערה:** ב-multiline RTL ה-done key לא תמיד מופיע — ייתכן שצריך כפתור "סיום" נפרד.
**סטטוס:** 🔲 טרם תוקן

---

## 🟢 שיפורי UX

### U1 — בוחר רקע דף ללא אייקון ויזואלי
**קובץ:** PreviewScreen.tsx (שורות ~941-962)
**תיאור:** כפתורי "שורות/משבצות/חלק" טקסט בלבד — המשתמש חייב לדמיין או לנסות. אייקונים קטנים יקלו.
**תיקון:** הוספת SVG/אייקון קטן לכל כפתור המדמה את דפוס הרקע:
- שורות: 3 קווים אופקיים
- משבצות: גריד 2×2  
- חלק: ריבוע ריק
**סטטוס:** 🔲 טרם תוקן (עיצוב נדרש)

### U2 — סליידרים ללא תוויות קצה סמנטיות
**קובץ:** PreviewScreen.tsx
**תיאור:** הסליידרים מציגים מספרים (0-100) בלבד. עבור "ריווח אות" אין אינדיקציה שאפס הוא חפיפה ו-100 הוא רחב. עבור "ריקוד" אין אינדיקציה שאפס הוא ישר מושלם.
**תיקון אפשרי:** הוספת תוויות מינימום/מקסימום:
```
ריווח אות: [צפוף] ←──────────→ [רחב]
ריקוד: [ישר] ←──────────→ [קפצני]
נטייה: [ישר] ←──────────→ [נוטה]
```
**סטטוס:** 🔲 טרם תוקן

### U3 — אין איפוס לברירות מחדל לסליידר בודד
**קובץ:** PreviewScreen.tsx
**תיאור:** משתמש שגרר סליידר ל"שגוי" לא יכול לאפסו בקלות — צריך לזכור ערך ברירת המחדל.
**תיקון אפשרי:** לחיצה ארוכה על label או thumb → reset לברירת מחדל + haptic.
**סטטוס:** 🔲 טרם תוקן (נדרש UX design)

### U4 — Loading indicator בזמן עריכת טקסט
**קובץ:** PreviewScreen.tsx
**תיאור:** כאשר המשתמש מקליד תו חדש ואין לו glyph במאגר, נשלחת קריאה ל-`/glyphs` (debounced 400ms). אין שום אינדיקציה שהתו "בטעינה" — הוא פשוט מוצג בגופן רגיל ואז "קופץ" לגופן כתב יד.
**תיקון אפשרי:** שמירת `loadingChars: Set<string>` + rendering קצר של spinner על גלף בטעינה.
**סטטוס:** 🔲 טרם תוקן

---

## ✅ מה תוקן בסשן זה (2026-06-13)

| # | תיאור | קובץ |
|---|-------|------|
| F1 | `slant` + `inkBlobs` לא התאפסו מ-initStyle — hardcoded 15/10 | PreviewScreen.tsx |
| F2 | `inkBlobs` max 0.30 → 0.20 (`s×0.003` → `s×0.002`) | Preview + FinalView |
| F3 | `letterSpacing` EditorScreen default שגוי: 4px → 9px (טבעי) | EditorScreen.tsx |
| F4 | `wordSpacing` EditorScreen default שגוי: 35px → 42px | EditorScreen.tsx |
| F5 | EditorScreen העביר `slant=0, inkBlobs=0` → PreviewScreen הציג 15/10 | EditorScreen.tsx |
| F6 | הוספת comment מפורט לברירות מחדל ב-EditorScreen | EditorScreen.tsx |

---

## 📋 עקביות נוסחאות (מאומת)

כל 3 נתיבי ה-backend מקבלים ערכים זהים:

```typescript
// /layout (PreviewScreen, liveHs — תוך כדי גרירה)
char_height:     Math.round(40 + liveHs.charHeight * 0.9),
letter_spacing:  liveHs.letterSpacing * 0.30 - 8,
word_spacing:    Math.round(liveHs.wordSpacing * 0.85),
baseline_jitter: liveHs.baselineJitter * 0.25,   // ← שנה ל-0.15 אחרי B1
slant:           liveHs.slant * 0.4,
ink_blobs:       liveHs.inkBlobs * 0.002,

// /convert-both (PreviewScreen, hs — אחרי debounce)
// זהה בדיוק עם hs במקום liveHs ✓

// /finalize (FinalViewScreen, style)
// זהה בדיוק ✓
```

---

## 📊 ניתוח טווחי סליידרים (synthesizer.py)

### charHeight (40-130px)
- backend default: `_TARGET_CHAR_H = 80px`
- על מסך (notebookW≈350px): `80 × 350/2480 ≈ 11px display` — קריא
- מינימום (40px): `40 × 350/2480 ≈ 5.6px` — לא קריא! → ראה B2
- מקסימום (130px): `130 × 350/2480 ≈ 18px` — כתיבה גדולה, נורמלי

### letterSpacing (-8 to +22px)
- backend clamp: `max(-avg_glyph_w * 0.25, value)` ≈ max(-15.5px, value)
- אפס (slider=27): אותיות צמודות בדיוק
- שלילי (slider<27): חפיפה — אפקט קליגרפי תקין, מוגבל
- טבעי (~9px, slider≈57): כ-15% מרוחב הגליף — טבעי לכתב יד

### wordSpacing (0-85px)
- backend default (ללא style): `avg_glyph_w × 1.0 ≈ 62px`
- ב-plan_paragraph: sigma=15% × word_sp_base → variation ±15%
- slider=0 → 0px: מילים נוגעות → ראה S2
- slider=49: 42px → פרק קריא

### baselineJitter (0-25% σ) — **יש לשנות ל-0-15%** (B1)
- backend: `gauss(0, char_height × jitter_pct/100)`
- עבור char_height=85px:
  - slider=12 (default): σ=3px → קפיצה עדינה מאוד ✓
  - slider=50: σ=10.6px → נראה כמו כתב יד טבעי
  - slider=100 (כיום 25%): σ=21px → כתב יד שיכור מדי ✗
  - slider=100 (אחרי תיקון 15%): σ=12.75px → חי אבל שמיש ✓

### slant (0-40px line-tilt)
- `line_tilt()`: per-line random direction × 0.6–1.4 variation
- slider≤1 (≤0.4px): ישר מושלם (threshold ≤0.5)
- slider=15 (6px): ±3.6 to ±8.4px per line → נטייה עדינה וטבעית ✓
- slider=100 (40px): ±24 to ±56px — גלי בולט אבל לא קיצוני
- **הטווח הגיוני ✓**

### inkBlobs (0-0.20 probability)
- הסתברות ש-glyph יקבל blob; כשמופעל: 1-2 blobs ברנדום
- blob size: `randint(glyph_h//10, glyph_h//5)` = 8.5-17px (עבור 85px glyph)
- slider=10 (default, 2%): כ-1 blob כל 50 תווים — עדין ✓
- slider=50 (10%): ~7 blobs ב-70-תו משפט — נראה כמו עט שמנוני
- slider=100 (20%): ~14 blobs — אפקט "דיו רב" מוגזם אך שמיש לאמנות

---

## 🏗️ עדיפויות לספרינט הבא

| עדיפות | # | משימה | מורכבות |
|--------|---|-------|---------|
| ✅ בוצע | B1 | תקן baselineJitter: `×0.25` → `×0.15` | S |
| ✅ בוצע | B2 | `min=20` לסליידר charHeight, `min=5` לwordSpacing | S |
| ✅ בוצע | B3 | תקן accessibilityHint עורך טקסט | XS |
| ✅ בוצע | S1 | הוסף מונה תווים לעורך (`len/MAX`) | XS |
| ✅ בוצע | S2 | `minimumValue={5}` לסליידר wordSpacing | XS |
| 🟡 חשוב | S3 | user-scope את DRAFT_KEY | S |
| 🟡 חשוב | S4 | הוסף תאריך תפוגה ל-draft (7 ימים) | S |
| 🟢 שיפור | S5 | סגירה אוטומטית של עורך הטקסט | S |
| 🟢 שיפור | U1 | אייקונים לבוחר רקע | M |
| 🟢 שיפור | U2 | תוויות קצה סמנטיות לסליידרים | S |
| 🟢 שיפור | U3 | Long-press לאיפוס סליידר בודד | M |
| 🟢 שיפור | U4 | Spinner על תווים בטעינה מ-/glyphs | M |
