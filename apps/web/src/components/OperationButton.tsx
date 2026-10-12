/**
 * Button that runs an async backend operation: disables while in flight,
 * shows progress, surfaces the OperationResult error inline. The UI never
 * optimistically claims success — the result comes from the engine.
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { OperationResponse } from '../api/types';

export function OperationButton({
  onRun,
  children,
  className = 'btn',
  disabled = false,
  busyLabel = 'Working…',
  onFinished,
}: {
  onRun: () => Promise<OperationResponse>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  busyLabel?: string;
  onFinished?: (ok: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await onRun();
      if (!mounted.current) return;
      if (!res.ok) {
        setError(`${res.result.error?.code ?? 'FAILED'}: ${res.result.error?.message ?? 'operation failed'}`);
      }
      onFinished?.(res.ok);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      onFinished?.(false);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <span className="op-button">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        onClick={() => void run()}
      >
        {busy ? busyLabel : children}
      </button>
      {error ? (
        <span className="op-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
