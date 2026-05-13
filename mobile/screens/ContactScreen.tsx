import React, { useMemo } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { fonts, radius, shadow } from '../src/theme';

const EMAIL = 'handscriptir@gmail.com';

export default function ContactScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const openEmail = (subject: string) => {
    Linking.openURL(
      `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}`,
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >

        {/* Company details */}
        <Text style={styles.sectionLabel}>פרטי החברה</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowVal}>HandScript IR</Text>
            <Text style={styles.rowKey}>שם</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>רועי מנשה אברהם ואיתמר אהרונוב</Text>
            <Text style={styles.rowKey}>מנהלים</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>הר ציון 31, גן יבנה 7080000</Text>
            <Text style={styles.rowKey}>כתובת</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>{EMAIL}</Text>
            <Text style={styles.rowKey}>דוא"ל</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>עד 7 ימי עסקים</Text>
            <Text style={styles.rowKey}>זמן תגובה</Text>
          </View>
        </View>

        {/* Hours */}
        <Text style={styles.sectionLabel}>שעות מענה</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowVal}>09:00 – 18:00</Text>
            <Text style={styles.rowKey}>ראשון – חמישי</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>09:00 – 13:00</Text>
            <Text style={styles.rowKey}>שישי</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowVal}>סגור</Text>
            <Text style={styles.rowKey}>שבת</Text>
          </View>
          <View style={styles.divider} />
          <Text style={styles.note}>
            במקרי חירום (פרצות אבטחה) נענה גם מחוץ לשעות הפעילות.
          </Text>
        </View>

        {/* Quick actions */}
        <Text style={styles.sectionLabel}>פניות</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={() => openEmail('תמיכה טכנית – HandScript')}
          >
            <Text style={styles.actionArrow}>←</Text>
            <Text style={styles.actionLabel}>תמיכה טכנית</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={() => openEmail('בקשת מחיקת נתונים – HandScript')}
          >
            <Text style={styles.actionArrow}>←</Text>
            <Text style={styles.actionLabel}>בקשת מחיקת נתונים</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={() => openEmail('בקשת עיון במידע (GDPR/CCPA) – HandScript')}
          >
            <Text style={styles.actionArrow}>←</Text>
            <Text style={styles.actionLabel}>עיון במידע שלי</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={() => openEmail('דיווח על שימוש לרעה – HandScript')}
          >
            <Text style={styles.actionArrow}>←</Text>
            <Text style={styles.actionLabel}>דיווח על שימוש לרעה</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={() => openEmail('הצעה לשיפור – HandScript')}
          >
            <Text style={styles.actionArrow}>←</Text>
            <Text style={styles.actionLabel}>הצעה לשיפור</Text>
          </Pressable>
        </View>

        {/* Technical support guidance */}
        <Text style={styles.sectionLabel}>תמיכה טכנית – לפני פנייה</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            לפני שליחת הפנייה, מומלץ לנסות:{'\n\n'}
            1. סגירה ופתיחה מחדש של האפליקציה.{'\n'}
            2. בדיקת חיבור לאינטרנט.{'\n'}
            3. עדכון לגרסה האחרונה (App Store / Google Play).{'\n\n'}
            בפנייה לתמיכה, יש לציין:{'\n'}
            - דגם המכשיר וגרסת מערכת ההפעלה.{'\n'}
            - תיאור מפורט של הבעיה.{'\n'}
            - צילום מסך של השגיאה, אם קיים.
          </Text>
        </View>

        {/* Data deletion */}
        <Text style={styles.sectionLabel}>מחיקת חשבון ונתונים</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            מחיקת חשבון מאפליקציה:{'\n'}
            הגדרות &gt; מחק חשבון לצמיתות{'\n\n'}
            מחיקה באמצעות דוא"ל:{'\n'}
            שלחו הודעה ל-{EMAIL} עם כתובת הדוא"ל הרשומה בחשבון. הנתונים יימחקו
            תוך 30 יום.
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

    sectionLabel: {
      fontSize:         11,
      fontFamily:       fonts.bold,
      color:            colors.inkLight,
      letterSpacing:    0.8,
      textTransform:    'uppercase',
      textAlign:        'right',
      writingDirection: 'rtl',
      marginTop:        24,
      marginBottom:     8,
    },

    card: {
      backgroundColor: colors.bgSurface,
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     colors.border,
      overflow:        'hidden',
      ...shadow.card,
    },

    row: {
      paddingHorizontal: 18,
      paddingVertical:   15,
      flexDirection:     'row',
      justifyContent:    'space-between',
      alignItems:        'center',
    },
    rowKey: {
      fontSize:         13,
      fontFamily:       fonts.semiBold,
      color:            colors.inkMid,
      writingDirection: 'rtl',
    },
    rowVal: {
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      colors.inkDark,
      maxWidth:   220,
      textAlign:  'left',
    },

    actionRow: {
      paddingHorizontal: 18,
      paddingVertical:   17,
      flexDirection:     'row',
      alignItems:        'center',
      justifyContent:    'space-between',
      minHeight:         54,
    },
    actionRowPressed: {
      backgroundColor: colors.bgPage,
    },
    actionLabel: {
      fontSize:         15,
      fontFamily:       fonts.semiBold,
      color:            colors.inkDark,
      writingDirection: 'rtl',
    },
    actionArrow: {
      fontSize: 16,
      color:    colors.inkFaint,
    },

    divider: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
      marginHorizontal: 16,
    },

    note: {
      fontSize:         12,
      fontFamily:       fonts.regular,
      color:            colors.inkLight,
      textAlign:        'right',
      writingDirection: 'rtl',
      paddingHorizontal: 18,
      paddingBottom:    14,
    },

    body: {
      fontSize:          14,
      fontFamily:        fonts.regular,
      color:             colors.inkDark,
      lineHeight:        22,
      textAlign:         'right',
      writingDirection:  'rtl',
      paddingHorizontal: 16,
      paddingVertical:   16,
    },
  });
}
