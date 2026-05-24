import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { signUpWithEmail, signInWithEmail } from '../src/services/auth';
import { fonts, radius } from '../src/theme';
import { useTheme } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

export default function OnboardingScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [mode,     setMode]     = useState<'signin' | 'signup'>('signin');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const logoAnim  = useRef(new Animated.Value(0)).current;
  const textAnim  = useRef(new Animated.Value(0)).current;
  const formAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(80, [
      Animated.spring(logoAnim, { toValue: 1, tension: 60, friction: 9, useNativeDriver: true }),
      Animated.spring(textAnim, { toValue: 1, tension: 60, friction: 9, useNativeDriver: true }),
      Animated.spring(formAnim, { toValue: 1, tension: 60, friction: 9, useNativeDriver: true }),
    ]).start();
  }, []);

  function translateFirebaseError(code: string): string {
    switch (code) {
      case 'auth/email-already-in-use':    return 'כתובת האימייל כבר רשומה במערכת';
      case 'auth/invalid-email':           return 'כתובת אימייל לא תקינה';
      case 'auth/weak-password':           return 'הסיסמה חייבת להכיל לפחות 6 תווים';
      case 'auth/user-not-found':          return 'משתמש עם אימייל זה לא קיים';
      case 'auth/wrong-password':          return 'הסיסמה שגויה';
      case 'auth/invalid-credential':      return 'אימייל או סיסמה שגויים';
      case 'auth/too-many-requests':       return 'יותר מדי ניסיונות. נסה שוב מאוחר יותר';
      case 'auth/network-request-failed':  return 'שגיאת רשת. בדוק את החיבור לאינטרנט';
      default:                             return 'שגיאה בהתחברות. נסה שנית';
    }
  }

  async function handleSubmit() {
    if (!email.trim() || !password) {
      setError('יש למלא אימייל וסיסמה');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      if (mode === 'signup') {
        await signUpWithEmail(email.trim(), password);
      } else {
        await signInWithEmail(email.trim(), password);
      }
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'שגיאה בהתחברות. נסה שנית');
    } finally {
      setLoading(false);
    }
  }

  function toggleMode() {
    setMode(m => m === 'signin' ? 'signup' : 'signin');
    setError(null);
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.safe}>

        {/* ── Hero ──────────────────────────────────────────────────── */}
        <View style={styles.hero}>
          <View style={styles.heroLines} pointerEvents="none">
            {[0,1,2,3,4,5,6,7].map(i => (
              <View key={i} style={styles.heroLine} />
            ))}
          </View>

          <Animated.View style={{
            opacity: logoAnim,
            transform: [{ scale: logoAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
            zIndex: 2,
          }}>
            <View style={styles.logoStamp}>
              <Text style={styles.logoGlyph}>ח</Text>
              <View style={styles.logoStampRing} />
            </View>
          </Animated.View>

          <Animated.View style={{
            opacity: textAnim,
            transform: [{ translateY: textAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            alignItems: 'center',
            zIndex: 2,
          }}>
            <Text style={styles.appName}>HandScript</Text>
            <View style={styles.taglineRow}>
              <View style={styles.taglineDash} />
              <Text style={styles.tagline}>כתב יד אישי, דיגיטלי</Text>
              <View style={styles.taglineDash} />
            </View>
          </Animated.View>
        </View>

        {/* ── Form card ─────────────────────────────────────────────── */}
        <Animated.View style={[styles.formCard, {
          opacity: formAnim,
          transform: [{ translateY: formAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
        }]}>

          <View style={styles.modeTabs}>
            <Pressable
              style={[styles.modeTab, mode === 'signin' && styles.modeTabActive]}
              onPress={() => { if (mode !== 'signin') { impactLight(); toggleMode(); } }}
            >
              <Text style={[styles.modeTabText, mode === 'signin' && styles.modeTabTextActive]}>
                התחברות
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modeTab, mode === 'signup' && styles.modeTabActive]}
              onPress={() => { if (mode !== 'signup') { impactLight(); toggleMode(); } }}
            >
              <Text style={[styles.modeTabText, mode === 'signup' && styles.modeTabTextActive]}>
                הרשמה
              </Text>
            </Pressable>
          </View>

          <View style={styles.formFields}>

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
                editable={!loading}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>סיסמה</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={t => { setPassword(t); setError(null); }}
                placeholder="לפחות 6 תווים"
                placeholderTextColor="rgba(255,255,255,0.3)"
                secureTextEntry
                textAlign="right"
                editable={!loading}
              />
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.submitBtn,
                loading && styles.submitBtnOff,
                !loading && pressed && { transform: [{ scale: 0.97 }], opacity: 0.9 },
              ]}
              onPress={() => { impactMedium(); handleSubmit(); }}
              disabled={loading}
            >
              <Text style={styles.submitBtnText}>
                {loading ? 'טוען...' : mode === 'signup' ? 'צור חשבון' : 'כניסה'}
              </Text>
            </Pressable>

            {mode === 'signin' && (
              <Pressable
                style={styles.forgotBtn}
                onPress={() => navigation.navigate('ForgotPassword')}
              >
                <Text style={styles.forgotText}>שכחת סיסמה?</Text>
              </Pressable>
            )}

          </View>
        </Animated.View>

        <View style={{ height: 16 }} />
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
      justifyContent: 'space-between',
    },

    hero: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 24,
      paddingHorizontal: 32,
      overflow: 'hidden',
    },
    heroLines: {
      position: 'absolute',
      left:  0,
      right: 0,
      top:   0,
      bottom: 0,
      justifyContent: 'space-evenly',
    },
    heroLine: {
      height:          StyleSheet.hairlineWidth,
      backgroundColor: 'rgba(255,255,255,0.04)',
    },

    logoStamp: {
      width:           110,
      height:          110,
      borderRadius:    55,
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderWidth:     1.5,
      borderColor:     'rgba(255,255,255,0.14)',
      justifyContent:  'center',
      alignItems:      'center',
      position:        'relative',
    },
    logoStampRing: {
      position:     'absolute',
      width:        126,
      height:       126,
      borderRadius: 63,
      borderWidth:  1,
      borderColor:  'rgba(255,255,255,0.07)',
      borderStyle:  'dashed',
    },
    logoGlyph: {
      fontSize:   54,
      fontFamily: fonts.extraBold,
      color:      '#FFFFFF',
    },

    appName: {
      fontSize:      40,
      fontFamily:    fonts.extraBold,
      color:         '#FFFFFF',
      letterSpacing: -1.5,
      textAlign:     'center',
    },
    taglineRow: {
      flexDirection: 'row',
      alignItems:    'center',
      gap:           10,
      marginTop:     6,
    },
    taglineDash: {
      height:          1,
      width:           32,
      backgroundColor: 'rgba(255,255,255,0.2)',
    },
    tagline: {
      fontSize:   15,
      fontFamily: fonts.regular,
      color:      'rgba(255,255,255,0.5)',
      textAlign:  'center',
      writingDirection: 'rtl',
    },

    formCard: {
      marginHorizontal: 16,
      backgroundColor:  'rgba(255,255,255,0.06)',
      borderRadius:     radius.xl,
      borderWidth:      1,
      borderColor:      'rgba(255,255,255,0.1)',
      overflow:         'hidden',
    },

    modeTabs: {
      flexDirection:   'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'rgba(255,255,255,0.1)',
    },
    modeTab: {
      flex:            1,
      paddingVertical: 16,
      alignItems:      'center',
    },
    modeTabActive: {
      borderBottomWidth: 2,
      borderBottomColor: 'rgba(255,255,255,0.8)',
    },
    modeTabText: {
      fontSize:   15,
      fontFamily: fonts.semiBold,
      color:      'rgba(255,255,255,0.4)',
      writingDirection: 'rtl',
    },
    modeTabTextActive: {
      color: '#FFFFFF',
    },

    formFields: {
      padding: 24,
      gap:     14,
    },
    errorBanner: {
      backgroundColor: 'rgba(185,28,28,0.25)',
      borderRadius:    radius.sm,
      paddingHorizontal: 14,
      paddingVertical:   10,
      borderWidth:      1,
      borderColor:      'rgba(185,28,28,0.5)',
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
      backgroundColor: 'rgba(255,255,255,0.07)',
      borderWidth:     1,
      borderColor:     'rgba(255,255,255,0.12)',
      borderRadius:    radius.md,
      paddingHorizontal: 16,
      paddingVertical:   15,
      fontSize:        16,
      fontFamily:      fonts.regular,
      color:           '#FFFFFF',
      writingDirection: 'rtl',
      minHeight:       52,
    },
    submitBtn: {
      backgroundColor: '#FFFFFF',
      borderRadius:    radius.md,
      paddingVertical: 17,
      alignItems:      'center',
      marginTop:       6,
      shadowColor:     '#000',
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.25,
      shadowRadius:    10,
      elevation:       6,
    },
    submitBtnOff: {
      opacity:       0.5,
      shadowOpacity: 0,
      elevation:     0,
    },
    submitBtnText: {
      fontSize:   17,
      fontFamily: fonts.bold,
      color:      colors.bgDark,
      writingDirection: 'rtl',
      letterSpacing: 0.2,
    },
    forgotBtn: {
      alignItems:      'center',
      paddingVertical: 4,
    },
    forgotText: {
      fontSize:   13,
      fontFamily: fonts.regular,
      color:      'rgba(255,255,255,0.45)',
      writingDirection: 'rtl',
    },
  });
}
