import React, { useCallback, useState, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { showAlert } from '../src/utils/alert';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius, shadow } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';
import { BACKEND_URL } from '../src/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId } from '../src/services/auth';
import { getAuthToken } from '../src/utils/api';
import AdBanner from '../src/components/AdBanner';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function absUrl(url: string): string {
  return url.startsWith('http') ? url : `${BACKEND_URL}${url}`;
}

/**
 * Append a cache-busting parameter to a URL without breaking its existing
 * query string. Firebase Storage URLs already carry `?alt=media&token=...`,
 * so naively appending `?t=...` produces a URL with two `?` characters,
 * which Firebase rejects with a 400. The Image then fails to load and the
 * user sees the "retry" placeholder for every card.
 */
function withCacheBust(url: string, ts: number): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${ts}`;
}

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterVariants'>;

// ts = timestamp recorded when this variant was fetched.
// Adding ?t=<ts> to every Image URI forces React Native to bypass its
// internal image cache — each load after a mutation is treated as a fresh URL.
type Variant = { index: number; url: string; ts: number };

// Variants whose image failed to load enough times to give up are tracked here
// (by the local card index, not the variant ID). We show a placeholder for
// them rather than removing them — the server still has the variant and the
// synthesiser uses it fine, so silently hiding it from the user is wrong.
type LoadState = 'loading' | 'loaded' | 'error';

export default function CharacterVariantsScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const { character } = route.params;
  const { width: W }  = useWindowDimensions();

  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading,  setLoading]  = useState(true);
  // deletingIndex tracks which card is mid-delete so we can show its spinner
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  // Per-card load state — lets us show a placeholder for cards whose image
  // didn't load instead of silently removing the variant from the list.
  const [loadStates, setLoadStates] = useState<Record<number, LoadState>>({});

  const cardSize = (W - 48) / 2;
  const uid      = getCurrentUserId() ?? 'anonymous';

  // ── Load variants from backend ─────────────────────────────────────────────
  // Each variant is stamped with the moment this fetch completed.
  // The stamp changes on every reload so even if the server returns the same
  // URL (re-indexed after deletion), the Image component sees a new URI.
  const loadVariants = useCallback(async () => {
    setLoading(true);
    setLoadStates({});  // fresh load → reset per-card load tracking
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
      const res  = await fetch(
        `${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(character)}/variants`,
        { headers: await authHeaders(), signal: controller.signal },
      );
      const data = await res.json() as { variants: { index: number; url: string }[] };
      const ts      = Date.now();
      const fetched = (data.variants ?? []).filter(v => !!v.url);
      setVariants(fetched.map(v => ({ ...v, ts })));

      // Sync the character_status badge cache with what the server actually
      // has. This auto-heals stale counts left over from earlier bugs where
      // the badge was set to "samples saved in this batch" instead of the
      // total. The user just has to open the variants screen once for each
      // out-of-sync character to fix it.
      try {
        const raw   = await AsyncStorage.getItem('character_status');
        const cache: Record<string, { captured: boolean; count: number }> =
          raw ? JSON.parse(raw) : {};
        const cached = cache[character];
        const realCount = fetched.length;
        if (!cached || cached.count !== realCount || cached.captured !== (realCount > 0)) {
          cache[character] = { captured: realCount > 0, count: realCount };
          await AsyncStorage.setItem('character_status', JSON.stringify(cache));
        }
      } catch {
        // Storage errors are non-fatal — the screen still displays correctly.
      }
    } catch {
      showAlert('שגיאה', 'לא ניתן לטעון את הדגמים');
    } finally {
      clearTimeout(t);
      setLoading(false);
    }
  }, [uid, character]);

  // Retry a single failed image by stamping it with a fresh timestamp.
  // The timestamp change forces React Native's Image to re-request the URL,
  // bypassing its internal cache for that one entry.
  const retryVariant = useCallback((index: number) => {
    impactLight();
    setLoadStates(prev => ({ ...prev, [index]: 'loading' }));
    setVariants(prev =>
      prev.map(v => (v.index === index ? { ...v, ts: Date.now() } : v)),
    );
  }, []);

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
    showAlert(
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
              const delCtrl = new AbortController();
              const delT = setTimeout(() => delCtrl.abort(), 15000);
              let res: Response;
              try {
                res = await fetch(
                  `${BACKEND_URL}/character/${encodeURIComponent(uid)}/${encodeURIComponent(character)}/variant/${variant.index}`,
                  { method: 'DELETE', headers: await authHeaders(), signal: delCtrl.signal },
                );
              } finally {
                clearTimeout(delT);
              }
              if (!res.ok) throw new Error(`HTTP ${res.status}`);

              // ── 4. Update AsyncStorage with the new total count ─────────────
              // The badge on CharacterListScreen reads this cache. Update it on
              // every delete (not just when the list becomes empty) so the
              // count stays accurate. captured = false only when no variants
              // remain — empty character should not show a tick.
              {
                const raw   = await AsyncStorage.getItem('character_status');
                const cache = raw ? JSON.parse(raw) : {};
                cache[character] = {
                  captured: reindexed.length > 0,
                  count:    reindexed.length,
                };
                await AsyncStorage.setItem('character_status', JSON.stringify(cache));
              }

            } catch {
              // ── 5. Rollback on failure ─────────────────────────────────────
              setVariants(snapshot);
              showAlert('שגיאה', 'המחיקה נכשלה — הדגם שוחזר');
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
    const cachedUri = withCacheBust(absUrl(item.url), item.ts);
    const loadState = loadStates[item.index] ?? 'loading';

    return (
      <View style={[styles.card, { width: cardSize }, isThisDeleting && styles.cardDeleting]}>
        {loadState === 'error' ? (
          // Image failed to load (network glitch, expired token, etc.) — show a
          // placeholder with a retry button instead of removing the variant.
          // The variant still exists on the server and the synthesiser uses it
          // fine, so silently hiding it from the user would be misleading.
          <Pressable
            style={[styles.cardImage, styles.cardImageError, { height: cardSize }]}
            onPress={() => retryVariant(item.index)}
            accessibilityRole="button"
            accessibilityLabel="טען מחדש דגם"
          >
            <Text style={styles.cardImageErrorIcon}>↻</Text>
            <Text style={styles.cardImageErrorText}>טען מחדש</Text>
          </Pressable>
        ) : (
          <Image
            source={{ uri: cachedUri }}
            style={[styles.cardImage, { height: cardSize }]}
            resizeMode="contain"
            onLoad={() => {
              setLoadStates(prev =>
                prev[item.index] === 'loaded' ? prev : { ...prev, [item.index]: 'loaded' },
              );
            }}
            onError={() => {
              // Mark this card as failed-to-load. The variant stays in the list
              // so the user can retry, and the count at the top stays accurate.
              setLoadStates(prev => ({ ...prev, [item.index]: 'error' }));
            }}
          />
        )}

        <Text style={styles.cardLabel}>דגם {item.index + 1}</Text>

        <Pressable
          style={({ pressed }) => [
            styles.deleteBtn,
            isThisDeleting && styles.deleteBtnBusy,
            !isThisDeleting && pressed && { opacity: 0.78 },
          ]}
          onPress={() => handleDelete(item)}
          disabled={isThisDeleting || deletingIndex !== null}
          accessibilityRole="button"
          accessibilityLabel={`מחק דגם מספר ${item.index + 1}`}
          accessibilityHint="מחיקה לצמיתות של הדגם הזה. הפעולה דורשת אישור"
          accessibilityState={{ disabled: isThisDeleting || deletingIndex !== null, busy: isThisDeleting }}
        >
          {isThisDeleting
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.deleteBtnText}>מחק דגם זה</Text>}
        </Pressable>
      </View>
    );
  }, [cardSize, deletingIndex, handleDelete, styles, loadStates, retryVariant]);

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
          <Text style={styles.emptyIcon}>✏️</Text>
          <Text style={styles.emptyTitle}>אין דגמים עבור ״{character}״</Text>
          <Text style={styles.emptyHint}>
            צלם או צייר את האות כדי שנוכל להשתמש בה{'\n'}בכתב היד האישי שלך.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.emptyCta, pressed && { opacity: 0.85 }]}
            onPress={handleAdd}
            accessibilityRole="button"
            accessibilityLabel={`צלם דגם ראשון של ${character}`}
          >
            <Text style={styles.emptyCtaText}>צלם דגם ראשון</Text>
          </Pressable>
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
          accessibilityRole="button"
          accessibilityLabel="צלם דגם חדש"
          accessibilityHint={`הוסף דגם נוסף של התו ${character}`}
        >
          <Text style={styles.addBtnText}>+ צלם דגם חדש</Text>
        </Pressable>
      </View>

      <AdBanner />
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
    headerSub:  { fontSize: 14, fontFamily: fonts.regular,   color: '#94A3B8', writingDirection: 'rtl' },

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
    cardImageError: {
      alignItems:      'center',
      justifyContent:  'center',
      backgroundColor: colors.bgPage,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    cardImageErrorIcon: {
      fontSize:     32,
      color:        colors.inkFaint,
      marginBottom: 6,
    },
    cardImageErrorText: {
      fontSize:         12,
      color:            colors.inkMid,
      fontFamily:       fonts.semiBold,
      writingDirection: 'rtl',
    },
    cardLabel: {
      fontSize: 12,
      fontFamily: fonts.semiBold,
      color: colors.inkMid,
      textAlign: 'center',
      writingDirection: 'rtl',
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
    deleteBtnText: { color: '#fff', fontSize: 12, fontFamily: fonts.bold, writingDirection: 'rtl' },

    // ── Empty state ──────────────────────────────────────────────────────────────
    emptyIcon: {
      fontSize: 56,
      opacity:  0.5,
      marginBottom: 12,
      textAlign: 'center',
    },
    emptyTitle: {
      fontSize: 18,
      fontFamily: fonts.bold,
      color: colors.inkMid,
      textAlign: 'center',
      marginBottom: 8,
      writingDirection: 'rtl',
    },
    emptyHint: {
      fontSize: 14,
      fontFamily: fonts.regular,
      color: colors.inkFaint,
      textAlign: 'center',
      writingDirection: 'rtl',
      lineHeight: 21,
      marginBottom: 20,
    },
    emptyCta: {
      backgroundColor:   colors.accent,
      paddingHorizontal: 28,
      paddingVertical:   14,
      borderRadius:      radius.md,
      ...shadow.btn,
    },
    emptyCtaText: {
      color:      '#fff',
      fontSize:   15,
      fontFamily: fonts.bold,
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
    addBtnText: { color: '#fff', fontSize: 17, fontFamily: fonts.bold, writingDirection: 'rtl' },
  });
}
