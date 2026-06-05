import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  checkEmailVerification,
  completeSignUp,
  resendVerificationEmail,
  signOut,
} from '../src/services/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fonts, radius } from '../src/theme';
import { useTheme } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';

/** Navigate to Tutorial on first use, MainTabs on return visits. */
async function navigateAfterAuth(navigation: Props['navigation']) {
  const seen = await AsyncStorage.getItem('@hs_tutorial_seen').catch(() => null);
  navigation.reset({ index: 0, routes: [{ name: seen ? 'MainTabs' : 'Tutorial' }] });
}

type Props = NativeStackScreenProps<RootStackParamList, 'VerifyEmail'>;

const RESEND_COOLDOWN = 60; // seconds

export default function VerifyEmailScreen({ route, navigation }: Props) {
  const { email, uid, idToken, refreshToken, expiresIn } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [checking,  setChecking]  = useState(false);
  const [resending, setResending] = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [success,   setSuccess]   = useState(false);

  // Countdown timer for the "resend" button
  const [cooldown,  setCooldown]  = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(fadeAnim, {
      toValue: 1, tension: 55, friction: 9, useNativeDriver: true,
    }).start();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN);
    cooldownRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current!);
          cooldownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function handleCheckVerification() {
    if (checking) return;
    setError(null);
    setChecking(true);
    try {
      const verified = await checkEmailVerification(uid);
      if (verified) {
        setSuccess(true);
        await completeSignUp({ uid, email, idToken, refreshToken, expiresIn, emailVerified: true });
        await navigateAfterAuth(navigation);
      } else {
        setError('המייל עדיין לא אומת. לחץ על הקישור שנשלח אליך ונסה שוב.');
      }
    } catch {
      setError('שגיאה בבדיקת האימות. בדוק את החיבור ונסה שוב.');
    } finally {
      setChecking(false);
    }
  }

  async function handleResend() {
    if (resending || cooldown > 0) return;
    setError(null);
    setResending(true);
    try {
      await resendVerificationEmail(idToken);
      startCooldown();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'שגיאה בשליחת המייל. נסה שוב.');
    } finally {
      setResending(false);
    }
  }

  async function handleBack() {
    impactLight();
    // Don't sign out — no session was saved yet. Just go back to Onboarding.
    navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <Animated.View style={[styles.container, {
        opacity: fadeAnim,
        transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }]}>

        {/* Icon */}
        <View style={styles.iconWrap}>
          <Text style={styles.iconText}>✉️</Text>
        </View>

        {/* Title + description */}
        <Text style={styles.title}>אמת את כתובת המייל שלך</Text>
        <Text style={styles.desc}>
          שלחנו קישור אימות לכתובת
        </Text>
        <Text style={styles.emailText}>{email}</Text>
        <Text style={styles.desc}>
          לחץ על הקישור במייל ולאחר מכן חזור לכאן.
        </Text>
        <Text style={styles.spamNote}>
          לא קיבלת? בדוק גם את תיבת הספאם 📁
        </Text>

        {/* Error banner */}
        {error !== null && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Primary action — check verification */}
        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            (checking || success) && styles.btnDisabled,
            !checking && !success && pressed && { transform: [{ scale: 0.97 }], opacity: 0.9 },
          ]}
          onPress={() => { impactMedium(); handleCheckVerification(); }}
          disabled={checking || success}
          accessibilityRole="button"
          accessibilityLabel={checking ? 'בודק אימות...' : 'כבר אימתתי'}
          accessibilityState={{ disabled: checking || success, busy: checking }}
        >
          <Text style={styles.primaryBtnText}>
            {checking ? 'בודק...' : success ? 'מתחבר...' : 'כבר אימתתי'}
          </Text>
        </Pressable>

        {/* Resend button */}
        <Pressable
          style={({ pressed }) => [
            styles.secondaryBtn,
            (resending || cooldown > 0) && styles.btnDisabled,
            !resending && cooldown === 0 && pressed && { opacity: 0.6 },
          ]}
          onPress={() => { impactLight(); handleResend(); }}
          disabled={resending || cooldown > 0}
          accessibilityRole="button"
          accessibilityLabel={
            cooldown > 0 ? `שלח שוב בעוד ${cooldown} שניות` :
            resending    ? 'שולח...' :
                           'שלח שוב'
          }
          accessibilityState={{ disabled: resending || cooldown > 0 }}
        >
          <Text style={styles.secondaryBtnText}>
            {resending
              ? 'שולח...'
              : cooldown > 0
              ? `שלח שוב (${cooldown})`
              : 'שלח שוב'}
          </Text>
        </Pressable>

        {/* Back to login */}
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.5 }]}
          onPress={handleBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="חזור למסך התחברות"
        >
          <Text style={styles.backText}>חזור להתחברות</Text>
        </Pressable>

      </Animated.View>
    </SafeAreaView>
  );
}

function getStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    safe: {
      flex:            1,
      backgroundColor: colors.bgDark,
    },
    container: {
      flex:              1,
      justifyContent:    'center',
      alignItems:        'center',
      paddingHorizontal: 32,
      gap:               16,
    },

    iconWrap: {
      width:           80,
      height:          80,
      borderRadius:    40,
      backgroundColor: 'rgba(255,255,255,0.08)',
      justifyContent:  'center',
      alignItems:      'center',
      marginBottom:    8,
    },
    iconText: {
      fontSize: 36,
    },

    title: {
      fontSize:         26,
      fontFamily:       fonts.extraBold,
      color:            '#FFFFFF',
      textAlign:        'center',
      writingDirection: 'rtl',
      letterSpacing:    -0.5,
    },
    desc: {
      fontSize:         15,
      fontFamily:       fonts.regular,
      color:            'rgba(255,255,255,0.55)',
      textAlign:        'center',
      writingDirection: 'rtl',
      lineHeight:       22,
    },
    emailText: {
      fontSize:         15,
      fontFamily:       fonts.bold,
      color:            'rgba(255,255,255,0.9)',
      textAlign:        'center',
      marginVertical:   -4,
    },
    spamNote: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            'rgba(255,255,255,0.35)',
      textAlign:        'center',
      writingDirection: 'rtl',
    },

    errorBanner: {
      backgroundColor:   'rgba(185,28,28,0.25)',
      borderRadius:      radius.sm,
      paddingHorizontal: 16,
      paddingVertical:   12,
      borderWidth:       1,
      borderColor:       'rgba(185,28,28,0.5)',
      width:             '100%',
    },
    errorText: {
      fontSize:         13,
      color:            '#FCA5A5',
      textAlign:        'center',
      writingDirection: 'rtl',
      fontFamily:       fonts.regular,
    },

    primaryBtn: {
      backgroundColor: '#FFFFFF',
      borderRadius:    radius.md,
      paddingVertical: 17,
      width:           '100%',
      alignItems:      'center',
      marginTop:       8,
      shadowColor:     '#000',
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.25,
      shadowRadius:    10,
      elevation:       6,
    },
    primaryBtnText: {
      fontSize:         17,
      fontFamily:       fonts.bold,
      color:            colors.bgDark,
      writingDirection: 'rtl',
      letterSpacing:    0.2,
    },

    secondaryBtn: {
      borderWidth:     1,
      borderColor:     'rgba(255,255,255,0.25)',
      borderRadius:    radius.md,
      paddingVertical: 15,
      width:           '100%',
      alignItems:      'center',
    },
    secondaryBtnText: {
      fontSize:         16,
      fontFamily:       fonts.semiBold,
      color:            'rgba(255,255,255,0.75)',
      writingDirection: 'rtl',
    },

    btnDisabled: {
      opacity:       0.45,
      shadowOpacity: 0,
      elevation:     0,
    },

    backBtn: {
      paddingVertical: 8,
      marginTop:       4,
    },
    backText: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            'rgba(255,255,255,0.35)',
      writingDirection: 'rtl',
    },
  });
}
