import React, { Component, ErrorInfo, ReactNode } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { colors, fonts, radius, shadow } from '../theme';

const SUPPORT_EMAIL = 'handscriptir@gmail.com';

interface Props {
  children: ReactNode;
  /** Optional screen/feature name shown in the error report email subject */
  context?: string;
}

interface State {
  error:     Error | null;
  errorInfo: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo });
    // In production you'd forward this to Sentry / Firebase Crashlytics
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  handleReport = () => {
    const { error, errorInfo } = this.state;
    const { context = 'App' } = this.props;

    const subject = encodeURIComponent(`[HandScript] שגיאה ב-${context}`);
    const body    = encodeURIComponent(
      `שלום,\n\nנתקלתי בשגיאה הבאה:\n\n` +
      `${error?.toString() ?? 'Unknown error'}\n\n` +
      `Stack:\n${errorInfo?.componentStack ?? '—'}\n\n` +
      `גרסה: ${Constants.expoConfig?.version ?? 'unknown'}`,
    );
    Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(
      () => console.warn('Could not open mail client'),
    );
  };

  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={styles.safe}>
          <View style={styles.container}>
            <Text style={styles.emoji}>📄</Text>
            <Text style={styles.title}>משהו השתבש</Text>
            <Text style={styles.subtitle}>
              אירעה שגיאה בלתי צפויה. אנחנו מצטערים על אי הנוחות.
            </Text>

            <View style={[styles.errorBox, shadow.card]}>
              <Text style={styles.errorText} numberOfLines={4} selectable>
                {this.state.error.toString()}
              </Text>
            </View>

            <View style={styles.btnGroup}>
              <Pressable
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnPrimary,
                  pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                ]}
                onPress={this.handleReset}
              >
                <Text style={styles.btnLabelPrimary}>נסה שוב</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnSecondary,
                  pressed && { opacity: 0.8 },
                ]}
                onPress={this.handleReport}
              >
                <Text style={styles.btnLabelSecondary}>דווח על בעיה</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bgPage,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  emoji: {
    fontSize: 56,
    marginBottom: 4,
  },
  title: {
    fontSize: 24,
    fontFamily: fonts.extraBold,
    color: colors.inkDark,
    writingDirection: 'rtl',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: colors.inkLight,
    textAlign: 'center',
    writingDirection: 'rtl',
    lineHeight: 22,
  },
  errorBox: {
    alignSelf: 'stretch',
    backgroundColor: colors.dangerLight,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: 14,
    marginVertical: 8,
  },
  errorText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.danger,
    lineHeight: 16,
  },
  btnGroup: {
    alignSelf: 'stretch',
    gap: 10,
    marginTop: 8,
  },
  btn: {
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    ...shadow.btn,
  },
  btnSecondary: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnLabelPrimary: {
    fontSize: 16,
    fontFamily: fonts.bold,
    color: '#FFFFFF',
    writingDirection: 'rtl',
  },
  btnLabelSecondary: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    color: colors.inkMid,
    writingDirection: 'rtl',
  },
});
