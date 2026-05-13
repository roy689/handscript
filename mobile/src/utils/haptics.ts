import * as Haptics from 'expo-haptics';

/** Light tap — standard button press */
export function impactLight() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Medium tap — destructive or primary actions */
export function impactMedium() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Success notification — save/export completed */
export function notifySuccess() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Error notification — action failed */
export function notifyError() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

/** Warning — soft caution */
export function notifyWarning() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}
