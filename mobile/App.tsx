import { I18nManager, StyleSheet } from 'react-native';
I18nManager.forceRTL(true);

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { onAuthStateChanged } from 'firebase/auth';
import {
  useFonts,
  Heebo_400Regular,
  Heebo_600SemiBold,
  Heebo_700Bold,
  Heebo_800ExtraBold,
} from '@expo-google-fonts/heebo';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from './navigation/types';
import OnboardingScreen            from './screens/OnboardingScreen';
import ForgotPasswordScreen        from './screens/ForgotPasswordScreen';
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
import ContactScreen               from './screens/ContactScreen';
import ErrorBoundary               from './src/components/ErrorBoundary';
import ProfileAvatar               from './src/components/ProfileAvatar';
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
    headerShadowVisible:    false,
    headerBackTitleVisible: false,
  };

  return (
    <Tab.Navigator
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
        name="CharacterList"
        component={CharacterListScreen}
        options={{
          title:        'מאגר אותיות',
          tabBarLabel:  'מאגר',
          tabBarIcon: ({ focused, color }) => <TabIcon name="camera" focused={focused} color={color} />,
        }}
      />
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
    headerShadowVisible:    false,
    headerBackTitleVisible: false,
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
        <RootStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} options={{ title: 'איפוס סיסמה' }} />
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
        <RootStack.Screen name="PrivacyPolicy"  component={PrivacyPolicyScreen}  options={{ title: 'מדיניות פרטיות' }} />
        <RootStack.Screen name="TermsOfService" component={TermsOfServiceScreen} options={{ title: 'תנאי שימוש' }} />
        <RootStack.Screen name="Contact"        component={ContactScreen}        options={{ title: 'יצירת קשר' }} />
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      setInitialRoute(user ? 'MainTabs' : 'Onboarding');
    });
    return unsub;
  }, []);

  if (initialRoute === null || !fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#0F172A' }} />;
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary context="App">
        <ThemeProvider>
          <AppNavigator initialRoute={initialRoute} />
        </ThemeProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
