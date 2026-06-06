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

export default function TermsOfServiceScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.updated}>עדכון אחרון: מאי 2026</Text>
        <Text style={styles.intro}>
          תנאי שימוש אלה ("התנאים") מסדירים את השימוש שלכם בשירות HandScript ("השירות")
          המופעל על ידי HandScript IR ("אנחנו", "אנו"). בשימוש בשירות, אתם מסכימים
          לתנאים אלה במלואם.
        </Text>

        {/* 1 */}
        <Text style={styles.sectionTitle}>1. תיאור השירות</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            HandScript היא אפליקציה המאפשרת למשתמשים ליצור מסמכים ממוחשבים בכתב ידם
            האישי. התהליך כולל:{'\n\n'}
            א. צילום וסריקת דגימות כתב יד אישי (אותיות עבריות ו/או לטיניות).{'\n'}
            ב. הזנת טקסט לעיבוד.{'\n'}
            ג. יצירת מסמך בכתב היד האישי של המשתמש.
          </Text>
        </View>

        {/* 2 */}
        <Text style={styles.sectionTitle}>2. זכאות לשימוש</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            השירות מיועד למשתמשים מגיל 13 ומעלה.{'\n\n'}
            משתמשים מתחת לגיל 13 אינם רשאים להשתמש בשירות ללא הסכמת הורה
            או אפוטרופוס.{'\n\n'}
            בשימוש בשירות, אתם מצהירים כי אתם עומדים בדרישות אלה וכי כל המידע
            שתמסרו הוא מדויק ומעודכן.
          </Text>
        </View>

        {/* 3 */}
        <Text style={styles.sectionTitle}>3. שימוש מותר</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            מותר להשתמש בשירות לצורך:{'\n\n'}
            א. יצירת מסמכים אישיים — מכתבים, הערות, תזכורות, יומנים.{'\n'}
            ב. כרטיסי ברכה ומסמכים לאירועים אישיים.{'\n'}
            ג. שימוש אישי שאינו מסחרי.
          </Text>
        </View>

        {/* 4 */}
        <Text style={styles.sectionTitle}>4. שימוש אסור</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            השימושים הבאים אסורים בהחלט ועלולים לגרור חסימת חשבון ו/או נקיטת הליכים
            משפטיים:{'\n\n'}
            א. זיוף מסמכים רשמיים — לרבות תעודות זהות, דרכונים, צ'קים, חוזים,
            תעודות אקדמיות או כל מסמך ממשלתי.{'\n\n'}
            ב. הצגת כתב יד של אדם אחר — ייצוג מזויף של חתימה או כתב יד לשם הונאה.{'\n\n'}
            ג. הפרת כללי מוסד לימודי — הגשת עבודות אקדמיות המפרות את כללי יושר
            אקדמי של המוסד.{'\n\n'}
            ד. תוכן בלתי חוקי — העלאת תוכן המהווה עבירה פלילית לפי דין ישראלי
            או בינלאומי.{'\n\n'}
            ה. הטרדה ופגיעה — שימוש בשירות להטרדה, איום, גזענות, הסתה לאלימות
            או פגיעה בכבוד הזולת.{'\n\n'}
            ו. שימוש מסחרי לא מורשה — מכירה, שיווק או הפצה מסחרית של תוצרי השירות
            ללא רישיון מפורש מאיתנו.{'\n\n'}
            ז. הפרת זכויות יוצרים — שכפול טקסטים המוגנים בזכויות יוצרים ללא
            הרשאת בעל הזכויות.{'\n\n'}
            ח. שימוש אוטומטי — שימוש בכלים אוטומטיים (bots, scrapers) לגישה לשירות
            ללא אישור מפורש.
          </Text>
        </View>

        {/* 5 */}
        <Text style={styles.sectionTitle}>5. כתב יד כנתון רגיש</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            תמונות כתב היד שאתם מעלים עשויות להיחשב כנתון רגיש או ביומטרי
            בחלק ממדינות העולם (לרבות מדינות מסוימות בארה"ב כגון אילינוי,
            טקסס וושינגטון).{'\n\n'}
            אנו מאחסנים את תמונות כתב ידכם אך ורק לצורך מתן השירות שביקשתם
            ולא לכל מטרה אחרת. איננו מעבירים תמונות אלה לצדדים שלישיים
            למטרות מסחריות.{'\n\n'}
            בשימוש בשירות ובהעלאת תמונות כתב יד, אתם מסכימים לעיבוד הנתונים
            הרגישים האמורים לצורכי השירות בלבד, בהתאם למדיניות הפרטיות.
          </Text>
        </View>

        {/* 5b */}
        <Text style={styles.sectionTitle}>5ב. קניין רוחני</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>קניין HandScript IR</Text>
          <Text style={styles.body}>
            כל הזכויות בשירות, לרבות הקוד, העיצוב, הלוגו, האלגוריתמים ותכני
            השירות, שמורות ל-HandScript IR. לא מוענקת לכם כל בעלות בשירות,
            אלא רישיון שימוש מוגבל בלבד.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>קניין המשתמש</Text>
          <Text style={styles.body}>
            כתב ידכם האישי ומאגר האותיות שלכם שייכים לכם בלבד.{'\n\n'}
            המסמכים שאתם יוצרים בשירות שייכים לכם.{'\n\n'}
            אנו מעניקים לכם רישיון שימוש בשירות שהוא:{'\n'}
            - לא בלעדי{'\n'}
            - בלתי ניתן להעברה{'\n'}
            - ניתן לביטול{'\n'}
            - לשימוש אישי בלבד
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>שימוש לשיפור השירות</Text>
          <Text style={styles.body}>
            אנו עשויים לעשות שימוש בנתונים אנונימיים ומצורפים (ללא פרטים מזהים)
            לצורך שיפור אלגוריתמי הזיהוי. לא ייעשה שימוש בכתב ידכם האישי
            ללא הסכמתכם.
          </Text>
        </View>

        {/* 6 */}
        <Text style={styles.sectionTitle}>6. תנאי תשלום ותכנית החינמית</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            השירות מוצע בתכנית בסיסית חינמית הכוללת מספר המרות יומי מוגבל.{'\n\n'}
            תכנית Pro (בתשלום) תציע מכסה מורחבת. תנאי התשלום יפורסמו בעת
            השקת התכנית.{'\n\n'}
            אין החזרים על שימוש שכבר בוצע, למעט כנדרש על פי דין.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>רכישות דרך חנות האפליקציות</Text>
          <Text style={styles.body}>
            רכישות ומנויים המבוצעים דרך Apple App Store מתנהלות אך ורק לפי
            תנאי Apple ומדיניות החזר הכספי שלה. ביטול מנוי פעיל יש לבצע
            דרך הגדרות החשבון ב-App Store, ולא דרך מסך ההגדרות של האפליקציה.{'\n\n'}
            רכישות ומנויים המבוצעים דרך Google Play מתנהלות אך ורק לפי
            תנאי Google. ביטול מנוי יש לבצע דרך Google Play.{'\n\n'}
            מנוי Pro מתחדש אוטומטית עד לביטולו. יש לבטל לפחות 24 שעות לפני
            מועד החידוש כדי למנוע חיוב נוסף.{'\n\n'}
            תנאי Apple: apple.com/legal/internet-services/itunes/il/terms.html{'\n'}
            תנאי Google Play: play.google.com/intl/en_us/about/play-terms/index.html
          </Text>
        </View>

        {/* 7 */}
        <Text style={styles.sectionTitle}>7. הגבלת אחריות</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>השירות ניתן כמות שהוא (AS IS)</Text>
          <Text style={styles.body}>
            השירות מסופק ללא כל אחריות מפורשת או משתמעת, לרבות ביחס לזמינות,
            דיוק התוצאות, התאמה לצורך מסוים, או אי-הפרת זכויות צד שלישי.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>הגבלת נזקים</Text>
          <Text style={styles.body}>
            בכפוף לחריגים המפורטים להלן, אחריותנו המצטברת כלפיכם בגין כל תביעה
            הנובעת מהשירות לא תעלה על הסכום ששילמתם לנו במהלך 12 החודשים
            שקדמו לאירוע המזכה, ובכל מקרה לא יותר מ-50 דולר ארה"ב.{'\n\n'}
            איננו אחראים לנזקים עקיפים, תוצאתיים, עונשיים או מיוחדים, לרבות
            אובדן נתונים, הפסד הכנסה או פגיעה במוניטין, גם אם הוזהרנו מראש
            לגבי אפשרות נזקים כאלה.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>חריגים</Text>
          <Text style={styles.body}>
            הגבלת האחריות לא תחול במקרים של:{'\n'}
            א. רשלנות חמורה או מעשה מכוון מצדנו.{'\n'}
            ב. פגיעה גופנית.{'\n'}
            ג. מקרים שבהם הגבלת אחריות אסורה על פי הדין החל.
          </Text>
        </View>

        {/* 8 */}
        <Text style={styles.sectionTitle}>8. שיפוי</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אתם מסכימים לשפות, להגן ולפצות את HandScript IR, מנהליה, עובדיה
            ושותפיה מכל תביעה, נזק, הוצאה (לרבות שכר טרחת עורכי דין) הנובעים
            מ:{'\n\n'}
            א. הפרת תנאים אלה על ידיכם.{'\n'}
            ב. הפרת זכויות צד שלישי, לרבות זכויות יוצרים.{'\n'}
            ג. שימוש בשירות בניגוד לחוק החל.{'\n'}
            ד. כל תוכן שהעליתם לשירות.
          </Text>
        </View>

        {/* 9 */}
        <Text style={styles.sectionTitle}>9. הפסקת שירות וחסימת חשבון</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>מצדנו</Text>
          <Text style={styles.body}>
            אנו רשאים להשעות או לסיים חשבון משתמש שהפר את תנאי השימוש, ללא
            הודעה מוקדמת במקרים חמורים.{'\n\n'}
            אנו רשאים להפסיק את השירות כולו עם הודעה מוקדמת של 30 יום, שתישלח
            לכתובת הדוא"ל הרשומה.{'\n\n'}
            חשבונות שלא היה בהם שימוש במשך 12 חודשים רצופים עשויים להימחק.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>מצדכם</Text>
          <Text style={styles.body}>
            אתם רשאים לסיים את השימוש בשירות בכל עת על ידי מחיקת החשבון
            דרך מסך ההגדרות.{'\n\n'}
            אם נסגור את השירות, תוכלו להוריד את מאגר כתב ידכם לפני
            מועד הסגירה.
          </Text>
        </View>

        {/* 10 */}
        <Text style={styles.sectionTitle}>10. שינויים בתנאים</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            אנו עשויים לשנות תנאים אלה מעת לעת. שינוי מהותי ייידע בדוא"ל לפחות
            30 יום לפני כניסתו לתוקף.{'\n\n'}
            המשך השימוש בשירות לאחר מועד השינוי מהווה הסכמה לתנאים המעודכנים.
            אם אינכם מסכימים לשינוי, תוכלו לסיים את השימוש ולמחוק את חשבונכם.
          </Text>
        </View>

        {/* 11 */}
        <Text style={styles.sectionTitle}>11. הוראות כלליות</Text>
        <View style={styles.card}>
          <Text style={styles.subTitle}>כוח עליון</Text>
          <Text style={styles.body}>
            לא נהיה אחראים לאי-מתן השירות או לעיכוב במתן השירות עקב
            אירועים שמחוץ לשליטתנו הסבירה, לרבות: אסון טבע, מלחמה, מגפה,
            שיבוש בשירותי ענן (כגון Google Firebase), הפסקת שירות של ספק
            תקשורת, פעולות ממשלתיות, או כל גורם חיצוני אחר שלא ניתן לצפות
            מראש ולמנוע בנקיטת אמצעים סבירים.{'\n\n'}
            אם אירוע כוח עליון נמשך מעבר ל-90 יום, כל אחד מהצדדים רשאי לסיים
            את ההתקשרות ללא חבות.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>הדין החל וסמכות שיפוט</Text>
          <Text style={styles.body}>
            תנאים אלה כפופים לדיני מדינת ישראל. כל סכסוך הנובע מתנאים אלה
            או מהשירות יתברר בבתי המשפט המוסמכים במחוז ירושלים, וצדדים לתביעה
            מסכימים בזאת לסמכות שיפוט אישית בבתי משפט אלה.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>שפה</Text>
          <Text style={styles.body}>
            תנאים אלה נכתבו בעברית ובאנגלית. במקרה של סתירה בין הגרסאות,
            הגרסה העברית גוברת.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>ניתוק הוראות</Text>
          <Text style={styles.body}>
            אם הוראה כלשהי בתנאים אלה תימצא בלתי חוקית, בטלה או בלתי ניתנת
            לאכיפה, יראו אותה כנפרדת מיתר ההוראות, אשר תמשכנה לחול במלואן.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subTitle}>הסכם שלם</Text>
          <Text style={styles.body}>
            תנאים אלה, יחד עם מדיניות הפרטיות, מהווים את ההסכם המלא בינינו
            לבינכם ביחס לשירות, ומחליפים כל הסכמה קודמת.
          </Text>
        </View>

        {/* 12 */}
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
      marginBottom:     8,
    },

    intro: {
      fontSize:         14,
      fontFamily:       fonts.regular,
      color:            colors.inkMid,
      lineHeight:       22,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginBottom:     8,
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
