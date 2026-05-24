/**
 * telemetry.ts — Client error reporting
 *
 * Sends client-side errors to backend for debugging in production.
 * Non-critical: if reporting fails, it fails silently.
 */

import { BACKEND_URL } from '../config';
import { getAuthToken } from '../utils/api';

interface ErrorPayload {
  message: string;
  stack?: string;
  context: string;
  timestamp: string;
  userId?: string;
}

/**
 * Report an error to the backend for debugging.
 * Non-blocking: fails silently if network/backend is down.
 */
export async function reportError(error: unknown, context: string): Promise<void> {
  try {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const userId = await getAuthToken().then(() => 'authenticated').catch(() => undefined);

    const payload: ErrorPayload = {
      message: msg,
      stack,
      context,
      timestamp: new Date().toISOString(),
      userId,
    };

    await fetch(`${BACKEND_URL}/debug/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently fail — don't let error reporting errors propagate
  }
}

/**
 * Wrap a function to report errors automatically.
 * Usage: const safeFunc = withErrorReporting(myFunc, 'my-context');
 */
export function withErrorReporting<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  context: string,
): T {
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      await reportError(err, context);
      throw err;
    }
  }) as T;
}
