const SLOW_THRESHOLD_MS = 1000;

export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - t0;
    if (elapsed > SLOW_THRESHOLD_MS) {
      console.warn(`[perf] ${label} took ${elapsed}ms`);
    }
  }
}
