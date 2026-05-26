import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showAlert } from '../src/utils/alert';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { auth } from '../src/services/firebase';
import { signOut } from '../src/services/auth';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { fonts, radius, shadow } from '../src/theme';
import { BACKEND_URL } from '../src/config';
import { impactLight } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

export default function ProfileScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [user, setUser] = useState(auth.currentUser);
  useEffect(() => auth.onAuthStateChanged(setUser), []);
  const uid  = user?.uid ?? 'anonymous';

  const [signingOut,  setSigningOut]  = useState(false);
  const [deletingAcc, setDeletingAcc] = useState(false);

  const initial = (
    user?.displayName?.[0] ??
    user?.email?.[0] ??
    '?'
  ).toUpperCase();

  const displayName = user?.displayName ?? user?.email?.split('@')[0] ?? 'משתמש';

  const handleSignOut = useCallback(() => {
    showAlert('התנתקות', 'האם אתה בטוח שברצונך להתנתק?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'התנתק',
        style: 'destructive',
        onPress: async () => {
          setSigningOut(true);
          try {
            await signOut();
            navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
          } catch {
            showAlert('שגיאה', 'ההתנתקות נכשלה. נסה שנית.');
          } finally {
            setSigningOut(false);
          }
        },
      },
    ]);
  }, [navigation]);

  const handleDeleteAccount = useCallback(() => {
    showAlert(
      'מחיקת חשבון',
      'פעולה זו בלתי הפיכה. כל הנתונים שלך — כולל כתב היד — יימחקו לצמיתות.',
      [
        { text: 'ביטול', style: 'cancel' },
        {
          text: 'מחק חשבון',
          style: 'destructive',
          onPress: async () => {
            setDeletingAcc(true);
            try {
              const token = await auth.currentUser?.getIdToken();
              const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
              // Delete user data + Firebase Auth account via backend
              const [r1, r2] = await Promise.all([
                fetch(`${BACKEND_URL}/user/${uid}`,      { method: 'DELETE', headers }),
                fetch(`${BACKEND_URL}/auth/account`,     { method: 'DELETE', headers }),
              ]);
              if (!r1.ok || !r2.ok) {
                throw new Error('המחיקה נכשלה. נסו שוב או צרו קשר.');
              }
              await auth.signOut();
              navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
            } catch (err: unknown) {
              showAlert('שגיאה', 'מחיקת החשבון נכשלה. נסה שנית.');
            } finally {
              setDeletingAcc(false);
            }
          },
        },
      ],
    );
  }, [uid, user, navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Identity hero ────────────────────────────────────────────────── */}
        <View style={styles.identityHero}>
          {/* Avatar stamp */}
          <View style={styles.avatarOuter}>
            <View style={styles.avatarInner}>
              <Text style={styles.avatarLetter}>{initial}</Text>
            </View>
            {/* Decorative ink ring */}
            <View style={styles.avatarRingDecor} />
          </View>

          <Text style={styles.displayName}>{displayName}</Text>
          <Text style={styles.emailText}>{user?.email ?? ''}</Text>

          {/* Settings shortcut */}
          <Pressable
            style={({ pressed }) => [
              styles.settingsChip,
              pressed && { opacity: 0.72, transform: [{ scale: 0.97 }] },
            ]}
            onPress={() => { impactLight(); navigation.navigate('Settings'); }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="פתח הגדרות"
            accessibilityHint="עובר למסך הגדרות האפליקציה"
          >
            <Text style={styles.settingsChipText}>הגדרות</Text>
          </Pressable>
        </View>

        {/* ── Info card ────────────────────────────────────────────────────── */}
        {user?.displayName ? (
          <>
            <Text style={styles.sectionLabel}>פרטי חשבון</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowVal} numberOfLines={1}>{user.email ?? '—'}</Text>
                <Text style={styles.rowKey}>דוא״ל</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowVal}>{user.displayName}</Text>
                <Text style={styles.rowKey}>שם</Text>
              </View>
            </View>
          </>
        ) : null}

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>פעולות</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={handleSignOut}
            disabled={signingOut}
            accessibilityRole="button"
            accessibilityLabel={signingOut ? 'מתנתק...' : 'התנתק'}
            accessibilityHint="יציאה מהחשבון. ניתן להיכנס שוב בכל עת"
            accessibilityState={{ disabled: signingOut, busy: signingOut }}
          >
            {signingOut
              ? <ActivityIndicator size="small" color={colors.inkMid} />
              : <Text style={styles.actionLabel}>התנתק</Text>
            }
            <Text style={styles.actionArrow}>←</Text>
          </Pressable>
        </View>

        {/* Danger zone — visually separated */}
        <View style={styles.dangerZone}>
          <Pressable
            style={({ pressed }) => [
              styles.dangerBtn,
              pressed && { opacity: 0.72 },
            ]}
            onPress={handleDeleteAccount}
            disabled={deletingAcc}
            accessibilityRole="button"
            accessibilityLabel={deletingAcc ? 'מוחק חשבון...' : 'מחק חשבון לצמיתות'}
            accessibilityHint="מחיקה לצמיתות של החשבון וכל הנתונים. פעולה בלתי הפיכה ודורשת אישור"
            accessibilityState={{ disabled: deletingAcc, busy: deletingAcc }}
          >
            {deletingAcc
              ? <ActivityIndicator size="small" color={colors.danger} />
              : <Text style={styles.dangerBtnText}>מחק חשבון לצמיתות</Text>
            }
          </Pressable>
          <Text style={styles.dangerNote}>פעולה זו בלתי הפיכה</Text>
        </View>

        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe:   { flex: 1, backgroundColor: colors.bgPage },
    scroll: { paddingHorizontal: 20 },

    // ── Identity hero ─────────────────────────────────────────────────────────
    identityHero: {
      alignItems:    'center',
      paddingTop:    36,
      paddingBottom: 32,
    },
    avatarOuter: {
      position:       'relative',
      width:          96,
      height:         96,
      marginBottom:   16,
      alignItems:     'center',
      justifyContent: 'center',
    },
    avatarInner: {
      width:           88,
      height:          88,
      borderRadius:    44,
      backgroundColor: colors.accentLight,
      borderWidth:     2,
      borderColor:     colors.accent,
      alignItems:      'center',
      justifyContent:  'center',
      ...shadow.medium,
    },
    avatarLetter: {
      fontSize:   36,
      fontFamily: fonts.extraBold,
      color:      colors.accent,
    },
    avatarRingDecor: {
      position:     'absolute',
      width:         96,
      height:         96,
      borderRadius:  48,
      borderWidth:    1,
      borderColor:   colors.border,
      borderStyle:   'dashed',
    },

    displayName: {
      fontSize:   22,
      fontFamily: fonts.bold,
      color:      colors.inkDark,
      writingDirection: 'rtl',
      textAlign:  'center',
      marginBottom: 4,
    },
    emailText: {
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      colors.inkLight,
      textAlign:  'center',
      marginBottom: 16,
    },

    settingsChip: {
      paddingHorizontal: 18,
      paddingVertical:    8,
      borderRadius:      radius.full,
      borderWidth:       1.5,
      borderColor:       colors.border,
      backgroundColor:   colors.bgSurface,
    },
    settingsChipText: {
      fontSize:   13,
      fontFamily: fonts.semiBold,
      color:      colors.inkMid,
      writingDirection: 'rtl',
    },

    // ── Section label ─────────────────────────────────────────────────────────
    sectionLabel: {
      fontSize:      11,
      fontFamily:    fonts.bold,
      color:         colors.inkLight,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      textAlign:     'right',
      writingDirection: 'rtl' as const,
      marginTop:     24,
      marginBottom:  8,
    },

    // ── Cards ────────────────────────────────────────────────────────────────
    card: {
      backgroundColor: colors.bgSurface,
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     colors.border,
      overflow:        'hidden' as const,
      ...shadow.card,
    },
    divider: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
      marginHorizontal: 16,
    },
    row: {
      paddingHorizontal: 18,
      paddingVertical:   16,
      flexDirection:     'row' as const,
      justifyContent:    'space-between' as const,
      alignItems:        'center' as const,
    },
    rowKey: {
      fontSize:   13,
      fontFamily: fonts.semiBold,
      color:      colors.inkMid,
      writingDirection: 'rtl' as const,
    },
    rowVal: {
      fontSize:   14,
      fontFamily: fonts.regular,
      color:      colors.inkDark,
      maxWidth:   200,
      textAlign:  'left' as const,
    },

    // ── Action rows ───────────────────────────────────────────────────────────
    actionRow: {
      paddingHorizontal: 18,
      paddingVertical:   17,
      flexDirection:     'row' as const,
      alignItems:        'center' as const,
      justifyContent:    'space-between' as const,
      minHeight:         54,
    },
    actionRowPressed: {
      backgroundColor: colors.bgPage,
    },
    actionLabel: {
      fontSize:   15,
      fontFamily: fonts.semiBold,
      color:      colors.inkDark,
      writingDirection: 'rtl' as const,
    },
    actionArrow: {
      fontSize: 16,
      color:    colors.inkFaint,
    },

    // ── Danger zone ───────────────────────────────────────────────────────────
    dangerZone: {
      marginTop:  32,
      alignItems: 'center',
      gap:         8,
    },
    dangerBtn: {
      paddingHorizontal: 24,
      paddingVertical:   12,
      borderRadius:      radius.md,
      borderWidth:       1,
      borderColor:       colors.danger,
    },
    dangerBtnText: {
      fontSize:   14,
      fontFamily: fonts.semiBold,
      color:      colors.danger,
      writingDirection: 'rtl' as const,
    },
    dangerNote: {
      fontSize:   11,
      fontFamily: fonts.regular,
      color:      colors.inkFaint,
      writingDirection: 'rtl' as const,
    },
  });
}
