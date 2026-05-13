/**
 * HandwritingOverlay — full-screen immersive loading screen shown while the
 * backend converts text into handwriting.
 *
 * Design language: "Ink & Parchment" — mirrors the rest of the app.
 * Animation: a pen tip sweeps RTL across three ruled lines, leaving an ink
 * trail that fades in behind it. Each line restarts with a small phase offset
 * so the motion feels continuous.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  Dimensions,
  Platform,
} from 'react-native';
import { useTheme, type ThemeColors } from '../contexts/ThemeContext';
import { fonts, radius, shadow } from '../theme';

interface Props {
  visible: boolean;
}

const { width: SW, height: SH } = Dimensions.get('window');

// ── geometry ──────────────────────────────────────────────────────────────────
const LINE_HPAD  = 40;           // padding each side
const LINE_W     = SW - LINE_HPAD * 2;
const LINE_GAP   = 58;           // vertical gap between writing lines
const NUM_LINES  = 3;
const PEN_W      = 22;
const PEN_H      = 34;
const CYCLE_MS   = 2400;         // duration of one RTL sweep
const PHASE_MS   = 320;          // phase offset per line

// ── helpers ───────────────────────────────────────────────────────────────────

/** Single animated writing line (ink trail + pen nib) */
function WritingLine({
  colors,
  progress,
  delay,
}: {
  colors: ThemeColors;
  progress: Animated.Value;   // 0 → 1
  delay: number;              // ms before this line's animation starts in the loop
}) {
  const styles = useMemo(() => getLineStyles(colors), [colors]);

  // Pen starts at the RIGHT end and sweeps LEFT (RTL direction)
  const penX = progress.interpolate({
    inputRange:  [0, 1],
    outputRange: [LINE_W - PEN_W, 0],   // right edge → left edge
  });

  // Ink reveal: a full-width bar, clipped by overflow:hidden on parent.
  // translateX from -LINE_W (fully hidden left) → 0 (fully revealed).
  const inkX = progress.interpolate({
    inputRange:  [0, 1],
    outputRange: [-LINE_W, 0],
  });

  // Pen nib opacity: visible only while sweeping, hides after sweep
  const nibOpacity = progress.interpolate({
    inputRange:  [0, 0.02, 0.97, 1],
    outputRange: [0,  1,    1,   0],
  });

  return (
    <View style={styles.row}>
      {/* Ruled baseline */}
      <View style={styles.baseline} />

      {/* Ink trail (revealed RTL by clip trick) */}
      <View style={styles.inkClip}>
        <Animated.View
          style={[
            styles.inkLine,
            { transform: [{ translateX: inkX }] },
          ]}
        />
      </View>

      {/* Pen nib moves RTL */}
      <Animated.View
        style={[
          styles.pen,
          {
            opacity:   nibOpacity,
            transform: [{ translateX: penX }],
          },
        ]}
      >
        {/* pen body */}
        <View style={styles.penBody} />
        {/* pen nib triangle */}
        <View style={styles.penNib} />
        {/* ink dot at nib tip */}
        <View style={styles.penDot} />
      </Animated.View>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HandwritingOverlay({ visible }: Props) {
  const { colors } = useTheme();
  const styles     = useMemo(() => getStyles(colors), [colors]);

  // Fade the overlay in/out
  const overlayFade = useRef(new Animated.Value(0)).current;

  // One Animated.Value per writing line (each loops independently)
  const lineValues = useRef(
    Array.from({ length: NUM_LINES }, () => new Animated.Value(0)),
  ).current;

  // Gentle pulse on the status text
  const textPulse = useRef(new Animated.Value(1)).current;

  // Refs to cancel loops on unmount / hide
  const loopRefs   = useRef<Animated.CompositeAnimation[]>([]);
  const pulseRef   = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (visible) {
      // Fade overlay in
      Animated.timing(overlayFade, {
        toValue: 1, duration: 350, useNativeDriver: true,
      }).start();

      // Launch each writing-line loop with a phase offset
      lineValues.forEach((val, i) => {
        val.setValue(0);
        const loop = Animated.loop(
          Animated.sequence([
            Animated.delay(i * PHASE_MS),
            Animated.timing(val, {
              toValue:         1,
              duration:        CYCLE_MS,
              easing:          Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.delay(280),
            Animated.timing(val, {
              toValue: 0, duration: 0, useNativeDriver: true,
            }),
            Animated.delay(80 - i * PHASE_MS < 0 ? 0 : 80 - i * PHASE_MS),
          ]),
        );
        loop.start();
        loopRefs.current[i] = loop;
      });

      // Text pulse
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(textPulse, { toValue: 0.65, duration: 1100, useNativeDriver: true }),
          Animated.timing(textPulse, { toValue: 1,    duration: 1100, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      pulseRef.current = pulse;

    } else {
      // Fade out
      Animated.timing(overlayFade, {
        toValue: 0, duration: 220, useNativeDriver: true,
      }).start();

      // Stop loops
      loopRefs.current.forEach(l => l.stop());
      pulseRef.current?.stop();
    }

    return () => {
      loopRefs.current.forEach(l => l.stop());
      pulseRef.current?.stop();
    };
  }, [visible]);

  return (
    <Animated.View
      style={[styles.overlay, { opacity: overlayFade }]}
      pointerEvents={visible ? 'box-only' : 'none'}
    >
      {/* Parchment paper texture — faint ruled lines in background */}
      {Array.from({ length: 14 }, (_, i) => (
        <View key={i} style={[styles.bgRule, { top: 56 + i * 46 }]} />
      ))}
      {/* Red margin stripe */}
      <View style={styles.bgMargin} />

      {/* ── Center card ─────────────────────────────────────────────────── */}
      <View style={[styles.card, shadow.page]}>

        {/* Writing animation area */}
        <View style={styles.writingArea}>
          {lineValues.map((val, i) => (
            <WritingLine
              key={i}
              colors={colors}
              progress={val}
              delay={i * PHASE_MS}
            />
          ))}
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Status text */}
        <View style={styles.textBlock}>
          <Text style={styles.title}>כתב היד שלך נוצר כעת</Text>
          <Animated.View style={{ opacity: textPulse }}>
            <Text style={styles.subtitle}>עיבוד גלופים והרכבת הדף...</Text>
          </Animated.View>
          <Text style={styles.hint}>זה עשוי לקחת מספר שניות</Text>
        </View>

      </View>
    </Animated.View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.bgPage,
      zIndex:          1000,
      justifyContent:  'center',
      alignItems:      'center',
    },
    bgRule: {
      position:        'absolute',
      left:            0,
      right:           0,
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.borderFaint,
    },
    bgMargin: {
      position:        'absolute',
      top:             0,
      bottom:          0,
      right:           SW * 0.14,
      width:           StyleSheet.hairlineWidth,
      backgroundColor: 'rgba(180,90,10,0.10)',
    },
    card: {
      width:            SW - 48,
      backgroundColor:  colors.bgSurface,
      borderRadius:     radius.xl,
      borderWidth:      1,
      borderColor:      colors.border,
      paddingTop:       28,
      paddingBottom:    32,
      paddingHorizontal: 0,
      alignItems:       'center',
    },
    writingArea: {
      width:      '100%',
      paddingHorizontal: LINE_HPAD,
      gap:        LINE_GAP - 18,   // gap between writing rows
      marginBottom: 4,
    },
    divider: {
      width:           '78%',
      height:          StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical:  20,
    },
    textBlock: {
      alignItems:      'center',
      paddingHorizontal: 24,
      gap:             6,
    },
    title: {
      fontSize:         18,
      fontFamily:       fonts.bold,
      color:            colors.inkDark,
      writingDirection: 'rtl',
      textAlign:        'center',
      letterSpacing:    0.2,
    },
    subtitle: {
      fontSize:         13,
      fontFamily:       fonts.regular,
      color:            colors.inkMid,
      writingDirection: 'rtl',
      textAlign:        'center',
    },
    hint: {
      fontSize:         11,
      fontFamily:       fonts.regular,
      color:            colors.inkFaint,
      writingDirection: 'rtl',
      textAlign:        'center',
      marginTop:        2,
    },
  });
}

function getLineStyles(colors: ThemeColors) {
  const inkColor = colors.accent;  // Prussian blue ink
  return StyleSheet.create({
    row: {
      width:    LINE_W,
      height:   PEN_H + 8,
      position: 'relative',
    },
    baseline: {
      position:        'absolute',
      bottom:          10,
      left:            0,
      right:           0,
      height:          1.2,
      backgroundColor: colors.borderFaint,
    },
    inkClip: {
      position:   'absolute',
      bottom:     10,
      left:       0,
      right:      0,
      height:     2,
      overflow:   'hidden',
    },
    inkLine: {
      position:        'absolute',
      top:             0,
      left:            0,
      width:           LINE_W,
      height:          2,
      backgroundColor: inkColor,
      opacity:         0.75,
      borderRadius:    1,
    },
    pen: {
      position: 'absolute',
      bottom:   6,
      left:     0,
      width:    PEN_W,
      height:   PEN_H,
      alignItems: 'center',
    },
    penBody: {
      width:           14,
      height:          20,
      backgroundColor: inkColor,
      borderRadius:    3,
      opacity:         0.92,
    },
    penNib: {
      width:       0,
      height:      0,
      borderLeftWidth:  7,
      borderRightWidth: 7,
      borderTopWidth:   10,
      borderLeftColor:  'transparent',
      borderRightColor: 'transparent',
      borderTopColor:   inkColor,
      opacity:          0.92,
    },
    penDot: {
      width:           4,
      height:          4,
      borderRadius:    2,
      backgroundColor: inkColor,
      opacity:         0.5,
      marginTop:       1,
    },
  });
}
