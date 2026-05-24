/**
 * telemetry.ts — On-device error ring buffer.
 *
 * Errors are stored in AsyncStorage (last 50). Nothing leaves the device
 * automatically — call flushToBackend() explicitly if you add a /telemetry
 * endpoint later.
 *
 * Usage:
 *   import { logError, setupGlobalErrorHandler } from '../utils/telemetry';
 *
 *   // App.tsx (once at startup):
 *   setupGlobalErrorHandler();
 *
 *   // Any catch block:
 *   await logError(err, 'handleConvert');
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY        = '@hs_error_log';
const MAX_EVENTS = 50;

type TelemetryEvent = {
  msg:    string;
  ctx?:   string;
  ts:     number;
  stack?: string;
};

/**
 * Append an error to the on-device ring buffer.
 * Never throws — telemetry must not interfere with the caller.
 */
export async function logError(err: unknown, ctx?: string): Promise<void> {
  try {
    const event: TelemetryEvent = {
      msg:   err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack   : undefined,
      ctx,
      ts:    Date.now(),
    };
    const raw    = await AsyncStorage.getItem(KEY);
    const events = raw ? (JSON.parse(raw) as TelemetryEvent[]) : [];
    events.unshift(event);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    await AsyncStorage.setItem(KEY, JSON.stringify(events));
  } catch {
    // intentional no-op
  }
}

/**
 * Return all stored events (newest first). Useful for a debug screen.
 */
export async function getErrorLog(): Promise<TelemetryEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * Hook into React Native's global uncaught-error handler.
 * Call once in App.tsx before the component tree renders.
 */
export function setupGlobalErrorHandler(): void {
  if (typeof ErrorUtils === 'undefined') return;
  const prev = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    logError(error, isFatal ? 'fatal' : 'uncaught').catch(() => {});
    prev(error, isFatal);
  });
}
