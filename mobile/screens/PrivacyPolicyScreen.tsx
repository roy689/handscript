import React, { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
            תמונות של כתב ידכם — צילומי האותיות שאתם מעלים לאפליקציה לשם בניית מאגר אישי.{'\n\n'}
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
            המידע מועבר ל-Google לצורך עיבוד בלבד ואינו נשמר על ידה לאחר מתן התשובה.
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
            בהתאם לחוק הגנת הפרטיות, תשמ"א-1981 ולתקנות הגנת הפרטיות (אבטחת מידע),
            תש"ף-2017, עומדות לכם הזכויות הבאות:{'\n\n'}
            זכות עיון — תוכלו לבקש לקבל עותק של המידע השמור עליכם.{'\n\n'}
            זכות תיקון — תוכלו לבקש תיקון מידע שגוי.{'\n\n'}
            זכות מחיקה — תוכלו לבקש מחיקת כל המידע שלכם. בקשה תטופל תוך 30 יום.{'\n\n'}
            זכות העברת נתונים — תוכלו לבקש לקבל קובץ עם מאגר כתב ידכם.{'\n\n'}
            זכות התנגדות — תוכלו להתנגד לסוגי עיבוד מסוימים.{'\n\n'}
            לבקשות יש לפנות בדוא"ל: handscriptir@gmail.com
          </Text>
        </View>

        {/* 8 — GDPR */}
        <Text style={styles.sectionTitle}>8. משתמשים מהאיחוד האירופי (GDPR)</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אם אתם אזרחי האיחוד האירופי, חלה עליכם תקנת הגנת המידע הכללית (GDPR).
            הבסיס החוקי לעיבוד מידעכם הוא:{'\n\n'}
            א. ביצוע חוזה — לצורך מתן השירות שביקשתם.{'\n'}
            ב. הסכמה — לגבי עיבוד שאינו נחוץ לביצוע השירות.{'\n'}
            ג. אינטרס לגיטימי — שיפור השירות ואבטחתו.{'\n\n'}
            בנוסף לזכויות המפורטות בסעיף 7, עומדות לכם הזכויות הבאות:{'\n'}
            זכות להגביל עיבוד — זכות לדרוש הפסקת עיבוד מסוים.{'\n'}
            זכות לתלונה — תוכלו לפנות לרשות הגנת המידע הרלוונטית במדינתכם.{'\n\n'}
            רכז הגנת מידע: handscriptir@gmail.com
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
    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe:   { flex: 1, backgroundColor: colors.bgPage },
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
