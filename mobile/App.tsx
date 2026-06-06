import React, { useEffect, useState } from 'react';
import { I18nManager, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { onAuthStateChanged } from './src/services/firebase';
import { setupGlobalErrorHandler } from './src/utils/telemetry';
import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';

SplashScreen.preventAutoHideAsync().catch(() => {});
import {
  useFonts,
  Heebo_400Regular,
  Heebo_600SemiBold,
  Heebo_700Bold,
  Heebo_800ExtraBold,
} from '@expo-google-fonts/heebo';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

// ── Global native crash catcher ────────────────────────────────────────────────
let _globalError: string | null = null;
const _origHandler = (global as any).ErrorUtils?.getGlobalHandler?.();
(global as any).ErrorUtils?.setGlobalHandler?.((error: Error, isFatal: boolean) => {
  _globalError = `[${isFatal ? 'FATAL' : 'ERROR'}] ${error?.message}\n\n${error?.stack ?? ''}`;
  _origHandler?.(error, isFatal);
});
// Persist uncaught errors to AsyncStorage ring buffer for debugging
setupGlobalErrorHandler();

I18nManager.allowRTL(true);
if (!I18nManager.isRTL) {
  I18nManager.forceRTL(true);
  // expo-dev-client supports reloadAsync in dev mode too
  Updates.reloadAsync().catch(() => {});
}


import AsyncStorage                 from '@react-native-async-storage/async-storage';
import type { RootStackParamList } from './navigation/types';
import OnboardingScreen            from './screens/OnboardingScreen';
import TutorialScreen              from './screens/TutorialScreen';
import ForgotPasswordScreen        from './screens/ForgotPasswordScreen';
import VerifyEmailScreen           from './screens/VerifyEmailScreen';
import CharacterListScreen         from './screens/CharacterListScreen';
import CharacterConfigScreen       from './screens/CharacterConfigScreen';
import CharacterCaptureScreen      from './screens/CharacterCaptureScreen';
import CharacterSampleReviewScreen from './screens/CharacterSampleReviewScreen';
import CharacterVariantsScreen     from './screens/CharacterVariantsScreen';
import HandwritingCustomizerScreen from './screens/HandwritingCustomizerScreen';
import CameraScreen                from './screens/CameraScreen';
import ReviewScreen                from './screens/ReviewScreen';
import EditorScreen                from './screens/EditorScreen';
import PreviewScreen               from './screens/PreviewScreen';
import FinalViewScreen             from './screens/FinalViewScreen';
import ProfileScreen               from './screens/ProfileScreen';
import SettingsScreen              from './screens/SettingsScreen';
import PaywallScreen               from './screens/PaywallScreen';
import PrivacyPolicyScreen         from './screens/PrivacyPolicyScreen';
import TermsOfServiceScreen        from './screens/TermsOfServiceScreen';
import TermsAcceptanceScreen, { TERMS_STORAGE_KEY, TERMS_VERSION } from './screens/TermsAcceptanceScreen';
import ContactScreen               from './screens/ContactScreen';
import ErrorBoundary               from './src/components/ErrorBoundary';
import ProfileAvatar               from './src/components/ProfileAvatar';
import { AppAlertHost }            from './src/components/AppAlert';
import AppOpenAdManager            from './src/components/AppOpenAdManager';
import { initAds }                 from './src/services/ads';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { fonts }                   from './src/theme';
import { auth }                    from './src/services/firebase';
import { Ionicons }                from '@expo/vector-icons';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab       = createBottomTabNavigator();
type InitialRoute = keyof RootStackParamList;

// ── Tab icon ──────────────────────────────────────────────────────────────────

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, [IoniconsName, IoniconsName]> = {
  camera:  ['camera',  'camera-outline'],
  pencil:  ['pencil',  'pencil-outline'],
  person:  ['person',  'person-outline'],
};

function TabIcon({ name, focused, color }: { name: string; focused: boolean; color: string }) {
  const [filledIcon, outlineIcon] = TAB_ICONS[name] ?? ['ellipse', 'ellipse-outline'];
  return (
    <Ionicons
      name={focused ? filledIcon : outlineIcon}
      size={focused ? 24 : 22}
      color={color}
    />
  );
}

// ── Bottom tab bar (CharacterList / Editor / Profile) ─────────────────────────
// Lives inside ThemeProvider so useTheme() is safe.
// All deeper screens (CharacterConfig, Preview, etc.) are pushed onto the ROOT
// stack above this component, so the tab bar naturally disappears on those screens.

function MainTabs() {
  const { colors } = useTheme();
  const insets     = useSafeAreaInsets();

  const sharedHeader = {
    headerStyle:         { backgroundColor: colors.bgPage },
    headerTintColor:     colors.accent,
    headerTitleStyle:    {
      fontFamily: fonts.bold,
      color:      colors.inkDark,
      fontSize:   17,
    } as const,
    headerTitleAlign:    'center' as const,
    headerShadowVisible:    false,
    headerBackButtonDisplayMode: 'minimal' as const,
  };

  return (
    <Tab.Navigator
      initialRouteName="CharacterList"
      screenOptions={{
        ...sharedHeader,
        tabBarActiveTintColor:   colors.accent,
        tabBarInactiveTintColor: colors.inkFaint,
        tabBarStyle: {
          backgroundColor: colors.bgSurface,
          borderTopColor:  colors.border,
          borderTopWidth:  StyleSheet.hairlineWidth,
          height:          54 + insets.bottom,
          paddingBottom:   insets.bottom || 8,
          paddingTop:      8,
        },
        tabBarLabelStyle: {
          fontSize:      10,
          fontFamily:    fonts.bold,
          marginTop:     -4,
          letterSpacing: 0.3,
        },
        tabBarIconStyle: {
          marginBottom: 0,
        },
      }}
    >
      <Tab.Screen
        name="Editor"
        component={EditorScreen}
        options={{
          title:        'עורך טקסט',
          tabBarLabel:  'עורך',
          tabBarIcon: ({ focused, color }) => <TabIcon name="pencil" focused={focused} color={color} />,
        }}
      />
      <Tab.Screen
        name="CharacterList"
        component={CharacterListScreen}
        options={{
          title:        'מאגר אותיות',
          tabBarLabel:  'מאגר',
          tabBarIcon: ({ focused, color }) => <TabIcon name="camera" focused={focused} color={color} />,
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title:        'פרופיל',
          tabBarLabel:  'פרופיל',
          tabBarIcon: ({ focused, color }) => <TabIcon name="person" focused={focused} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

// ── Root navigator ────────────────────────────────────────────────────────────

function AppNavigator({ initialRoute }: { initialRoute: InitialRoute }) {
  const { colors } = useTheme();

  const sharedHeader = {
    headerStyle:            { backgroundColor: colors.bgPage },
    headerTintColor:        colors.accent,
    headerTitleStyle:       {
      fontFamily: fonts.bold,
      color:      colors.inkDark,
      fontSize:   17,
    } as const,
    headerTitleAlign:       'center' as const,
    headerShadowVisible:    false,
    headerBackButtonDisplayMode: 'minimal' as const,
    contentStyle:           { backgroundColor: colors.bgPage },
  };

  return (
    <NavigationContainer>
      <RootStack.Navigator
        initialRouteName={initialRoute}
        screenOptions={{
          ...sharedHeader,
        }}
      >
        {/* ── Auth / tabs ─────────────────────────────────────────────── */}
        <RootStack.Screen name="Onboarding"     component={OnboardingScreen}     options={{ headerShown: false }} />
        <RootStack.Screen name="Tutorial"       component={TutorialScreen}       options={{ headerShown: false, gestureEnabled: false }} />
        <RootStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} options={{ title: 'איפוס סיסמה' }} />
        <RootStack.Screen name="VerifyEmail"    component={VerifyEmailScreen}    options={{ headerShown: false, gestureEnabled: false }} />
        <RootStack.Screen name="MainTabs"       component={MainTabs}             options={{ headerShown: false }} />

        {/* ── Character bank flow ─────────────────────────────────────── */}
        <RootStack.Screen name="CharacterConfig"       component={CharacterConfigScreen}       options={{ title: 'הגדרת תו' }} />
        <RootStack.Screen name="CharacterVariants"     component={CharacterVariantsScreen}     options={{ title: 'דגמים שמורים' }} />
        <RootStack.Screen name="HandwritingCustomizer" component={HandwritingCustomizerScreen} options={{ title: 'מכוון כתב היד' }} />
        <RootStack.Screen name="CharacterCapture"      component={CharacterCaptureScreen}      options={{ headerTransparent: true, headerTitle: '', headerTintColor: '#fff' }} />
        <RootStack.Screen name="CharacterSampleReview" component={CharacterSampleReviewScreen} options={{ title: 'סקירת דגימות' }} />
        <RootStack.Screen name="Camera"                component={CameraScreen}                options={{ headerTransparent: true, headerTitle: '', headerTintColor: '#fff' }} />
        <RootStack.Screen name="Review"                component={ReviewScreen}                options={{ title: 'סקירת תווים' }} />

        {/* ── Editor flow ─────────────────────────────────────────────── */}
        <RootStack.Screen name="Preview"  component={PreviewScreen}  options={{ title: 'תצוגה מקדימה' }} />
        <RootStack.Screen name="FinalView" component={FinalViewScreen} options={{ title: 'תוצאה סופית' }} />

        {/* ── Account ─────────────────────────────────────────────────── */}
        <RootStack.Screen name="Settings"       component={SettingsScreen}       options={{ title: 'הגדרות' }} />
        <RootStack.Screen name="Paywall"        component={PaywallScreen}        options={{ title: 'שדרג ל-Pro', presentation: 'modal' }} />

        {/* ── Legal ───────────────────────────────────────────────────── */}
        <RootStack.Screen name="PrivacyPolicy"    component={PrivacyPolicyScreen}    options={{ title: 'מדיניות פרטיות' }} />
        <RootStack.Screen name="TermsOfService"   component={TermsOfServiceScreen}   options={{ title: 'תנאי שימוש' }} />
        <RootStack.Screen name="TermsAcceptance"  component={TermsAcceptanceScreen}  options={{ headerShown: false, gestureEnabled: false }} />
        <RootStack.Screen name="Contact"          component={ContactScreen}          options={{ title: 'יצירת קשר' }} />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  const [fontsLoaded] = useFonts({
    Heebo_400Regular,
    Heebo_600SemiBold,
    Heebo_700Bold,
    Heebo_800ExtraBold,
  });

  const [initialRoute, setInitialRoute] = useState<InitialRoute | null>(null);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const unsub = onAuthStateChanged(auth, async user => {
        // ── Terms of Service gate ──────────────────────────────────────────────
        // Check whether the current version of the TOS has been accepted.
        // This runs for both logged-in and logged-out users so that existing
        // accounts are also prompted once on first launch after the TOS update.
        const termsRaw = await AsyncStorage.getItem(TERMS_STORAGE_KEY).catch(() => null);
        let termsAccepted = false;
        if (termsRaw) {
          try {
            const parsed = JSON.parse(termsRaw) as { version?: string };
            termsAccepted = parsed.version === TERMS_VERSION;
          } catch {
            termsAccepted = false;
          }
        }

        if (!termsAccepted) {
          setInitialRoute('TermsAcceptance');
          return;
        }

        if (user) {
          // Show tutorial only once — on first-ever login after install.
          const seen = await AsyncStorage.getItem('@hs_tutorial_seen').catch(() => '1');
          setInitialRoute(seen ? 'MainTabs' : 'Tutorial');
        } else {
          setInitialRoute('Onboarding');
        }
      });
      return unsub;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setFirebaseError(msg);
    }
  }, []);

  useEffect(() => {
    if (initialRoute !== null && fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [initialRoute, fontsLoaded]);

  // Initialise the Mobile Ads SDK once (no-op in Expo Go / web).
  useEffect(() => {
    initAds();
  }, []);

  // ── Show diagnostic screen if any error was caught ─────────────────────────
  const anyError = _globalError || firebaseError;
  if (anyError) {
    if (__DEV__) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0F172A', padding: 24, paddingTop: 60 }}>
          <ScrollView>
            <Text style={{ color: '#F87171', fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>
              HandScript — שגיאת אבחון
            </Text>
            <Text style={{ color: '#FCA5A5', fontSize: 11, fontFamily: 'monospace', lineHeight: 18 }}>
              {anyError}
            </Text>
            <Text style={{ color: '#6EE7B7', fontSize: 12, marginTop: 24, fontWeight: 'bold' }}>
              Firebase Config:
            </Text>
            <Text style={{ color: '#A7F3D0', fontSize: 10, fontFamily: 'monospace', lineHeight: 16 }}>
              {`apiKey: ${process.env.EXPO_PUBLIC_FIREBASE_API_KEY ? 'set' : 'MISSING'}\nprojectId: ${process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ? 'set' : 'MISSING'}\nbackend: ${process.env.EXPO_PUBLIC_BACKEND_URL ? 'set' : 'MISSING'}`}
            </Text>
          </ScrollView>
        </View>
      );
    }
    // Production: show a friendly error screen without exposing infra details
    return (
      <View style={{ flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
        <Text style={{ color: '#FFFFFF', fontSize: 20, fontWeight: 'bold', textAlign: 'center', marginBottom: 12 }}>
          אירעה שגיאה בלתי צפויה
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
          נסה להפעיל את האפליקציה מחדש. אם הבעיה נמשכת, פנה לתמיכה.
        </Text>
        <Text
          style={{ color: '#93C5FD', fontSize: 14, textDecorationLine: 'underline' }}
          onPress={() => {
            Linking.openURL('mailto:handscriptir@gmail.com?subject=HandScript%20%E2%80%94%20%D7%A9%D7%92%D7%99%D7%90%D7%94%20%D7%91%D7%90%D7%A4%D7%9C%D7%99%D7%A7%D7%A6%D7%99%D7%94').catch(() => {});
          }}
          accessibilityRole="link"
          accessibilityLabel="שלח אימייל לתמיכה"
        >
          handscriptir@gmail.com
        </Text>
      </View>
    );
  }

  if (initialRoute === null || !fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#0F172A' }} />;
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary context="App">
        <ThemeProvider>
          <AppNavigator initialRoute={initialRoute} />
          <AppAlertHost />
          <AppOpenAdManager />
        </ThemeProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
