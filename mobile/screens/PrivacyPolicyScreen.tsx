import React, { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AdBanner from '../src/components/AdBanner';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { fonts, radius } from '../src/theme';

export default function PrivacyPolicyScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.updated}>עדכון אחרון: מאי 2026</Text>

        {/* 1 */}
        <Text style={styles.sectionTitle}>1. מי אנחנו</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            HandScript IR היא שירות המופעל על ידי רועי מנשה אברהם ואיתמר אהרונוב,
            הר ציון 31, גן יבנה, 7080000, ישראל.{'\n\n'}
            לפניות בנושא פרטיות:{'\n'}
            handscriptir@gmail.com
          </Text>
        </View>

        {/* 2 */}
        <Text style={styles.sectionTitle}>2. המידע שאנו אוספים</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>מידע שאתם מספקים</Text>
          <Text style={styles.body}>
            כתובת דוא"ל — לצורך יצירת חשבון ואימות זהות.{'\n\n'}
            תמונות של כתב ידכם — צילומי האותיות שאתם מעלים לאפליקציה לשם בניית מאגר אישי. שימו לב: תמונות אלה מהוות מידע רגיש ועשויות להיחשב כנתון ביומטרי בחלק ממדינות העולם.{'\n\n'}
            טקסט לעיבוד — הטקסט שאתם מזינים לצורך המרה לכתב יד.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>מידע הנאסף אוטומטית</Text>
          <Text style={styles.body}>
            פרטי מכשיר — דגם הטלפון וגרסת מערכת ההפעלה, לצורך אבחון תקלות.{'\n\n'}
            כתובת IP — לצורך אבטחה ומניעת שימוש לרעה.{'\n\n'}
            נתוני שימוש בסיסיים — מספר המרות יומיות, לצורך ניהול מכסת השימוש.
          </Text>
        </View>

        {/* 3 */}
        <Text style={styles.sectionTitle}>3. מטרות השימוש במידע</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אנו משתמשים במידע שנאסף אך ורק למטרות הבאות:{'\n\n'}
            א. מתן השירות — המרת טקסט לכתב יד על בסיס מאגר האותיות שלכם.{'\n\n'}
            ב. שמירת נתונים — אחסון מאגר כתב היד האישי לשימוש חוזר.{'\n\n'}
            ג. שיפור השירות — ניתוח תקלות ושיפור האלגוריתם (על בסיס נתונים אנונימיים בלבד).{'\n\n'}
            ד. תמיכה טכנית — מענה לפניות משתמשים.{'\n\n'}
            ה. עמידה בדרישות חוקיות — מענה לדרישות רשויות מוסמכות לפי הוראות החוק.
          </Text>
        </View>

        {/* 4 */}
        <Text style={styles.sectionTitle}>4. שיתוף מידע עם צדדים שלישיים</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>ספקי שירות</Text>
          <Text style={styles.body}>
            Firebase (Google LLC) — אחסון נתוני המשתמשים, אימות זהות ואחסון קבצים. Google
            מפעילה הצפנה מלאה at-rest ו-in-transit. מדיניות הפרטיות של Google
            זמינה בכתובת policies.google.com/privacy.{'\n\n'}
            Google Cloud Vision API — זיהוי תמונות של כתב יד לצורך עיבוד האותיות.
            המידע מועבר ל-Google לצורך עיבוד בלבד ואינו נשמר על ידה לאחר מתן התשובה.{'\n\n'}
            Sentry (Functional Software, Inc.) — איסוף דוחות קריסה (crash reports)
            ותקלות טכניות לצורך אבחון ותיקון שגיאות. המידע הנשלח ל-Sentry כולל
            מידע טכני על המכשיר ועל השגיאה בלבד, ולא מידע אישי מזהה. מדיניות
            הפרטיות של Sentry זמינה בכתובת sentry.io/privacy.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>גילוי על פי חוק</Text>
          <Text style={styles.body}>
            אנו עשויים לגלות מידע אם הדבר נדרש על פי צו שיפוטי, דרישת רשות מוסמכת
            או הוראת דין אחרת.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>מה לא נעשה</Text>
          <Text style={styles.body}>
            לא נמכור את המידע שלכם לצדדים שלישיים.{'\n'}
            לא נשתף את המידע שלכם לצורכי פרסום ממוקד ללא הסכמתכם המפורשת.
          </Text>
        </View>

        {/* 4ב */}
        <Text style={styles.sectionTitle}>4ב. העברת מידע מחוץ לישראל</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            נתוניכם מאוחסנים על שרתי Google Firebase הממוקמים בעיקר בארצות
            הברית ובמדינות נוספות בהן פועלת Google. העברת מידע זו נעשית בהתאם
            למנגנוני הגנה מאושרים, לרבות:{'\n\n'}
            סעיפים חוזיים סטנדרטיים (Standard Contractual Clauses) שאושרו
            על ידי הנציבות האירופית, עליהם Google חתומה.{'\n\n'}
            מדיניות Privacy Shield החלופית ו-Data Privacy Framework של Google.{'\n\n'}
            אם אתם מאיחוד האירופי, העברת נתוניכם מבוצעת על בסיס מנגנוני
            GDPR פרק V המאפשרים העברה לארצות שאינן בEEA תוך הגנות מספקות.{'\n\n'}
            לפרטים נוספים: policies.google.com/privacy/frameworks
          </Text>
        </View>

        {/* 5 */}
        <Text style={styles.sectionTitle}>5. תקופת שמירת המידע</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            מאגר כתב היד — נשמר כל עוד החשבון פעיל, או עד למחיקה יזומה על ידיכם.{'\n\n'}
            כתובת דוא"ל — נשמרת כל עוד החשבון קיים במערכת.{'\n\n'}
            לאחר מחיקת חשבון — כלל הנתונים האישיים יימחקו תוך 30 יום ממועד הבקשה,
            למעט מידע שחוק מחייב אותנו לשמור.
          </Text>
        </View>

        {/* 6 */}
        <Text style={styles.sectionTitle}>6. אבטחת המידע</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>אמצעי אבטחה מיושמים</Text>
          <Text style={styles.body}>
            הצפנת TLS — כל התקשורת בין האפליקציה לשרת מוצפנת בפרוטוקול TLS.{'\n\n'}
            הצפנת Firebase — Google מצפינה את הנתונים at-rest ו-in-transit כברירת מחדל.{'\n\n'}
            אימות Firebase ID Token — כל בקשה לשרת מאומתת באמצעות טוקן חתום.{'\n\n'}
            בדיקת בעלות — גישה לנתונים מוגבלת לבעל החשבון בלבד.{'\n\n'}
            הגבלת קצב בקשות (Rate Limiting) — מניעת התקפות אוטומטיות.{'\n\n'}
            אימות קלט (Input Validation) — בדיקת כל נתון שנכנס למערכת.{'\n\n'}
            CORS מוגבל — גישה לשרת מוגבלת לדומיינים מאושרים בלבד.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>הגיבוי</Text>
          <Text style={styles.body}>
            Firebase Firestore כולל גיבויים אוטומטיים המנוהלים על ידי Google.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>הגבלת אחריות לאבטחה</Text>
          <Text style={styles.body}>
            אנו נוקטים באמצעי אבטחה סבירים, אך איננו יכולים להבטיח הגנה מוחלטת
            מפני כל פרצת אבטחה. במקרה של פרצה מהותית, נודיע לכם ולרשות המוסמכת
            בהתאם להוראות החוק.
          </Text>
        </View>

        {/* 7 */}
        <Text style={styles.sectionTitle}>7. הזכויות שלכם</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            בהתאם לחוק הגנת הפרטיות, תשמ"א-1981, תיקון מס' 12 לחוק (תשפ"ג-2023)
            ולתקנות הגנת הפרטיות (אבטחת מידע), תש"ף-2017, עומדות לכם הזכויות הבאות:{'\n\n'}
            זכות עיון — תוכלו לבקש לקבל עותק של המידע השמור עליכם.{'\n\n'}
            זכות תיקון — תוכלו לבקש תיקון מידע שגוי.{'\n\n'}
            זכות מחיקה — תוכלו לבקש מחיקת כל המידע שלכם. בקשה תטופל תוך 30 יום.{'\n\n'}
            זכות העברת נתונים — תוכלו לבקש לקבל קובץ עם מאגר כתב ידכם בפורמט
            נייד (PNG).{'\n\n'}
            זכות התנגדות — תוכלו להתנגד לסוגי עיבוד מסוימים, לרבות עיבוד לצרכי
            שיפור השירות.{'\n\n'}
            זכות לביטול הסכמה — במקרים שבהם הבסיס החוקי לעיבוד הוא הסכמתכם,
            תוכלו לבטל את הסכמתכם בכל עת. ביטול ההסכמה לא ישפיע על חוקיות
            העיבוד שנעשה לפני הביטול. לביטול הסכמה יש למחוק את החשבון
            דרך הגדרות האפליקציה.{'\n\n'}
            זכות הגבלת עיבוד — בנסיבות מסוימות תוכלו לבקש הגבלה של עיבוד
            המידע שלכם (למשל בזמן בחינת בקשת תיקון).{'\n\n'}
            לבקשות יש לפנות בדוא"ל: handscriptir@gmail.com{'\n'}
            על פי תיקון 12 לחוק, בקשות יש לטפל תוך 30 יום, עם אפשרות הארכה
            של 15 ימים נוספים במקרים מורכבים.
          </Text>
        </View>

        {/* 8 — GDPR */}
        <Text style={styles.sectionTitle}>8. משתמשים מהאיחוד האירופי (GDPR)</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אם אתם אזרחי האיחוד האירופי, חלה עליכם תקנת הגנת המידע הכללית
            (GDPR — Regulation (EU) 2016/679).{'\n\n'}
            הבסיס החוקי לעיבוד מידעכם הוא:{'\n'}
            א. ביצוע חוזה (GDPR סעיף 6(1)(ב)) — לצורך מתן השירות שביקשתם.{'\n'}
            ב. הסכמה (GDPR סעיף 6(1)(א)) — לגבי עיבוד שאינו נחוץ לביצוע השירות,
            לרבות עיבוד נתוני כתב יד כמידע ביומטרי.{'\n'}
            ג. אינטרס לגיטימי (GDPR סעיף 6(1)(ו)) — שיפור השירות ואבטחתו.{'\n\n'}
            עיבוד אוטומטי והחלטות אוטומטיות:{'\n'}
            אנו לא מבצעים החלטות אוטומטיות בעלות השפעה משפטית או השפעה דומה
            על המשתמשים (כמשמעות סעיף 22 ל-GDPR). כל עיבוד כתב היד נועד
            אך ורק לייצר פלט ויזואלי עבורכם ואינו משפיע על זכויות, הטבות
            או חובות.{'\n\n'}
            העברה בינלאומית:{'\n'}
            נתוניכם מועברים לארה"ב (Google Firebase) על בסיס סעיפים חוזיים
            סטנדרטיים שאושרו על ידי הנציבות האירופית.{'\n\n'}
            זכות לתלונה — תוכלו לפנות לרשות הגנת המידע הרלוונטית במדינתכם.
            לצרפת: cnil.fr / לגרמניה: bfdi.bund.de / לכל מדינה אחרת:
            edpb.europa.eu/about-edpb/board/members_en{'\n\n'}
            רכז הגנת מידע (DPO): handscriptir@gmail.com
          </Text>
        </View>

        {/* 9 — CCPA */}
        <Text style={styles.sectionTitle}>9. משתמשים מקליפורניה (CCPA)</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אם אתם תושבי קליפורניה, עומדות לכם הזכויות הבאות מכוח ה-CCPA:{'\n\n'}
            זכות לדעת — אילו קטגוריות מידע נאספות ולאיזו מטרה.{'\n'}
            זכות למחיקה — בקשה למחיקת המידע האישי שלכם.{'\n'}
            זכות אי-מכירה — HandScript IR אינה מוכרת מידע אישי לצדדים שלישיים.{'\n\n'}
            לפניות: handscriptir@gmail.com
          </Text>
        </View>

        {/* 10 — Minors */}
        <Text style={styles.sectionTitle}>10. קטינים</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            האפליקציה מיועדת למשתמשים מגיל 13 ומעלה.{'\n\n'}
            קטינים מתחת לגיל 13 אינם רשאים להשתמש בשירות ללא הסכמת הורה או אפוטרופוס.
            אם נודע לנו שנאסף מידע מקטין מתחת לגיל 13 ללא הסכמת הורה, נמחק אותו
            לאלתר.{'\n\n'}
            להורים המבקשים למחוק מידע של קטין: handscriptir@gmail.com
          </Text>
        </View>

        {/* 10ב — Biometric US States */}
        <Text style={styles.sectionTitle}>10ב. משתמשים ממדינות ספציפיות בארה"ב</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>אילינוי (BIPA)</Text>
          <Text style={styles.body}>
            חוק הגנת המידע הביומטרי של אילינוי (Biometric Information Privacy Act)
            עשוי לחול על תמונות כתב יד. בהתאם לחוק זה:{'\n\n'}
            א. אנו אוספים את נתוני כתב ידכם אך ורק לצורך מתן השירות.{'\n'}
            ב. איננו מוכרים, מחכירים, מחליפים, או מרוויחים בדרך אחרת מנתוני
            כתב ידכם.{'\n'}
            ג. נתוני כתב ידכם ייהרסו בתוך שלוש שנים מהאינטראקציה האחרונה
            שלכם עם האפליקציה, או עם מחיקת חשבונכם — המוקדם מביניהם.{'\n'}
            ד. לשאלות בדבר BIPA: handscriptir@gmail.com
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>טקסס וושינגטון</Text>
          <Text style={styles.body}>
            חוקי הגנת מידע ביומטרי של טקסס וושינגטון מעניקים זכויות דומות.
            לבקשות מחיקה או שאלות: handscriptir@gmail.com
          </Text>
        </View>

        {/* 11 — Changes */}
        <Text style={styles.sectionTitle}>11. שינויים במדיניות</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אנו עשויים לעדכן מדיניות זו מעת לעת. שינוי מהותי ייידע בדוא"ל לפחות 30
            יום לפני כניסתו לתוקף. המשך השימוש בשירות לאחר מועד השינוי מהווה הסכמה
            למדיניות המעודכנת.
          </Text>
        </View>

        {/* 12 — Contact */}
        <Text style={styles.sectionTitle}>12. יצירת קשר</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            HandScript IR{'\n'}
            רועי מנשה אברהם ואיתמר אהרונוב{'\n'}
            הר ציון 31, גן יבנה, 7080000, ישראל{'\n'}
            handscriptir@gmail.com{'\n'}
            זמן תגובה: עד 7 ימי עסקים
          </Text>
        </View>

        <View style={{ height: 48 }} />
      </ScrollView>
      <AdBanner />
    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe:   { flex: 1, backgroundColor: colors.bgPage, direction: 'rtl' },
    scroll: { paddingHorizontal: 20, paddingTop: 12 },

    updated: {
      fontSize:         11,
      fontFamily:       fonts.regular,
      color:            colors.inkFaint,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginBottom:     20,
    },

    sectionTitle: {
      fontSize:         15,
      fontFamily:       fonts.bold,
      color:            colors.inkDark,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginTop:        24,
      marginBottom:     8,
    },

    card: {
      backgroundColor:   colors.bgSurface,
      borderRadius:      radius.lg,
      borderWidth:       1,
      borderColor:       colors.border,
      paddingHorizontal: 16,
      paddingVertical:   16,
    },

    subTitle: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.inkMid,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginBottom:     6,
    },

    body: {
      fontSize:         14,
      fontFamily:       fonts.regular,
      color:            colors.inkDark,
      lineHeight:       22,
      textAlign:        'right',
      writingDirection: 'rtl',
    },

    divider: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
      marginVertical:  14,
    },
  });
}
