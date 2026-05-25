import React, { useMemo, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { fonts, radius, shadow } from '../src/theme';
import { auth } from '../src/services/firebase';
import { getAuthToken } from '../src/utils/api';
import { BACKEND_URL } from '../src/config';
import { impactLight } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const { colors, theme, toggleTheme } = useTheme();
  const [resetting, setResetting] = useState(false);
  const styles = useMemo(() => getStyles(colors), [colors]);

  const uid = auth.currentUser?.uid ?? 'anonymous';

  const handleReset = () => {
    Alert.alert(
      'איפוס כתב יד',
      'פעולה זו תמחק את כל דגימות כתב היד שנסרקו. לא ניתן לבטל. האם להמשיך?',
      [
        { text: 'ביטול', style: 'cancel' },
        {
          text: 'אפס הכל',
          style: 'destructive',
          onPress: async () => {
            setResetting(true);
            try {
              const token = await getAuthToken();
              const res = await fetch(`${BACKEND_URL}/bank/${uid}`, {
                method: 'DELETE',
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (!res.ok) throw new Error(`שגיאת שרת (${res.status})`);
              await AsyncStorage.setItem('character_status', JSON.stringify({}));
              Alert.alert('הושלם', 'כתב היד אופס בהצלחה. תוכל לסרוק מחדש.');
            } catch {
              Alert.alert('שגיאה', 'האיפוס נכשל. נסה שנית.');
            } finally {
              setResetting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Theme section ─────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>מצב תצוגה</Text>
        <View style={styles.card}>
          <View style={styles.themeRow}>
            <Pressable
              style={({ pressed }) => [
                styles.themeOption,
                theme === 'light' && styles.themeOptionActive,
                { borderColor: theme === 'light' ? colors.accent : colors.border },
                pressed && theme !== 'light' && { opacity: 0.7, transform: [{ scale: 0.97 }] },
              ]}
              onPress={() => { if (theme !== 'light') { impactLight(); toggleTheme(); } }}
              accessibilityRole="button"
              accessibilityLabel="מצב בהיר"
              accessibilityHint="עבור לתצוגה בהירה"
              accessibilityState={{ selected: theme === 'light' }}
            >
              <Text style={styles.themeIcon}>☀</Text>
              <Text style={[
                styles.themeLabel,
                { color: theme === 'light' ? colors.accent : colors.inkMid },
              ]}>
                בהיר
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.themeOption,
                theme === 'dark' && styles.themeOptionActive,
                { borderColor: theme === 'dark' ? colors.accent : colors.border },
                pressed && theme !== 'dark' && { opacity: 0.7, transform: [{ scale: 0.97 }] },
              ]}
              onPress={() => { if (theme !== 'dark') { impactLight(); toggleTheme(); } }}
              accessibilityRole="button"
              accessibilityLabel="מצב כהה"
              accessibilityHint="עבור לתצוגה כהה"
              accessibilityState={{ selected: theme === 'dark' }}
            >
              <Text style={styles.themeIcon}>◗</Text>
              <Text style={[
                styles.themeLabel,
                { color: theme === 'dark' ? colors.accent : colors.inkMid },
              ]}>
                כהה
              </Text>
            </Pressable>
          </View>
        </View>

        {/* ── Handwriting reset section ─────────────────────────────────── */}
        <Text style={styles.sectionLabel}>כתב יד</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [
              styles.resetRow,
              pressed && { backgroundColor: colors.bgPage },
            ]}
            onPress={handleReset}
            disabled={resetting}
            accessibilityRole="button"
            accessibilityLabel={resetting ? 'מאפס...' : 'איפוס מלא של כתב היד'}
            accessibilityHint="מחיקה לצמיתות של כל הדגימות שצולמו. הפעולה דורשת אישור"
            accessibilityState={{ disabled: resetting, busy: resetting }}
          >
            <View style={styles.resetInner}>
              {resetting ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <Text style={[styles.resetLabel, { color: colors.danger }]}>
                  איפוס מלא של כתב היד
                </Text>
              )}
              <Text style={[styles.resetArrow, { color: colors.inkFaint }]}>←</Text>
            </View>
            <Text style={[styles.resetSub, { color: colors.inkLight }]}>
              מחיקת כל הדגימות שנסרקו
            </Text>
          </Pressable>
        </View>

        {/* ── Rate the app ──────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>כללי</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
            onPress={async () => {
              impactLight();
              try {
                if (await StoreReview.hasAction()) {
                  await StoreReview.requestReview();
                  return;
                }
              } catch {}
              // Fallback: open the store listing directly
              const url = Platform.OS === 'ios'
                ? 'itms-apps://itunes.apple.com/app/idYOUR_APPLE_ID?action=write-review'
                : 'market://details?id=com.roey.handscript';
              Linking.openURL(url).catch(() => {
                Alert.alert(
                  'תודה!',
                  'הדירוג זמין רק מתוך חנות האפליקציות. נסה שוב אחרי שתתקין מהחנות.',
                  [{ text: 'אישור' }],
                );
              });
            }}
            accessibilityRole="button"
            accessibilityLabel="דרג את האפליקציה"
            accessibilityHint="פותח את חלון הדירוג בחנות"
          >
            <Text style={styles.legalArrow}>←</Text>
            <Text style={styles.legalLabel}>דרג את האפליקציה</Text>
          </Pressable>
        </View>

        {/* ── Legal section ─────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>משפטי</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
            onPress={() => { impactLight(); navigation.navigate('PrivacyPolicy'); }}
            accessibilityRole="button"
            accessibilityLabel="מדיניות פרטיות"
          >
            <Text style={styles.legalArrow}>←</Text>
            <Text style={styles.legalLabel}>מדיניות פרטיות</Text>
          </Pressable>
          <View style={styles.legalDivider} />
          <Pressable
            style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
            onPress={() => { impactLight(); navigation.navigate('TermsOfService'); }}
            accessibilityRole="button"
            accessibilityLabel="תנאי שימוש"
          >
            <Text style={styles.legalArrow}>←</Text>
            <Text style={styles.legalLabel}>תנאי שימוש</Text>
          </Pressable>
          <View style={styles.legalDivider} />
          <Pressable
            style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
            onPress={() => { impactLight(); navigation.navigate('Contact'); }}
            accessibilityRole="button"
            accessibilityLabel="יצירת קשר"
          >
            <Text style={styles.legalArrow}>←</Text>
            <Text style={styles.legalLabel}>יצירת קשר</Text>
          </Pressable>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe:   { flex: 1, backgroundColor: colors.bgPage },
    scroll: { paddingHorizontal: 16, paddingTop: 8 },

    sectionLabel: {
      fontSize:         11,
      fontFamily:       fonts.bold,
      color:            colors.inkLight,
      letterSpacing:    0.8,
      textTransform:    'uppercase',
      textAlign:        'right',
      writingDirection: 'rtl' as const,
      marginTop:        24,
      marginBottom:     8,
    },
    card: {
      backgroundColor: colors.bgSurface,
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     colors.border,
      overflow:        'hidden' as const,
      ...shadow.card,
    },

    themeRow: {
      flexDirection: 'row' as const,
      padding:       12,
      gap:           10,
    },
    themeOption: {
      flex:            1,
      alignItems:      'center' as const,
      justifyContent:  'center' as const,
      paddingVertical: 18,
      borderRadius:    radius.md,
      borderWidth:     2,
      backgroundColor: colors.bgPage,
      gap:             6,
    },
    themeOptionActive: {
      backgroundColor: colors.accentLight,
    },
    themeIcon:  { fontSize: 24, color: colors.inkMid },
    themeLabel: {
      fontSize:   14,
      fontFamily: fonts.semiBold,
    },

    resetRow: {
      paddingHorizontal: 18,
      paddingVertical:   16,
    },
    resetInner: {
      flexDirection:  'row' as const,
      alignItems:     'center' as const,
      justifyContent: 'space-between' as const,
    },
    resetLabel: {
      fontSize:         15,
      fontFamily:       fonts.semiBold,
      writingDirection: 'rtl' as const,
      textAlign:        'right' as const,
    },
    resetArrow: { fontSize: 16 },
    resetSub: {
      fontSize:         12,
      fontFamily:       fonts.regular,
      textAlign:        'right' as const,
      writingDirection: 'rtl' as const,
      marginTop:        4,
    },

    legalRow: {
      paddingHorizontal: 18,
      paddingVertical:   17,
      flexDirection:     'row' as const,
      alignItems:        'center' as const,
      justifyContent:    'space-between' as const,
      minHeight:         54,
    },
    legalRowPressed: {
      backgroundColor: colors.bgPage,
    },
    legalLabel: {
      fontSize:         15,
      fontFamily:       fonts.semiBold,
      color:            colors.inkDark,
      writingDirection: 'rtl' as const,
    },
    legalArrow: {
      fontSize: 16,
      color:    colors.inkFaint,
    },
    legalDivider: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
      marginHorizontal: 16,
    },
  });
}
