import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  FlatList,
  useWindowDimensions,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';
import { auth } from '../src/services/firebase';

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterSampleReview'>;

export default function CharacterSampleReviewScreen({ route, navigation }: Props) {
  const { character, samples, returnTo } = route.params;
  const { width: W } = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const [uris,       setUris]       = useState<string[]>(samples);
  const [uploading,  setUploading]  = useState(false);

  const cardSize = (W - 48) / 2; // 2 columns, 16px side padding + 8px gap each side

  // ── Delete ─────────────────────────────────────────────────────────────────
  function handleDelete(index: number) {
    impactLight();
    Alert.alert(
      'מחיקת דגימה',
      `למחוק את דגימה ${index + 1}?`,
      [
        { text: 'ביטול', style: 'cancel' },
        {
          text: 'מחק',
          style: 'destructive',
          onPress: () => {
            const next = uris.filter((_, i) => i !== index);
            setUris(next);
            if (next.length === 0) {
              Alert.alert('אין דגימות', 'חזור לצלם לפחות דגימה אחת', [
                { text: 'אישור', onPress: () => navigation.goBack() },
              ]);
            }
          },
        },
      ],
    );
  }

  // ── Retake specific slot ───────────────────────────────────────────────────
  function handleRetake(index: number) {
    impactLight();
    Alert.alert(
      'צלם מחדש',
      `מחק את דגימה ${index + 1} וצלם אחת חדשה במקומה?`,
      [
        { text: 'ביטול', style: 'cancel' },
        {
          text: 'צלם מחדש',
          onPress: () => {
            const remaining = uris.filter((_, i) => i !== index);
            // Pass remaining samples so CharacterCapture prepends them on finish
            navigation.replace('CharacterCapture', {
              character,
              totalSamples:    1,
              existingSamples: remaining,
            });
          },
        },
      ],
    );
  }

  // ── Add more ───────────────────────────────────────────────────────────────
  function handleAddMore() {
    impactLight();
    navigation.replace('CharacterCapture', {
      character,
      totalSamples:    1,
      existingSamples: uris,
    });
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (uris.length === 0) {
      Alert.alert('שגיאה', 'אין דגימות לשמירה');
      return;
    }
    impactMedium();
    setUploading(true);

    try {
      const base64List = await Promise.all(
        uris.map((uri, i) =>
          FileSystem.readAsStringAsync(uri, { encoding: 'base64' })
            .catch(() => { throw new Error(`דגימה ${i + 1} לא נגישה`); }),
        ),
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      let res: Response;
      try {
        const token = await auth.currentUser?.getIdToken();
        res = await fetch(`${BACKEND_URL}/save-character-samples`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body:    JSON.stringify({ character, samples: base64List }),
          signal:  controller.signal,
        });
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          throw new Error('השרת לא הגיב בזמן — נסה שוב');
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: unknown };
        const detail = typeof body.detail === 'string' ? body.detail : undefined;
        throw new Error(detail ?? `שגיאת שרת (${res.status})`);
      }

      const data = await res.json() as { status: string; samples_saved?: number; detail?: unknown };
      if (data.status !== 'success') {
        const detail = typeof data.detail === 'string' ? data.detail : undefined;
        throw new Error(detail ?? 'העיבוד נכשל — נסה לצלם שוב בתאורה טובה יותר');
      }

      // Update local status badge — safe parse
      let currentStatus: Record<string, unknown> = {};
      try {
        const raw = await AsyncStorage.getItem('character_status');
        if (raw) currentStatus = JSON.parse(raw);
      } catch { /* use empty fallback */ }
      currentStatus[character] = { captured: true, count: uris.length };
      await AsyncStorage.setItem('character_status', JSON.stringify(currentStatus));

      // Show success then navigate on dismiss — avoids race with setTimeout
      const savedCount = uris.length;
      Alert.alert('✓ נשמר', `${savedCount} דגימות של "${character}" נשמרו במאגר`, [
        {
          text: 'אישור',
          onPress: () => {
            if (returnTo === 'CharacterVariants') {
              navigation.navigate('CharacterVariants', { character });
            } else {
              navigation.navigate('MainTabs');
            }
          },
        },
      ]);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
      Alert.alert('שמירה נכשלה', msg);
    } finally {
      setUploading(false);
    }
  }

  // ── Render sample card ─────────────────────────────────────────────────────
  function renderCard({ item: uri, index }: { item: string; index: number }) {
    return (
      <View style={[styles.card, { width: cardSize, height: cardSize + 60 }]}>
        <Image source={{ uri }} style={[styles.cardImage, { height: cardSize }]} resizeMode="cover" />
        <Text style={styles.cardLabel}>דגימה {index + 1}</Text>
        <View style={styles.cardBtns}>
          <Pressable
            style={({ pressed }) => [styles.cardBtn, styles.cardBtnRetake, pressed && { opacity: 0.75 }]}
            onPress={() => handleRetake(index)}
          >
            <Text style={styles.cardBtnText}>צלם מחדש</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.cardBtn, styles.cardBtnDelete, pressed && { opacity: 0.75 }]}
            onPress={() => handleDelete(index)}
          >
            <Text style={styles.cardBtnText}>מחק</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerChar}>{character}</Text>
        <Text style={styles.headerTitle}>סקירת דגימות</Text>
        <Text style={styles.headerSub}>{uris.length} דגימות · בדוק שהתמונות ברורות לפני שמירה</Text>
      </View>

      {/* Grid */}
      <FlatList
        data={uris}
        keyExtractor={uri => uri}
        extraData={uris}
        renderItem={renderCard}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>אין דגימות — חזור לצלם</Text>
          </View>
        }
      />

      {/* Footer */}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.footerBtn, styles.addBtn, pressed && { opacity: 0.8 }]}
          onPress={handleAddMore}
          disabled={uploading}
        >
          <Text style={styles.footerBtnText}>+ הוסף דגימה</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.footerBtn,
            styles.saveBtn,
            uris.length === 0 && styles.saveBtnDisabled,
            pressed && uris.length > 0 && { opacity: 0.88 },
          ]}
          onPress={handleSave}
          disabled={uploading || uris.length === 0}
        >
          {uploading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.footerBtnText}>שמור הכל ({uris.length})</Text>
          }
        </Pressable>
      </View>

      {/* Uploading overlay */}
      {uploading && (
        <View style={styles.overlay}>
          <View style={styles.overlayBox}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.overlayText}>שומר במאגר...</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bgPage },

    header: {
      backgroundColor: colors.bgDark,
      paddingTop: 52,
      paddingBottom: 20,
      paddingHorizontal: 20,
      alignItems: 'center',
    },
    headerChar:  { fontSize: 64, fontFamily: fonts.extraBold, color: '#fff', lineHeight: 76 },
    headerTitle: { fontSize: 18, fontFamily: fonts.bold,      color: '#fff', marginBottom: 4 },
    headerSub:   { fontSize: 13, fontFamily: fonts.regular,   color: '#94A3B8', textAlign: 'center' },

    listContent: { padding: 16, paddingBottom: 8 },
    row:         { gap: 16, marginBottom: 16 },

    card: {
      backgroundColor: colors.bgSurface,
      borderRadius: radius.md,
      overflow: 'hidden',
      borderWidth: 1.5,
      borderColor: colors.border,
      ...shadow.card,
    },
    cardImage: { width: '100%' },
    cardLabel: {
      fontSize: 11,
      fontFamily: fonts.semiBold,
      color: colors.inkMid,
      textAlign: 'center',
      paddingTop: 6,
      paddingBottom: 2,
    },
    cardBtns: { flexDirection: 'row', paddingHorizontal: 6, paddingBottom: 8, gap: 6 },
    cardBtn:  { flex: 1, paddingVertical: 6, borderRadius: radius.sm, alignItems: 'center' },
    cardBtnRetake: { backgroundColor: colors.accent },
    cardBtnDelete: { backgroundColor: colors.danger },
    cardBtnText:   { color: '#fff', fontSize: 11, fontFamily: fonts.bold },

    footer: {
      flexDirection: 'row',
      gap: 12,
      padding: 16,
      backgroundColor: colors.bgSurface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      ...shadow.card,
    },
    footerBtn: {
      flex: 1,
      paddingVertical: 16,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtn:         { backgroundColor: colors.inkMid },
    saveBtn:        { backgroundColor: colors.success, ...shadow.btn },
    saveBtnDisabled:{ backgroundColor: colors.inkFaint, shadowOpacity: 0 },
    footerBtnText:  { color: '#fff', fontSize: 16, fontFamily: fonts.bold },

    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
    emptyText:  { fontSize: 15, fontFamily: fonts.semiBold, color: colors.inkFaint, writingDirection: 'rtl' },

    overlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
      justifyContent: 'center', alignItems: 'center',
    },
    overlayBox: {
      backgroundColor: colors.bgSurface,
      borderRadius: radius.md,
      paddingVertical: 28, paddingHorizontal: 40,
      alignItems: 'center',
    },
    overlayText: { marginTop: 14, fontSize: 16, fontFamily: fonts.bold, color: colors.inkDark },
  });
}
