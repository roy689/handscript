/**
 * @deprecated PaywallModal is not used anywhere in the app.
 *
 * Pro subscriptions are surfaced through `PaywallScreen` (in `screens/`),
 * which is opened as a modal-presentation route by the navigator. The
 * full-screen Paywall provides clearer UX than a small modal.
 *
 * This file is kept as a stub to prevent broken imports if anyone copied
 * older references. Do not import — use the `Paywall` route instead:
 *
 *   navigation.navigate('Paywall');
 *
 * If you confirm nothing references this file, it can be deleted entirely.
 */

export default function PaywallModal(): null {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      '[PaywallModal] This component is deprecated. ' +
      'Use navigation.navigate("Paywall") instead.',
    );
  }
  return null;
}
