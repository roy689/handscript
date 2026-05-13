import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, fonts, radius, shadow } from '../theme';
import { impactLight } from '../utils/haptics';

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
type Size    = 'sm' | 'md' | 'lg';

interface Props {
  title:     string;
  onPress:   () => void;
  variant?:  Variant;
  size?:     Size;
  disabled?: boolean;
  loading?:  boolean;
  icon?:     string;
  fullWidth?: boolean;
}

const BG: Record<Variant, string> = {
  primary:   colors.accent,
  secondary: colors.inkMid,
  danger:    colors.danger,
  success:   colors.success,
  ghost:     'transparent',
};
const BORDER: Record<Variant, string> = {
  primary:   colors.accent,
  secondary: colors.inkMid,
  danger:    colors.danger,
  success:   colors.success,
  ghost:     colors.border,
};
const TEXT_COLOR: Record<Variant, string> = {
  primary:   '#fff',
  secondary: '#fff',
  danger:    '#fff',
  success:   '#fff',
  ghost:     colors.inkDark,
};

const PY: Record<Size, number> = { sm: 8, md: 13, lg: 17 };
const PX: Record<Size, number> = { sm: 14, md: 22, lg: 30 };
const FS: Record<Size, number> = { sm: 13, md: 15, lg: 17 };

export default function Button({
  title, onPress, variant = 'primary', size = 'md',
  disabled = false, loading = false, icon, fullWidth = false,
}: Props) {
  const busy = disabled || loading;

  return (
    <Pressable
      onPress={() => { impactLight(); onPress(); }}
      disabled={busy}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor:  BG[variant],
          borderColor:      BORDER[variant],
          paddingVertical:  PY[size],
          paddingHorizontal: PX[size],
          opacity: busy ? 0.52 : pressed ? 0.82 : 1,
          transform: pressed && !busy ? [{ scale: 0.975 }] : [],
          alignSelf: fullWidth ? 'stretch' : 'auto',
        },
        variant === 'primary' && !busy && shadow.btn,
      ]}
    >
      {loading
        ? <ActivityIndicator size="small" color={TEXT_COLOR[variant]} />
        : (
          <Text style={[styles.label, { fontSize: FS[size], color: TEXT_COLOR[variant] }]}>
            {icon ? `${icon}  ${title}` : title}
          </Text>
        )
      }
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1.5,
    minHeight: 36,
  },
  label: {
    fontFamily: fonts.bold,
    textAlign: 'center',
  },
});
