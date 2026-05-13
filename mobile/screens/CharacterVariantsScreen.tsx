import React, { useCallback, useState, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  FlatList,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId } from '../src/services/auth';
import { auth as firebaseAuth } from '../src/services/firebase';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await firebaseAuth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function absUrl(url: string): string {
  return url.startsWith('http') ? url : `${BACKEND_URL}${url}`;
}

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterVariants'>;

// ts = timestamp recorded when this variant was fetched.
// Adding ?t=<ts> to every Image URI forces React Native to bypass its
// internal image cache — each load after a mutation is treated as a fresh URL.
type Variant = { index: number; url: string; ts: number };

export default function CharacterVariantsScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const { character } = route.params;
  const { width: W }  = useWindowDimensions();

  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading,  setLoading]  = useState(true);
  // deletingIndex tracks which card is mid-delete so we can show its spinner
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);

  const cardSize = (W - 48) / 2;
  const uid      = getCurrentUserId() ?? 'anonymous';

  // ── Load variants from backend ─────────────────────────────────────────────
  // Each variant is stamped with the moment this fetch completed.
  // The stamp changes on every reload so even if the server returns the same
  // URL (re-indexed after deletion), the Image component sees a new URI.
  const loadVariants = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch(
        `${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(character)}/variants`,
        { headers: await authHeaders() },
      );
      const data = await res.json() as { variants: { index: number; url: string }[] };
      const ts      = Date.now();
      const fetched = (data.variants ?? []).filter(v => !!v.url);
      setVariants(fetched.map(v => ({ ...v, ts })));
    } catch {
      Alert.alert('שגיאה', 'לא ניתן לטעון את הדגמים');
    } finally {
      setLoading(false);
    }
  }, [uid, character]);

  useFocusEffect(useCallback(() => { loadVariants(); }, [loadVariants]));

  // ── Delete one variant ─────────────────────────────────────────────────────
  // Strategy: optimistic removal → DELETE request → re-index local state.
  // We do NOT reload from server after DELETE because the server may return
  // stale variant records with broken image URLs (file deleted, DB record kept).
  // Instead we re-index the local list to match the server's expected indices,
  // so subsequent deletes target the right slot.
  // useFocusEffect will reload authoritative state when the user returns.
  const handleDelete = useCallback((variant: Variant) => {
    impactLight();
    Alert.alert(
      'מחק דגם',
      `למחוק את דגם ${variant.index + 1}?`,
      [
        { text: 'ביטול', style: 'cancel' },
        {
          text: 'מחק',
          style: 'destructive',
          onPress: async () => {
            // ── 1. Snapshot current list for rollback ──────────────────────
            const snapshot = [...variants];

            // ── 2. Optimistic removal + re-index ──────────────────────────
            const remaining = snapshot.filter(v => v.index !== variant.index);
            // Re-assign indices 0…N-1 to match server re-indexing
            const reindexed = remaining.map((v, i) => ({ ...v, index: i }));
            setVariants(reindexed);
            setDeletingIndex(variant.index);

            try {
              // ── 3. DELETE on server ────────────────────────────────────────
              const res = await fetch(
                `${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(character)}/variant/${variant.index}`,
                { method: 'DELETE', headers: await authHeaders() },
              );
              if (!res.ok) throw new Error(`HTTP ${res.status}`);

              // ── 4. Update AsyncStorage if no variants remain ───────────────
              if (reindexed.length === 0) {
                const raw   = await AsyncStorage.getItem('character_status');
                const cache = raw ? JSON.parse(raw) : {};
                cache[character] = { captured: false, count: 0 };
                await AsyncStorage.setItem('character_status', JSON.stringify(cache));
              }

            } catch {
              // ── 5. Rollback on failure ─────────────────────────────────────
              setVariants(snapshot);
              Alert.alert('שגיאה', 'המחיקה נכשלה — הדגם שוחזר');
            } finally {
              setDeletingIndex(null);
            }
          },
        },
      ],
    );
  }, [variants, uid, character]);

  // ── Add new sample ─────────────────────────────────────────────────────────
  function handleAdd() {
    impactMedium();
    navigation.navigate('CharacterCapture', { character, totalSamples: 1, returnTo: 'CharacterVariants' });
  }

  // ── Render one variant card ────────────────────────────────────────────────
  // useCallback is required: FlatList only re-invokes renderItem when extraData
  // changes AND the renderer reference changes.  Without useCallback the function
  // gets a new reference on every outer render but FlatList ignores it, leaving
  // stale card views on screen after a deletion.
  const renderCard = useCallback(({ item }: { item: Variant }) => {
    const isThisDeleting = deletingIndex === item.index;
    const cachedUri = `${absUrl(item.url)}?t=${item.ts}`;

    return (
      <View style={[styles.card, { width: cardSize }, isThisDeleting && styles.cardDeleting]}>
        <Image
          source={{ uri: cachedUri }}
          style={[styles.cardImage, { height: cardSize }]}
          resizeMode="contain"
          onError={() => {
            // Server returned a URL for a deleted file — remove the card silently
            setVariants(prev => prev.filter(v => v.index !== item.index));
          }}
        />

        <Text style={styles.cardLabel}>דגם {item.index + 1}</Text>

        <Pressable
          style={({ pressed }) => [
            styles.deleteBtn,
            isThisDeleting && styles.deleteBtnBusy,
            !isThisDeleting && pressed && { opacity: 0.78 },
          ]}
          onPress={() => handleDelete(item)}
          disabled={isThisDeleting || deletingIndex !== null}
        >
          {isThisDeleting
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.deleteBtnText}>מחק דגם זה</Text>}
        </Pressable>
      </View>
    );
  }, [cardSize, deletingIndex, handleDelete, styles]);

  // ── Root ───────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerChar}>{character}</Text>
        <Text style={styles.headerSub}>
          {loading
            ? 'טוען...'
            : variants.length === 0
              ? 'אין דגמים שמורים'
              : `${variants.length} דגמים שמורים`}
        </Text>
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : variants.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>אין דגמים עבור "{character}"</Text>
          <Text style={styles.emptyHint}>לחץ על הכפתור למטה כדי לצלם דגם ראשון</Text>
        </View>
      ) : (
        <FlatList
          data={variants}
          keyExtractor={v => `${v.index}-${v.ts}`}
          renderItem={renderCard}
          extraData={variants}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          onPress={handleAdd}
        >
          <Text style={styles.addBtnText}>+ צלם דגם חדש</Text>
        </Pressable>
      </View>

    </View>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root:   { flex: 1, backgroundColor: colors.bgPage },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },

    // ── Header ──────────────────────────────────────────────────────────────────
    header: {
      backgroundColor: colors.bgDark,
      paddingTop: 52,
      paddingBottom: 20,
      alignItems: 'center',
    },
    headerChar: { fontSize: 72, fontFamily: fonts.extraBold, color: '#fff', lineHeight: 84 },
    headerSub:  { fontSize: 14, fontFamily: fonts.regular,   color: '#94A3B8' },

    // ── Grid ────────────────────────────────────────────────────────────────────
    listContent: { padding: 16, paddingBottom: 8 },
    row:         { gap: 16, marginBottom: 16 },

    // ── Variant card ────────────────────────────────────────────────────────────
    card: {
      backgroundColor: colors.bgSurface,
      borderRadius:    radius.md,
      overflow:        'hidden',
      borderWidth:     1.5,
      borderColor:     colors.border,
      ...shadow.card,
    },
    cardDeleting: {
      opacity: 0.5,   // dim the card while its delete request is in-flight
    },
    cardImage: {
      width: '100%',
      backgroundColor: '#F0F4F8',
    },
    cardLabel: {
      fontSize: 12,
      fontFamily: fonts.semiBold,
      color: colors.inkMid,
      textAlign: 'center',
      paddingVertical: 6,
    },

    // ── Delete button ────────────────────────────────────────────────────────────
    deleteBtn: {
      backgroundColor:  colors.danger,
      marginHorizontal: 8,
      marginBottom:     10,
      paddingVertical:  8,
      borderRadius:     radius.sm,
      alignItems:       'center',
      minHeight:        34,
      justifyContent:   'center',
    },
    deleteBtnBusy: {
      backgroundColor: colors.danger + 'AA',   // slightly transparent while loading
    },
    deleteBtnText: { color: '#fff', fontSize: 12, fontFamily: fonts.bold },

    // ── Empty state ──────────────────────────────────────────────────────────────
    emptyTitle: {
      fontSize: 16,
      fontFamily: fonts.semiBold,
      color: colors.inkMid,
      textAlign: 'center',
      marginBottom: 8,
      writingDirection: 'rtl',
    },
    emptyHint: {
      fontSize: 13,
      fontFamily: fonts.regular,
      color: colors.inkFaint,
      textAlign: 'center',
      writingDirection: 'rtl',
    },

    // ── Footer ───────────────────────────────────────────────────────────────────
    footer: {
      padding: 16,
      backgroundColor: colors.bgSurface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      ...shadow.card,
    },
    addBtn: {
      backgroundColor: colors.accent,
      paddingVertical: 16,
      borderRadius:    radius.md,
      alignItems:      'center',
      ...shadow.btn,
    },
    addBtnText: { color: '#fff', fontSize: 17, fontFamily: fonts.bold },
  });
}
