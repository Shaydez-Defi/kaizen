/**
 * Data-fetching hooks: abortable async loads with explicit loading/error
 * state, and a pausable interval for bounded polling.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Refetch (aborts any in-flight request). */
  reload: () => void;
}

/**
 * Run `fn` whenever `deps` change or `reload()` is called. The previous
 * request is aborted; only the latest result is applied (no out-of-order
 * renders). Non-ApiError failures are normalized to ApiError.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    fnRef
      .current(controller.signal)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
      })
      .finally(() => {
        if (alive && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}

/**
 * Interval that pauses when `delayMs` is null (e.g. nothing to poll) and
 * cleans up on unmount. `callback` always sees the latest closure.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delayMs === null) return undefined;
    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}
