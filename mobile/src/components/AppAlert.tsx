/**
 * AppAlert — Custom alert dialog matching HandScript's Ink & Parchment aesthetic.
 *
 * Drop-in replacement for React Native's Alert.alert:
 *   import { showAlert } from '../utils/alert';
 *   showAlert('כותרת', 'הודעה', [{ text: 'אישור', onPress: ... }]);
 *
 * Mount <AppAlertHost /> once at the app root (inside ThemeContext).
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { fonts, radius, shadow } from '../../src/theme';

// ── Public types (mirrors Alert.alert signature) ──────────────────────────────

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface AppAlertButton {
  text: string;
  style?: AlertButtonStyle;
  onPress?: () => void;
}

interface AlertConfig {
  title: string;
  message?: string;
  buttons: AppAlertButton[];
}

// ── Singleton registration ────────────────────────────────────────────────────

type ShowFn = (config: AlertConfig) => void;
let _show: ShowFn | null = null;

/**
 * showAlert — call from anywhere (callbacks, effects, event handlers).
 * Falls back to native Alert if the host is not yet mounted.
 */
export function showAlert(
  title: string,
  message?: string,
  buttons?: AppAlertButton[],
): void {
  const btns = buttons && buttons.length > 0 ? buttons : [{ text: 'אישור' }];

  if (!_show) {
    // Fallback to native Alert if AppAlertHost is not mounted yet
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Alert } = require('react-native');
    Alert.alert(title, message, btns);
    return;
  }

  _show({ title, message, buttons: btns });
}

// ── Host component — mount once in App.tsx ────────────────────────────────────

export function AppAlertHost() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [config,  setConfig]  = useState<AlertConfig | null>(null);
  const [visible, setVisible] = useState(false);

  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const cardScale       = useRef(new Animated.Value(0.88)).current;
  const cardOpacity     = useRef(new Animated.Value(0)).current;

  // Register this instance as the global singleton
  useEffect(() => {
    _show = (cfg) => {
      setConfig(cfg);
      setVisible(true);
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1, duration: 200, useNativeDriver: true,
        }),
        Animated.spring(cardScale, {
          toValue: 1, tension: 200, friction: 22, useNativeDriver: true,
        }),
        Animated.timing(cardOpacity, {
          toValue: 1, duration: 180, useNativeDriver: true,
        }),
      ]).start();
    };
    return () => { _show = null; };
  }, [backdropOpacity, cardScale, cardOpacity]);

  const dismiss = useCallback((onPress?: () => void) => {
    Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: 0, duration: 160, useNativeDriver: true,
      }),
      Animated.timing(cardOpacity, {
        toValue: 0, duration: 140, useNativeDriver: true,
      }),
      Animated.timing(cardScale, {
        toValue: 0.9, duration: 150, useNativeDriver: true,
      }),
    ]).start(() => {
      setVisible(false);
      setConfig(null);
      cardScale.setValue(0.88);
      onPress?.();
    });
  }, [backdropOpacity, cardOpacity, cardScale]);

  if (!config) return null;

  const buttons = config.buttons;
  const isStacked = buttons.length > 2;

  const cancelBtn = buttons.find(b => b.style === 'cancel');

  return (
    <Modal
      transparent
      visible={visible}
      statusBarTranslucent
      animationType="none"
      onRequestClose={() => dismiss(cancelBtn?.onPress)}
    >
      {/* Backdrop */}
      <Animated.View
        style={[styles.backdrop, { opacity: backdropOpacity }]}
        pointerEvents="box-none"
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => dismiss(cancelBtn?.onPress)}
        />

        {/* Card */}
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: colors.bgSurface,
              borderColor:     colors.border,
              transform:       [{ scale: cardScale }],
              opacity:         cardOpacity,
              marginBottom:    Math.max(insets.bottom, 12),
            },
            shadow.page,
          ]}
        >
          {/* Content area */}
          <View style={styles.content}>
            {/* Title */}
            <Text style={[styles.title, { color: colors.inkDark }]}>
              {config.title}
            </Text>

            {/* Message */}
            {config.message ? (
              <Text style={[styles.message, { color: colors.inkMid }]}>
                {config.message}
              </Text>
            ) : null}
          </View>

          {/* Divider */}
          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          {/* Buttons */}
          <View style={[styles.btnRow, isStacked && styles.btnRowStacked]}>
            {buttons.map((btn, i) => {
              const isDestructive = btn.style === 'destructive';
              const isCancel      = btn.style === 'cancel';
              const textColor     = isDestructive
                ? colors.danger
                : isCancel
                  ? colors.inkMid
                  : colors.accent;

              return (
                <React.Fragment key={i}>
                  {/* Divider between buttons */}
                  {i > 0 && (
                    <View
                      style={[
                        isStacked ? styles.btnDividerH : styles.btnDividerV,
                        { backgroundColor: colors.border },
                      ]}
                    />
                  )}

                  <Pressable
                    style={({ pressed }) => [
                      styles.btn,
                      isStacked && styles.btnStacked,
                      buttons.length === 1 && styles.btnSolo,
                      pressed && { backgroundColor: colors.borderFaint },
                    ]}
                    onPress={() => dismiss(btn.onPress)}
                    accessibilityRole="button"
                    accessibilityLabel={btn.text}
                  >
                    <Text
                      style={[
                        styles.btnText,
                        { color: textColor },
                        isDestructive && styles.btnTextDestructive,
                        isCancel      && styles.btnTextCancel,
                      ]}
                    >
                      {btn.text}
                    </Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 13, 11, 0.62)',
    justifyContent:  'center',
    alignItems:      'center',
    paddingHorizontal: 32,
  },

  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },

  content: {
    paddingTop:        28,
    paddingBottom:     20,
    paddingHorizontal: 24,
    alignItems:        'center',
    gap:               8,
  },

  title: {
    fontFamily: fonts.bold,
    fontSize:   17,
    textAlign:  'center',
    lineHeight: 24,
  },

  message: {
    fontFamily: fonts.regular,
    fontSize:   14,
    textAlign:  'center',
    lineHeight: 20,
  },

  divider: {
    height: 1,
  },

  // ── Button layout ─────────────────────────────────────────────────────────

  btnRow: {
    flexDirection: 'row',
  },
  btnRowStacked: {
    flexDirection: 'column',
  },

  btn: {
    flex:            1,
    paddingVertical: 14,
    alignItems:      'center',
    justifyContent:  'center',
    minHeight:       48,
  },
  btnStacked: {
    flex: 0,
  },
  btnSolo: {
    flex: 1,
  },

  btnDividerV: {
    width: 1,
    alignSelf: 'stretch',
  },
  btnDividerH: {
    height: 1,
  },

  // ── Button text ───────────────────────────────────────────────────────────

  btnText: {
    fontFamily: fonts.semiBold,
    fontSize:   15,
    textAlign:  'center',
  },
  btnTextDestructive: {
    fontFamily: fonts.bold,
  },
  btnTextCancel: {
    fontFamily: fonts.regular,
  },
});
