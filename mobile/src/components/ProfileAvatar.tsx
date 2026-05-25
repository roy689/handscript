import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NavigationProp } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { auth } from '../services/firebase';
import { useTheme } from '../contexts/ThemeContext';
import { fonts, radius } from '../theme';
import { impactLight } from '../utils/haptics';

interface Props {
  navigation: NavigationProp<RootStackParamList>;
}

export default function ProfileAvatar({ navigation }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { colors } = useTheme();

  const [user, setUser] = useState(auth.currentUser);
  useEffect(() => auth.onAuthStateChanged(setUser), []);
  if (!user) return null;

  const initial = (
    user.displayName?.[0] ??
    user.email?.[0] ??
    '?'
  ).toUpperCase();

  const close = () => setMenuOpen(false);

  const menuItems: { label: string; onPress: () => void }[] = [
    {
      label: 'הפרופיל שלי',
      onPress: () => { close(); navigation.navigate('Profile'); },
    },
    {
      label: 'הגדרות',
      onPress: () => { close(); navigation.navigate('Settings'); },
    },
    { label: 'תנאי שימוש',       onPress: () => { close(); navigation.navigate('TermsOfService'); } },
    { label: 'מדיניות הפרטיות', onPress: () => { close(); navigation.navigate('PrivacyPolicy'); } },
  ];

  return (
    <>
      {/* ── Avatar button ── */}
      <Pressable
        onPress={() => { impactLight(); setMenuOpen(true); }}
        style={({ pressed }) => [
          styles.avatar,
          { backgroundColor: colors.accentLight, borderColor: colors.accent },
          pressed && { opacity: 0.7, transform: [{ scale: 0.94 }] },
        ]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="פתח תפריט פרופיל"
        accessibilityHint="פותח תפריט עם קישורים לפרופיל, הגדרות, תנאי שימוש ומדיניות פרטיות"
      >
        <Text style={[styles.initial, { color: colors.accent }]}>{initial}</Text>
      </Pressable>

      {/* ── Dropdown modal ── */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={close}
        statusBarTranslucent
      >
        {/* Backdrop — tapping closes the menu */}
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="סגור תפריט"
          accessibilityHint="לחיצה מחוץ לתפריט סוגרת אותו"
        >
          {/* Menu card — stop propagation so tapping menu doesn't close it */}
          <Pressable
            style={[
              styles.menu,
              {
                backgroundColor: colors.bgSurface,
                borderColor:     colors.border,
                shadowColor:     colors.inkDark,
              },
            ]}
            onPress={e => e.stopPropagation()}
          >
            {menuItems.map((item, i) => (
              <React.Fragment key={item.label}>
                {i > 0 && (
                  <View style={[styles.separator, { backgroundColor: colors.border }]} />
                )}
                <Pressable
                  style={({ pressed }) => [
                    styles.menuItem,
                    pressed && { backgroundColor: colors.bgPage },
                  ]}
                  onPress={() => { impactLight(); item.onPress(); }}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                >
                  <Text style={[styles.menuLabel, { color: colors.inkDark }]}>
                    {item.label}
                  </Text>
                </Pressable>
              </React.Fragment>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width:        34,
    height:       34,
    borderRadius: 17,
    borderWidth:  1.5,
    alignItems:   'center',
    justifyContent: 'center',
    marginRight:  4,
  },
  initial: {
    fontSize:   15,
    fontFamily: fonts.bold,
  },

  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems:      'flex-end',
    justifyContent:  'flex-start',
    paddingTop:      52,
    paddingRight:    12,
  },
  menu: {
    minWidth:     200,
    borderRadius: radius.md,
    borderWidth:  1,
    overflow:     'hidden',
    shadowOffset:  { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius:  12,
    elevation:     10,
  },
  menuItem: {
    paddingVertical:   15,
    paddingHorizontal: 20,
  },
  menuLabel: {
    fontSize:         15,
    fontFamily:       fonts.semiBold,
    textAlign:        'right',
    writingDirection: 'rtl',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
  },
});
