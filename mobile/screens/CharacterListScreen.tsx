import React, { useState, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import {
  Animated,
  View,
  Text,
  Pressable,
  StyleSheet,
  SectionList,
  ScrollView,
  TextInput,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { getCurrentUserId } from '../src/services/auth';
import { auth as firebaseAuth } from '../src/services/firebase';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterList'>;

const HEBREW_CHARS  = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת'.split('');
const ENGLISH_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ENGLISH_LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS        = '0123456789'.split('');
const PUNCTUATION   = [
  '.', ',', '!', '?', ':', ';', '"', "'", '`',
  '-', '_', '+', '=', '*', '/', '\\', '|',
  '(', ')', '[', ']', '{', '}', '<', '>',
  '@', '#', '$', '%', '^', '&', '~',
];

const SECTIONS = [
  { title: 'עברית',       data: [HEBREW_CHARS],  key: 'he' },
  { title: 'English A–Z', data: [ENGLISH_UPPER], key: 'en_upper' },
  { title: 'English a–z', data: [ENGLISH_LOWER], key: 'en_lower' },
  { title: 'ספרות',       data: [DIGITS],        key: 'nums' },
  { title: 'סימנים',      data: [PUNCTUATION],   key: 'syms' },
];

const ALL_CHARS = [
  ...HEBREW_CHARS, ...ENGLISH_UPPER, ...ENGLISH_LOWER, ...DIGITS, ...PUNCTUATION,
];
const TOTAL_ALL = ALL_CHARS.length;

type Status = Record<string, { captured: boolean; count: number }>;

export default function CharacterListScreen({ navigation }: Props) {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const styles = useMemo(() => getStyles(colors, isDark), [colors, isDark]);

  const [status, setStatus]         = useState<Status>({});
  const [searchChar, setSearchChar] = useState('');

  const sectionListRef = useRef<SectionList>(null);

  // One Animated.Value per section for stagger-fade entrance
  const sectionAnims = useRef(SECTIONS.map(() => new Animated.Value(0))).current;
  const headerAnim   = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem('character_status').then(raw => {
        try { if (raw) setStatus(JSON.parse(raw)); }
        catch { setStatus({}); }
      });

      headerAnim.setValue(0);
      sectionAnims.forEach(a => a.setValue(0));

      Animated.sequence([
        Animated.timing(headerAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
        Animated.stagger(
          60,
          sectionAnims.map(a =>
            Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }),
          ),
        ),
      ]).start();
    }, []),
  );

  useLayoutEffect(() => {
    navigation.setOptions({});
  }, [navigation]);

  const filteredSections = useMemo(() => {
    if (!searchChar) return SECTIONS;
    return SECTIONS
      .map(sec => ({
        ...sec,
        data: [sec.data[0].filter(c => c === searchChar)],
      }))
      .filter(sec => sec.data[0].length > 0);
  }, [searchChar]);

  const captured  = Object.values(status).filter(s => s.captured).length;
  const pct       = TOTAL_ALL > 0 ? captured / TOTAL_ALL : 0;
  const pctLabel  = Math.round(pct * 100);
  const barWidth  = `${pctLabel}%` as `${number}%`;

  const scrollToSection = useCallback((sectionIndex: number) => {
    impactLight();
    try {
      sectionListRef.current?.scrollToLocation({
        sectionIndex,
        itemIndex: 0,
        animated: true,
        viewOffset: 0,
      });
    } catch { /* ignore if section not visible */ }
  }, []);

  const handleLongPress = useCallback((char: string) => {
    const s = status[char];
    if (!s?.captured) return;
    impactMedium();
    Alert.alert(
      `תו "${char}"`,
      `יש ${s.count} דגימות שמורות. מה ברצונך לעשות?`,
      [
        { text: 'נהל דגמים',  onPress: () => navigation.navigate('CharacterVariants', { character: char }) },
        { text: 'מחק תו', style: 'destructive', onPress: () => confirmDelete(char) },
        { text: 'ביטול',  style: 'cancel' },
      ],
    );
  }, [status, navigation]);

  const confirmDelete = useCallback((char: string) => {
    Alert.alert(
      'אישור מחיקה',
      `למחוק את כל הדגימות של "${char}"?`,
      [
        { text: 'מחק', style: 'destructive', onPress: () => deleteCharacter(char) },
        { text: 'ביטול', style: 'cancel' },
      ],
    );
  }, []);

  const deleteCharacter = useCallback(async (char: string) => {
    try {
      const uid   = getCurrentUserId() ?? 'anonymous';
      const token = await firebaseAuth.currentUser?.getIdToken();
      await fetch(`${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(char)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch { /* best-effort */ }

    let current: Status = {};
    try {
      const raw = await AsyncStorage.getItem('character_status');
      if (raw) current = JSON.parse(raw);
    } catch { /* use empty fallback */ }
    delete current[char];
    setStatus(current);
    await AsyncStorage.setItem('character_status', JSON.stringify(current));
  }, []);

  function renderCharGrid(chars: string[]) {
    return (
      <View style={styles.charGrid}>
        {chars.map(char => {
          const s    = status[char];
          const done = !!s?.captured;
          return (
            <Pressable
              key={char}
              style={({ pressed }) => [
                styles.charCard,
                done ? styles.cardDone : styles.cardEmpty,
                pressed && styles.cardPressed,
              ]}
              onPress={() => {
                impactLight();
                done
                  ? navigation.navigate('CharacterVariants', { character: char })
                  : navigation.navigate('CharacterConfig',   { character: char });
              }}
              onLongPress={() => handleLongPress(char)}
              delayLongPress={400}
            >
              <Text style={[styles.charGlyph, done && styles.charGlyphDone]}>
                {char}
              </Text>
              {done
                ? <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{s.count}</Text>
                  </View>
                : <View style={styles.emptyDot} />
              }
            </Pressable>
          );
        })}
      </View>
    );
  }

  const ListHeader = useMemo(() => (
    <Animated.View style={{
      opacity: headerAnim,
      transform: [{ translateY: headerAnim.interpolate({ inputRange: [0,1], outputRange: [-12, 0] }) }],
    }}>
      {/* ── Header card ────────────────────────────────────────────────── */}
      <View style={styles.headerCard}>
        <Text style={styles.screenTitle}>מאגר כתב היד</Text>
        <View style={styles.progressCard}>
          <Text style={styles.bigPct}>{pctLabel}%</Text>
          <Text style={styles.progressSub}>
            {captured === 0
              ? 'צלם את האותיות שלך כדי להתחיל'
              : `${captured} מתוך ${TOTAL_ALL} תווים נסרקו`
            }
          </Text>
          <View style={styles.barTrack}>
            <View style={styles.barFillBg} />
            <View style={[styles.barFill, { width: barWidth }]} />
          </View>
        </View>
      </View>

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <View style={styles.searchRow}>
        <View style={styles.searchInputWrap}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={searchChar}
            onChangeText={t => setSearchChar(t.slice(-1))}
            maxLength={1}
            placeholder="חפש תו..."
            placeholderTextColor={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'}
            textAlign="center"
            returnKeyType="done"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchChar ? (
            <Pressable
              hitSlop={12}
              onPress={() => { setSearchChar(''); impactLight(); }}
            >
              <Text style={styles.searchClearText}>✕</Text>
            </Pressable>
          ) : <View style={{ width: 20 }} />}
        </View>
      </View>

      {/* ── Category tabs ──────────────────────────────────────────────── */}
      {!searchChar && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsContent}
          style={styles.tabsRow}
        >
          {SECTIONS.map((sec, idx) => (
            <Pressable
              key={sec.key}
              style={({ pressed }) => [styles.tabPill, pressed && styles.tabPillPressed]}
              onPress={() => scrollToSection(idx)}
            >
              <Text style={styles.tabPillText}>{sec.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </Animated.View>
  ), [headerAnim, pctLabel, captured, barWidth, searchChar, isDark]);

  return (
    <View style={styles.root}>
      {/* ── Character grid (+ header inside) ────────────────────────────── */}
      <SectionList
        ref={sectionListRef}
        sections={filteredSections}
        keyExtractor={(_, index) => String(index)}
        onScrollToIndexFailed={() => { /* no-op */ }}
        ListHeaderComponent={ListHeader}
        renderSectionHeader={({ section }) => {
          const idx = SECTIONS.findIndex(s => s.key === section.key);
          const anim = sectionAnims[idx] ?? sectionAnims[0];
          return (
            <Animated.View style={[
              styles.sectionHeader,
              {
                opacity:   anim,
                transform: [{ translateY: anim.interpolate({ inputRange: [0,1], outputRange: [8, 0] }) }],
              },
            ]}>
              <View style={styles.sectionRule} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.sectionRule} />
            </Animated.View>
          );
        }}
        renderItem={({ item, section }) => {
          const idx  = SECTIONS.findIndex(s => s.key === section.key);
          const anim = sectionAnims[idx] ?? sectionAnims[0];
          return (
            <Animated.View style={{
              opacity:   anim,
              transform: [{ translateY: anim.interpolate({ inputRange: [0,1], outputRange: [10, 0] }) }],
            }}>
              {renderCharGrid(item)}
            </Animated.View>
          );
        }}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      {/* ── Footer CTA ───────────────────────────────────────────────────── */}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [
            styles.ctaBtn,
            captured === 0 && styles.ctaBtnDim,
            pressed && styles.ctaBtnPressed,
          ]}
          onPress={() => { impactMedium(); navigation.navigate('Editor'); }}
        >
          <Text style={[styles.ctaText, captured === 0 && styles.ctaTextDim]}>
            {captured > 0
              ? `המשך לעורך — ${captured} תווים מוכנים`
              : 'דלג לעורך'}
          </Text>
        </Pressable>
      </View>

    </View>
  );
}

// ─── Moleskine palette ────────────────────────────────────────────────────────
const BROWN_DEEP   = '#5C4A3A';
const BROWN_MID    = '#8B7355';
const INK_DARK     = '#2A2520';
const CREAM_CARD   = '#FDFAF4';
const BAR_BG       = 'rgba(139,115,85,0.12)';

function getStyles(colors: ThemeColors, isDark: boolean) {

  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: colors.bgPage },
    listContent: { paddingBottom: 16 },

    // ── Header card ───────────────────────────────────────────────────────────
    headerCard: {
      backgroundColor:   isDark ? colors.bgSurface : '#FAF7F0',
      paddingTop:        20,
      paddingHorizontal: 20,
      paddingBottom:     16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderFaint,
    },
    screenTitle: {
      fontSize:         26,
      fontFamily:       fonts.extraBold,
      color:            isDark ? colors.inkDark : INK_DARK,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginBottom:     14,
      letterSpacing:    -0.5,
    },

    // ── Progress card ─────────────────────────────────────────────────────────
    progressCard: {
      backgroundColor: isDark ? colors.bgPage : CREAM_CARD,
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     isDark ? colors.border : 'rgba(139,115,85,0.18)',
      padding:         16,
      ...shadow.card,
    },
    bigPct: {
      fontSize:         48,
      fontFamily:       fonts.extraBold,
      color:            isDark ? colors.inkDark : BROWN_DEEP,
      textAlign:        'right',
      lineHeight:       52,
      letterSpacing:    -1,
    },
    progressSub: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            isDark ? colors.inkLight : BROWN_MID,
      textAlign:        'right',
      writingDirection: 'rtl',
      marginTop:        4,
      marginBottom:     14,
    },
    barTrack: {
      height:          6,
      borderRadius:    3,
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : BAR_BG,
      overflow:        'hidden',
      position:        'relative',
    },
    barFillBg: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'transparent',
    },
    barFill: {
      height:          '100%',
      borderRadius:    3,
      backgroundColor: isDark ? colors.accent : BROWN_MID,
    },

    // ── Search bar ────────────────────────────────────────────────────────────
    searchRow: {
      paddingHorizontal: 16,
      paddingTop:        12,
      paddingBottom:     8,
      backgroundColor:   isDark ? colors.bgSurface : '#FAF7F0',
    },
    searchInputWrap: {
      flexDirection:   'row',
      alignItems:      'center',
      backgroundColor: isDark ? colors.bgPage : '#FFFFFF',
      borderRadius:    radius.lg,
      borderWidth:     1,
      borderColor:     isDark ? colors.border : 'rgba(139,115,85,0.2)',
      paddingHorizontal: 12,
      height:          48,
      gap:             8,
    },
    searchIcon: {
      fontSize: 16,
    },
    searchInput: {
      flex:       1,
      fontSize:   22,
      fontFamily: fonts.bold,
      color:      isDark ? colors.inkDark : INK_DARK,
      textAlign:  'center',
      height:     48,
    },
    searchClearText: {
      fontSize:   16,
      color:      isDark ? colors.inkLight : BROWN_MID,
      paddingHorizontal: 2,
    },

    // ── Category tabs ─────────────────────────────────────────────────────────
    tabsRow: {
      backgroundColor: isDark ? colors.bgSurface : '#FAF7F0',
      paddingBottom:   4,
    },
    tabsContent: {
      paddingHorizontal: 16,
      paddingVertical:   8,
      gap:               8,
      flexDirection:     'row',
    },
    tabPill: {
      paddingHorizontal: 16,
      paddingVertical:   8,
      borderRadius:      radius.full,
      backgroundColor:   isDark ? colors.bgPage : '#FFFFFF',
      borderWidth:       1,
      borderColor:       isDark ? colors.border : 'rgba(139,115,85,0.2)',
      shadowColor:       '#2A2520',
      shadowOffset:      { width: 0, height: 1 },
      shadowOpacity:     isDark ? 0 : 0.05,
      shadowRadius:      3,
      elevation:         1,
    },
    tabPillPressed: {
      backgroundColor: isDark ? colors.accent : BROWN_DEEP,
      borderColor:     isDark ? colors.accent : BROWN_DEEP,
    },
    tabPillText: {
      fontSize:   13,
      fontFamily: fonts.semiBold ?? fonts.bold,
      color:      isDark ? colors.inkMid : BROWN_MID,
    },

    // ── Section header ────────────────────────────────────────────────────────
    sectionHeader: {
      flexDirection:     'row',
      alignItems:        'center',
      paddingHorizontal: 16,
      paddingTop:        22,
      paddingBottom:     10,
      gap:               12,
    },
    sectionRule: {
      flex:            1,
      height:          StyleSheet.hairlineWidth,
      backgroundColor: isDark ? colors.border : 'rgba(139,115,85,0.25)',
    },
    sectionTitle: {
      fontSize:      13,
      fontFamily:    fonts.bold,
      color:         isDark ? colors.inkMid : BROWN_MID,
      letterSpacing: 0.6,
    },

    // ── Character cards ───────────────────────────────────────────────────────
    charGrid: {
      flexDirection:     'row',
      flexWrap:          'wrap',
      paddingHorizontal: 12,
      gap:               6,
    },
    charCard: {
      width:          '18%',
      aspectRatio:    1,
      borderRadius:   radius.sm,
      alignItems:     'center',
      justifyContent: 'center',
      borderWidth:    1.5,
      position:       'relative',
    },
    cardEmpty: {
      backgroundColor: isDark ? colors.bgPage : '#FFFFFF',
      borderColor:     isDark ? colors.border : '#E8E3D8',
      borderStyle:     'dashed',
    },
    cardDone: {
      backgroundColor: isDark ? colors.bgSurface : '#FFFFFF',
      borderColor:     isDark ? colors.border : 'rgba(139,115,85,0.22)',
      borderStyle:     'solid',
      shadowColor:     isDark ? '#000' : '#2A2520',
      shadowOffset:    { width: 0, height: 2 },
      shadowOpacity:   isDark ? 0.18 : 0.07,
      shadowRadius:    6,
      elevation:       2,
    },
    cardPressed: {
      opacity:   0.72,
      transform: [{ scale: 0.93 }],
    },
    charGlyph: {
      fontSize:   22,
      fontFamily: fonts.bold,
      color:      isDark ? colors.inkLight : 'rgba(42,37,32,0.3)',
    },
    charGlyphDone: {
      color: isDark ? colors.inkDark : INK_DARK,
    },
    countBadge: {
      position:          'absolute',
      bottom:            3,
      right:             3,
      backgroundColor:   isDark ? colors.accent : BROWN_DEEP,
      borderRadius:      radius.full,
      borderWidth:       1.5,
      borderColor:       isDark ? colors.bgSurface : '#FFFFFF',
      minWidth:          16,
      height:            16,
      alignItems:        'center',
      justifyContent:    'center',
      paddingHorizontal: 3,
    },
    countBadgeText: {
      fontSize:   8,
      fontFamily: fonts.extraBold,
      color:      '#FFFFFF',
      lineHeight: 11,
    },
    emptyDot: {
      position:        'absolute',
      bottom:          5,
      right:           5,
      width:           5,
      height:          5,
      borderRadius:    2.5,
      backgroundColor: isDark ? colors.border : '#E8E3D8',
    },

    // ── Footer ────────────────────────────────────────────────────────────────
    footer: {
      paddingHorizontal: 16,
      paddingTop:        12,
      paddingBottom:     20,
      backgroundColor:   colors.bgSurface,
      borderTopWidth:    StyleSheet.hairlineWidth,
      borderTopColor:    colors.border,
    },
    ctaBtn: {
      backgroundColor: isDark ? colors.accent : '#2C3E50',
      paddingVertical: 17,
      borderRadius:    radius.md,
      alignItems:      'center',
      shadowColor:     '#2C3E50',
      shadowOffset:    { width: 0, height: 4 },
      shadowOpacity:   0.28,
      shadowRadius:    12,
      elevation:       6,
    },
    ctaBtnDim: {
      backgroundColor: colors.border,
      shadowOpacity:   0,
      elevation:       0,
    },
    ctaBtnPressed: {
      transform: [{ scale: 0.97 }],
      opacity:   0.88,
    },
    ctaText: {
      fontSize:         16,
      fontFamily:       fonts.bold,
      color:            '#FFFFFF',
      writingDirection: 'rtl',
      letterSpacing:    0.2,
    },
    ctaTextDim: {
      color: colors.inkLight,
    },
  });
}
