import React, { useRef, useState, useMemo } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { fonts, radius } from '../src/theme';
import { useTheme, type ThemeColors } from '../src/contexts/ThemeContext';
import { impactLight, impactMedium } from '../src/utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'Camera'>;

// Guide rectangle: 75% wide, 68% tall, shifted up to leave room for the button
const GUIDE_W_RATIO = 0.75;
const GUIDE_H_RATIO = 0.68;
const CORNER_LEN    = 26;
const CORNER_W      = 3;

export default function CameraScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);

  const { width: W, height: H } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef   = useRef<CameraView>(null);
  const [ready,     setReady]     = useState(false);
  const [photoUri,  setPhotoUri]  = useState<string | null>(null);

  const guideW = W * GUIDE_W_RATIO;
  const guideH = H * GUIDE_H_RATIO;
  const guideX = (W - guideW) / 2;
  const guideY = Math.max(0, (H - guideH) / 2 - 36); // shift up so button fits below (B27: clamp to 0)

  // ── Capture ────────────────────────────────────────────────────────────────
  async function handleCapture() {
    if (!cameraRef.current || !ready) return;
    impactMedium();
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, base64: false });
      if (!photo?.uri) throw new Error('no uri');
      const resized = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      );
      setPhotoUri(resized.uri);
    } catch {
      Alert.alert('שגיאה', 'הצילום נכשל, נסה שוב');
    }
  }

  // ── Use photo ──────────────────────────────────────────────────────────────
  function handleUsePhoto() {
    if (!photoUri) return;
    impactLight();
    navigation.navigate('Review', { photoUri });
  }

  // ── Permission loading ─────────────────────────────────────────────────────
  if (!permission) {
    return <View style={styles.root} />;
  }

  // ── Permission denied ──────────────────────────────────────────────────────
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.permIcon}>📷</Text>
        <Text style={styles.permTitle}>נדרשת גישה למצלמה</Text>
        <Text style={styles.permSub}>
          האפליקציה צריכה את המצלמה כדי לסרוק את כתב היד שלך
        </Text>
        <Pressable
          style={({ pressed }) => [styles.permBtn, pressed && { opacity: 0.82 }]}
          onPress={async () => {
            if (permission.canAskAgain) await requestPermission();
            else Linking.openSettings();
          }}
        >
          <Text style={styles.permBtnText}>
            {permission.canAskAgain ? 'אפשר גישה' : 'פתח הגדרות'}
          </Text>
        </Pressable>
      </View>
    );
  }

  // ── Photo preview ──────────────────────────────────────────────────────────
  if (photoUri) {
    return (
      <View style={styles.root}>
        <Image
          source={{ uri: photoUri }}
          style={{ width: W, height: H }}
          resizeMode="cover"
        />
        <View style={styles.actionBar}>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnGrey, pressed && { opacity: 0.82 }]}
            onPress={() => { impactLight(); setPhotoUri(null); }}
            accessibilityRole="button"
            accessibilityLabel="צלם שוב"
            accessibilityHint="ביטול התמונה הנוכחית וחזרה למצלמה"
          >
            <Text style={styles.btnText}>צלם שוב</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnBlue, pressed && { opacity: 0.85 }]}
            onPress={handleUsePhoto}
            accessibilityRole="button"
            accessibilityLabel="השתמש בתמונה"
            accessibilityHint="המשך עם התמונה לזיהוי תווים"
          >
            <Text style={styles.btnText}>השתמש בתמונה</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Live camera ────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>

      {/* Full-screen camera preview */}
      <CameraView
        ref={cameraRef}
        style={{ position: 'absolute', top: 0, left: 0, width: W, height: H }}
        facing="back"
        onCameraReady={() => setReady(true)}
      />

      {/* Dark strips around the guide rectangle */}
      <View style={[styles.strip, { top: 0,              left: 0, right: 0, height: guideY }]} />
      <View style={[styles.strip, { top: guideY + guideH, left: 0, right: 0, bottom: 0 }]} />
      <View style={[styles.strip, { top: guideY, left: 0, width: guideX, height: guideH }]} />
      <View style={[styles.strip, { top: guideY, left: guideX + guideW, right: 0, height: guideH }]} />

      {/* Guide rectangle with corner marks */}
      <View
        pointerEvents="none"
        style={[styles.guide, { top: guideY, left: guideX, width: guideW, height: guideH }]}
      >
        <View style={[styles.corner, styles.tl]} />
        <View style={[styles.corner, styles.tr]} />
        <View style={[styles.corner, styles.bl]} />
        <View style={[styles.corner, styles.br]} />
      </View>

      {/* Instruction text */}
      <View pointerEvents="none" style={[styles.hintRow, { top: guideY - 46 }]}>
        <Text style={styles.hintText}>מקם את הדף בתוך המסגרת</Text>
      </View>

      {/* Capture button */}
      <View style={styles.captureRow}>
        <Pressable
          onPress={handleCapture}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel={ready ? 'צלם תמונה' : 'ממתין למצלמה'}
          style={({ pressed }) => [
            styles.captureBtn,
            !ready  && styles.captureBtnOff,
            ready && pressed && { transform: [{ scale: 0.93 }] },
          ]}
        >
          <View style={[styles.captureInner, !ready && styles.captureInnerOff]} />
        </Pressable>
        <Text style={styles.captureLbl}>{ready ? 'צלם' : 'מאתחל...'}</Text>
      </View>

    </View>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root:   { flex: 1, backgroundColor: '#000' },
    center: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },

    // ── Permission ──────────────────────────────────────────────────────────────
    permIcon:  { fontSize: 52, marginBottom: 20 },
    permTitle: { fontSize: 20, fontFamily: fonts.bold, color: '#FFFFFF', textAlign: 'center', writingDirection: 'rtl', marginBottom: 10 },
    permSub:   { fontSize: 14, fontFamily: fonts.regular, color: 'rgba(255,255,255,0.60)', textAlign: 'center', writingDirection: 'rtl', lineHeight: 21, marginBottom: 32 },
    permBtn:   { backgroundColor: colors.accent, paddingHorizontal: 40, paddingVertical: 15, borderRadius: radius.md },
    permBtnText: { color: '#FFFFFF', fontSize: 16, fontFamily: fonts.bold, writingDirection: 'rtl' },

    // ── Overlay strips ──────────────────────────────────────────────────────────
    strip: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.60)' },

    // ── Guide rectangle ─────────────────────────────────────────────────────────
    guide: {
      position: 'absolute',
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.30)',
    },

    // ── Corner accents ──────────────────────────────────────────────────────────
    corner: { position: 'absolute', width: CORNER_LEN, height: CORNER_LEN, borderColor: '#fff' },
    tl: { top:    -CORNER_W/2, left:  -CORNER_W/2, borderTopWidth: CORNER_W,    borderLeftWidth:  CORNER_W,  borderBottomWidth: 0, borderRightWidth: 0 },
    tr: { top:    -CORNER_W/2, right: -CORNER_W/2, borderTopWidth: CORNER_W,    borderRightWidth: CORNER_W,  borderBottomWidth: 0, borderLeftWidth:  0 },
    bl: { bottom: -CORNER_W/2, left:  -CORNER_W/2, borderBottomWidth: CORNER_W, borderLeftWidth:  CORNER_W,  borderTopWidth:    0, borderRightWidth: 0 },
    br: { bottom: -CORNER_W/2, right: -CORNER_W/2, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W,  borderTopWidth:    0, borderLeftWidth:  0 },

    // ── Instruction ──────────────────────────────────────────────────────────────
    hintRow:  { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    hintText: {
      fontSize: 13, fontWeight: '600', color: '#fff', writingDirection: 'rtl',
      backgroundColor: 'rgba(0,0,0,0.52)', paddingHorizontal: 18, paddingVertical: 7,
      borderRadius: 20, overflow: 'hidden',
    },

    // ── Capture button ───────────────────────────────────────────────────────────
    captureRow: { position: 'absolute', bottom: 52, left: 0, right: 0, alignItems: 'center', gap: 10 },
    captureBtn: {
      width: 78, height: 78, borderRadius: 39,
      borderWidth: 4, borderColor: '#fff',
      justifyContent: 'center', alignItems: 'center',
    },
    captureBtnOff: { borderColor: 'rgba(255,255,255,0.30)' },
    captureInner:    { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
    captureInnerOff: { backgroundColor: 'rgba(255,255,255,0.30)' },
    captureLbl: { color: '#fff', fontSize: 14, fontWeight: '600', writingDirection: 'rtl' },

    // ── Preview buttons ──────────────────────────────────────────────────────────
    actionBar: { position: 'absolute', bottom: 52, left: 24, right: 24, flexDirection: 'row', gap: 14 },
    btn:       { flex: 1, paddingVertical: 16, borderRadius: radius.md, alignItems: 'center' },
    btnGrey:   { backgroundColor: 'rgba(255,255,255,0.13)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.45)' },
    btnBlue:   { backgroundColor: '#2563EB' },
    btnText:   { color: '#fff', fontSize: 16, fontFamily: fonts.bold, writingDirection: 'rtl' },
  });
}
