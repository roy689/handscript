import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { resetPassword } from '../src/services/auth';
import { fonts, radius } from '../src/theme';
import { useTheme } from '../src/contexts/ThemeContext';
import { impactMedium } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'ForgotPassword'>;
type Step = 'idle' | 'loading' | 'sent';

export default function ForgotPasswordScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [email,   setEmail]   = useState('');
  const [step,    setStep]    = useState<Step>('idle');
  const [error,   setError]   = useState<string | null>(null);

  const cardAnim = useRef(new Animated.Value(1)).current;

  function translateError(code: string): string {
    switch (code) {
      case 'auth/user-not-found':    return 'כתובת אימייל לא קיימת במערכת';
      case 'auth/invalid-email':     return 'כתובת אימייל לא תקינה';
      case 'auth/too-many-requests': return 'יותר מדי ניסיונות. נסה שוב מאוחר יותר';
      default:                       return 'שגיאה בשליחה. נסה שנית';
    }
  }

  async function handleSend() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('יש להזין כתובת אימייל');
      return;
    }
    setError(null);
    setStep('loading');
    try {
      await resetPassword(trimmed);
      // animate card out then switch to sent state
      Animated.timing(cardAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        setStep('sent');
        Animated.spring(cardAnim, {
          toValue: 1,
          tension: 60,
          friction: 9,
          useNativeDriver: true,
        }).start();
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? '';
      if (__DEV__) console.error('[ForgotPassword] error:', err);
      setError(translateError(code));
      setStep('idle');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.safe}>

        {/* ── Icon ────────────────────────────────────────────────────── */}
        <View style={styles.iconWrap}>
          <Text style={styles.iconGlyph}>✉</Text>
        </View>

        {/* ── Card ────────────────────────────────────────────────────── */}
        <Animated.View style={[styles.card, {
          opacity: cardAnim,
          transform: [{ scale: cardAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }],
        }]}>

          {step !== 'sent' ? (
            <>
              <Text style={styles.title}>איפוס סיסמה</Text>
              <Text style={styles.subtitle}>
                הזן את כתובת האימייל שלך ונשלח לך קישור לאיפוס הסיסמה.
              </Text>

              {error !== null && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>אימייל</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={t => { setEmail(t); setError(null); }}
                  placeholder="your@email.com"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textAlign="right"
                  editable={step === 'idle'}
                />
              </View>

              <Pressable
                style={({ pressed }) => [
                  styles.btn,
                  step !== 'idle' && styles.btnOff,
                  step === 'idle' && pressed && { transform: [{ scale: 0.97 }], opacity: 0.9 },
                ]}
                onPress={() => { impactMedium(); handleSend(); }}
                disabled={step !== 'idle'}
              >
                <Text style={styles.btnText}>
                  {step === 'loading' ? 'שולח...' : 'שלח קישור לאיפוס'}
                </Text>
              </Pressable>

              <Pressable
                style={styles.backLink}
                onPress={() => navigation.goBack()}
              >
                <Text style={styles.backLinkText}>חזרה להתחברות</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.successIcon}>✓</Text>
              <Text style={styles.title}>המייל נשלח!</Text>
              <Text style={styles.subtitle}>
                שלחנו קישור לאיפוס סיסמה לכתובת{'\n'}
                <Text style={styles.emailHighlight}>{email.trim()}</Text>
                {'\n'}בדוק את תיבת הדואר שלך.
              </Text>

              <Pressable
                style={({ pressed }) => [
                  styles.btn,
                  pressed && { transform: [{ scale: 0.97 }], opacity: 0.9 },
                ]}
                onPress={() => navigation.goBack()}
              >
                <Text style={styles.btnText}>חזרה להתחברות</Text>
              </Pressable>
            </>
          )}

        </Animated.View>

        <View style={{ height: 24 }} />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function getStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bgDark,
    },
    safe: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 16,
      gap: 24,
    },

    iconWrap: {
      alignItems: 'center',
    },
    iconGlyph: {
      fontSize:   56,
      color:      'rgba(255,255,255,0.15)',
    },

    card: {
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderRadius:    radius.xl,
      borderWidth:     1,
      borderColor:     'rgba(255,255,255,0.1)',
      padding:         28,
      gap:             16,
    },

    title: {
      fontSize:      22,
      fontFamily:    fonts.bold,
      color:         '#FFFFFF',
      textAlign:     'center',
      writingDirection: 'rtl',
    },
    subtitle: {
      fontSize:      14,
      fontFamily:    fonts.regular,
      color:         'rgba(255,255,255,0.5)',
      textAlign:     'center',
      lineHeight:    21,
      writingDirection: 'rtl',
    },
    emailHighlight: {
      fontFamily: fonts.semiBold,
      color:      'rgba(255,255,255,0.75)',
    },
    successIcon: {
      fontSize:   36,
      color:      '#4ADE80',
      textAlign:  'center',
    },

    errorBanner: {
      backgroundColor:   'rgba(185,28,28,0.25)',
      borderRadius:      radius.sm,
      paddingHorizontal: 14,
      paddingVertical:   10,
      borderWidth:       1,
      borderColor:       'rgba(185,28,28,0.5)',
    },
    errorText: {
      fontSize:   13,
      color:      '#FCA5A5',
      textAlign:  'center',
      writingDirection: 'rtl',
      fontFamily: fonts.regular,
    },

    inputGroup: {
      gap: 6,
    },
    inputLabel: {
      fontSize:      12,
      fontFamily:    fonts.semiBold,
      color:         'rgba(255,255,255,0.5)',
      textAlign:     'right',
      writingDirection: 'rtl',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    input: {
      backgroundColor:   'rgba(255,255,255,0.07)',
      borderWidth:       1,
      borderColor:       'rgba(255,255,255,0.12)',
      borderRadius:      radius.md,
      paddingHorizontal: 16,
      paddingVertical:   15,
      fontSize:          16,
      fontFamily:        fonts.regular,
      color:             '#FFFFFF',
      writingDirection:  'rtl',
      minHeight:         52,
    },

    btn: {
      backgroundColor: '#FFFFFF',
      borderRadius:    radius.md,
      paddingVertical: 17,
      alignItems:      'center',
      shadowColor:     '#000',
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.25,
      shadowRadius:    10,
      elevation:       6,
    },
    btnOff: {
      opacity:       0.5,
      shadowOpacity: 0,
      elevation:     0,
    },
    btnText: {
      fontSize:      17,
      fontFamily:    fonts.bold,
      color:         colors.bgDark,
      writingDirection: 'rtl',
      letterSpacing: 0.2,
    },

    backLink: {
      alignItems: 'center',
      paddingVertical: 4,
    },
    backLinkText: {
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      'rgba(255,255,255,0.4)',
      writingDirection: 'rtl',
    },
  });
}
