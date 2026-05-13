import React, { useEffect, useRef, useMemo } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme, ThemeColors } from '../contexts/ThemeContext';
import { fonts, radius, shadow } from '../theme';

interface Props {
  visible:  boolean;
  message?: string;
  submessage?: string;
}

export default function LoadingOverlay({
  visible,
  message    = 'טוען...',
  submessage,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue:         visible ? 1 : 0,
      duration:        180,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  // Keep in tree (to avoid layout cost on mount) but skip pointer events when hidden.
  return (
    <Animated.View
      style={[styles.overlay, { opacity }]}
      pointerEvents={visible ? 'box-only' : 'none'}
    >
      <View style={[styles.card, shadow.page]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.message}>{message}</Text>
        {submessage !== undefined && (
          <Text style={styles.submessage}>{submessage}</Text>
        )}
      </View>
    </Animated.View>
  );
}

function getStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(15,23,42,0.65)',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 999,
    },
    card: {
      backgroundColor: colors.bgSurface,
      borderRadius: radius.xl,
      paddingVertical: 32,
      paddingHorizontal: 48,
      alignItems: 'center',
      gap: 12,
      minWidth: 200,
    },
    message: {
      fontSize: 16,
      fontFamily: fonts.semiBold,
      color: colors.inkDark,
      writingDirection: 'rtl',
      textAlign: 'center',
    },
    submessage: {
      fontSize: 13,
      fontFamily: fonts.regular,
      color: colors.inkLight,
      writingDirection: 'rtl',
      textAlign: 'center',
    },
  });
}
