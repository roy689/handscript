import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Image,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fonts, radius } from '../src/theme';
import { impactMedium, impactLight } from '../src/utils/haptics';
import DrawingCanvas, { DrawingCanvasRef } from '../components/DrawingCanvas';

type Props = NativeStackScreenProps<RootStackParamList, 'CharacterCapture'>;

type CaptureMode = 'camera' | 'draw';

export default function CharacterCaptureScreen({ route, navigation }: Props) {
  const { character, totalSamples, existingSamples = [], returnTo } = route.params;
  const { width: W, height: H }     = useWindowDimensions();

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef    = useRef<CameraView>(null);
  const drawingRef   = useRef<DrawingCanvasRef>(null);

  const [ready,       setReady]       = useState(false);
  const [previewUri,  setPreviewUri]  = useState<string | null>(null);
  const [uris,        setUris]        = useState<string[]>([]);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('camera');
  const [capturing,   setCapturing]   = useState(false);

  const currentSample = uris.length + 1;

  // Guide frame: square, 55% of min(W,H), centered
  const frameSize = Math.min(W, H) * 0.55;
  const frameTop  = (H - frameSize) / 2 - 40;
  const frameLeft = (W - frameSize) / 2;

  // ── Permission ──────────────────────────────────────────────────────────────
  if (captureMode === 'camera') {
    if (!permission) return <View style={styles.root} />;
    if (!permission.granted) {
      return (
        <View style={[styles.root, styles.center]}>
          <Text style={styles.permText}>נדרשת גישה למצלמה</Text>
          <Pressable style={styles.permBtn} onPress={requestPermission}>
            <Text style={styles.permBtnText}>אפשר גישה</Text>
          </Pressable>
        </View>
      );
    }
  }

  // ── Camera capture ──────────────────────────────────────────────────────────
  async function handleCameraCapture() {
    if (!cameraRef.current || !ready) return;
    if (uris.length >= totalSamples) return;
    impactMedium();
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.92, base64: false });
      if (!photo?.uri) throw new Error('no uri');

      const pw = photo.width;
      const ph = photo.height;

      const displayScale = Math.max(W / pw, H / ph);
      const offsetX      = (pw * displayScale - W) / 2;
      const offsetY      = (ph * displayScale - H) / 2;

      const BORDER = 3;
      const innerLeft = frameLeft + BORDER;
      const innerTop  = frameTop  + BORDER;
      const innerSize = frameSize - BORDER * 2;

      const cropX = Math.round((innerLeft + offsetX) / displayScale);
      const cropY = Math.round((innerTop  + offsetY) / displayScale);
      const cropW = Math.round(innerSize  / displayScale);
      const cropH = Math.round(innerSize  / displayScale);

      const safeX = Math.max(0, Math.min(cropX, pw - 1));
      const safeY = Math.max(0, Math.min(cropY, ph - 1));
      const safeW = Math.min(cropW, pw - safeX);
      const safeH = Math.min(cropH, ph - safeY);

      const cropped = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ crop: { originX: safeX, originY: safeY, width: safeW, height: safeH } }],
        { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
      );

      setPreviewUri(cropped.uri);
    } catch {
      Alert.alert('שגיאה', 'הצילום נכשל, נסה שוב');
    }
  }

  // ── Draw capture ────────────────────────────────────────────────────────────
  async function handleDrawCapture() {
    if (!drawingRef.current || capturing) return;
    if (!drawingRef.current.hasStrokes()) {
      Alert.alert('', 'יש לצייר את התו תחילה');
      return;
    }
    impactMedium();
    setCapturing(true);
    try {
      // Capture the full canvas as PNG — no cropping on device.
      // The backend extracts and crops the character from the full image.
      const pngUri = await drawingRef.current.getImageUri();
      setPreviewUri(pngUri);
    } catch {
      Alert.alert('שגיאה', 'שמירת הציור נכשלה, נסה שוב');
    } finally {
      setCapturing(false);
    }
  }

  // ── Retake / save ───────────────────────────────────────────────────────────
  function handleRetake() {
    impactLight();
    setPreviewUri(null);
    if (captureMode === 'draw') {
      drawingRef.current?.clear();
    }
  }

  function handleSave() {
    if (!previewUri) return;
    impactLight();

    const newUris = [...uris, previewUri];
    setUris(newUris);
    setPreviewUri(null);

    if (captureMode === 'draw') {
      drawingRef.current?.clear();
    }

    if (newUris.length < totalSamples) return;

    navigation.navigate('CharacterSampleReview', {
      character,
      samples:      [...existingSamples, ...newUris],
      totalSamples: existingSamples.length + totalSamples,
      returnTo,
    });
  }

  // ── Mode switch ─────────────────────────────────────────────────────────────
  function switchMode(mode: CaptureMode) {
    if (mode === captureMode) return;
    setPreviewUri(null);
    setCaptureMode(mode);
    if (mode === 'draw') {
      setTimeout(() => drawingRef.current?.clear(), 100);
    }
  }

  // ── Preview screen (shared by both modes) ───────────────────────────────────
  if (previewUri) {
    return (
      <View style={styles.root}>
        <Image source={{ uri: previewUri }} style={{ width: W, height: H }} resizeMode="contain" />

        <View style={styles.previewHdr}>
          <Text style={styles.previewChar}>{character}</Text>
          <Text style={styles.previewProgress}>
            דגימה {currentSample} מתוך {totalSamples}
          </Text>
        </View>

        <View style={styles.previewActions}>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnGrey, pressed && { opacity: 0.8 }]}
            onPress={handleRetake}
          >
            <Text style={styles.btnText}>
              {captureMode === 'draw' ? 'צייר שוב' : 'צלם שוב'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, styles.btnGreen, pressed && { opacity: 0.85 }]}
            onPress={handleSave}
          >
            <Text style={styles.btnText}>
              {currentSample < totalSamples ? 'שמור והמשך' : 'שמור וסיים'}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Mode toggle bar ─────────────────────────────────────────────────────────
  const ModeToggle = () => (
    <View style={styles.modeBar}>
      <Pressable
        style={[styles.modeTab, captureMode === 'camera' && styles.modeTabActive]}
        onPress={() => switchMode('camera')}
      >
        <Text style={[styles.modeTabText, captureMode === 'camera' && styles.modeTabTextActive]}>
          📷  צלם
        </Text>
      </Pressable>
      <Pressable
        style={[styles.modeTab, captureMode === 'draw' && styles.modeTabActive]}
        onPress={() => switchMode('draw')}
      >
        <Text style={[styles.modeTabText, captureMode === 'draw' && styles.modeTabTextActive]}>
          ✏️  צייר
        </Text>
      </Pressable>
    </View>
  );

  // ── Draw mode UI ─────────────────────────────────────────────────────────────
  if (captureMode === 'draw') {
    return (
      <View style={[styles.root, { backgroundColor: '#1a1a2e' }]}>
        {/* Character label */}
        <View style={[styles.charLabel, { top: frameTop - 80 }]}>
          <Text style={styles.charLabelGlyph}>{character}</Text>
        </View>

        {/* Drawing canvas */}
        <View style={[styles.canvasWrapper, { top: frameTop, left: frameLeft }]}>
          <DrawingCanvas ref={drawingRef} size={frameSize} />

          {/* Guide lines — rendered on top of canvas but outside ViewShot, not captured */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {/* Cap-height guide at 18% */}
            <View style={{
              position: 'absolute', top: frameSize * 0.18,
              left: 0, right: 0, height: 1,
              backgroundColor: 'rgba(180,140,100,0.35)',
            }} />
            {/* Baseline guide at 62% */}
            <View style={{
              position: 'absolute', top: frameSize * 0.62,
              left: 0, right: 0, height: 1,
              backgroundColor: 'rgba(180,140,100,0.55)',
            }} />
          </View>

          {/* Clear button */}
          <Pressable
            style={styles.clearBtn}
            onPress={() => drawingRef.current?.clear()}
          >
            <Text style={styles.clearBtnText}>🗑 נקה</Text>
          </Pressable>
        </View>

        {/* Progress pill */}
        <View style={[styles.progressPill, { top: frameTop + frameSize + 16 }]}>
          <Text style={styles.progressText}>דגימה {currentSample} מתוך {totalSamples}</Text>
        </View>

        {/* Capture button */}
        <View style={styles.captureRow}>
          <Pressable
            onPress={handleDrawCapture}
            disabled={capturing}
            style={({ pressed }) => [
              styles.captureBtn,
              capturing && styles.captureBtnOff,
              !capturing && pressed && { transform: [{ scale: 0.93 }] },
            ]}
          >
            <View style={[styles.captureInner, capturing && styles.captureInnerOff]} />
          </Pressable>
          <Text style={styles.captureLbl}>{capturing ? 'שומר...' : 'שמור ציור'}</Text>
        </View>

        {/* Mode toggle */}
        <ModeToggle />
      </View>
    );
  }

  // ── Camera mode UI ───────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={{ position: 'absolute', top: 0, left: 0, width: W, height: H }}
        facing="back"
        onCameraReady={() => setReady(true)}
      />

      {/* Dark overlay — 4 strips around the guide frame */}
      <View style={[styles.strip, { top: 0, left: 0, right: 0, height: frameTop }]} />
      <View style={[styles.strip, { top: frameTop + frameSize, left: 0, right: 0, bottom: 0 }]} />
      <View style={[styles.strip, { top: frameTop, left: 0, width: frameLeft, height: frameSize }]} />
      <View style={[styles.strip, { top: frameTop, left: frameLeft + frameSize, right: 0, height: frameSize }]} />

      {/* Character display above frame */}
      <View style={[styles.charLabel, { top: frameTop - 80 }]}>
        <Text style={styles.charLabelGlyph}>{character}</Text>
      </View>

      {/* Guide frame */}
      <View
        pointerEvents="none"
        style={[styles.guideFrame, { top: frameTop, left: frameLeft, width: frameSize, height: frameSize }]}
      />

      {/* Progress pill */}
      <View style={[styles.progressPill, { top: frameTop + frameSize + 16 }]}>
        <Text style={styles.progressText}>דגימה {currentSample} מתוך {totalSamples}</Text>
      </View>

      {/* Capture button */}
      <View style={styles.captureRow}>
        <Pressable
          onPress={handleCameraCapture}
          disabled={!ready}
          style={({ pressed }) => [
            styles.captureBtn,
            !ready && styles.captureBtnOff,
            ready && pressed && { transform: [{ scale: 0.93 }] },
          ]}
        >
          <View style={[styles.captureInner, !ready && styles.captureInnerOff]} />
        </Pressable>
        <Text style={styles.captureLbl}>{ready ? 'צלם' : 'מאתחל...'}</Text>
      </View>

      {/* Mode toggle */}
      <ModeToggle />
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#000' },
  center: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },

  // Permission
  permText:    { fontSize: 18, color: '#fff', textAlign: 'center', marginBottom: 20, fontFamily: fonts.semiBold },
  permBtn:     { backgroundColor: colors.accent, paddingHorizontal: 32, paddingVertical: 14, borderRadius: radius.md },
  permBtnText: { color: '#fff', fontSize: 16, fontFamily: fonts.bold },

  // Overlay strips
  strip: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.62)' },

  // Character label above frame
  charLabel: {
    position: 'absolute',
    left: 0, right: 0,
    alignItems: 'center',
  },
  charLabelGlyph: {
    fontSize: 56,
    fontFamily: fonts.extraBold,
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },

  // Guide frame
  guideFrame: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: colors.accent,
    borderRadius: radius.md,
  },

  // Drawing canvas wrapper (positioned same as guide frame)
  canvasWrapper: {
    position: 'absolute',
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: colors.accent,
  },

  // Clear button (top-right of canvas)
  clearBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  clearBtnText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: fonts.semiBold,
  },

  // Progress
  progressPill: {
    position: 'absolute',
    left: 0, right: 0,
    alignItems: 'center',
  },
  progressText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    overflow: 'hidden',
  },

  // Capture button
  captureRow: {
    position: 'absolute', bottom: 104, left: 0, right: 0,
    alignItems: 'center', gap: 8,
  },
  captureBtn: {
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 4, borderColor: '#fff',
    justifyContent: 'center', alignItems: 'center',
  },
  captureBtnOff:    { borderColor: 'rgba(255,255,255,0.3)' },
  captureInner:     { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  captureInnerOff:  { backgroundColor: 'rgba(255,255,255,0.3)' },
  captureLbl:       { color: '#fff', fontSize: 14, fontFamily: fonts.semiBold },

  // Mode toggle bar
  modeBar: {
    position: 'absolute',
    bottom: 36,
    alignSelf: 'center',
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 24,
    padding: 4,
    gap: 4,
  },
  modeTab: {
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: 20,
  },
  modeTabActive: {
    backgroundColor: colors.accent,
  },
  modeTabText: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    color: 'rgba(255,255,255,0.65)',
  },
  modeTabTextActive: {
    color: '#fff',
  },

  // Preview
  previewHdr: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingTop: 52, paddingBottom: 16,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
  },
  previewChar:     { fontSize: 48, fontFamily: fonts.extraBold, color: '#fff' },
  previewProgress: { fontSize: 14, fontFamily: fonts.semiBold, color: '#93C5FD', marginTop: 4 },

  previewActions: {
    position: 'absolute', bottom: 44, left: 24, right: 24,
    flexDirection: 'row', gap: 12,
  },
  btn:      { flex: 1, paddingVertical: 16, borderRadius: radius.md, alignItems: 'center' },
  btnGrey:  { backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)' },
  btnGreen: { backgroundColor: colors.success },
  btnText:  { color: '#fff', fontSize: 16, fontFamily: fonts.bold },
});
