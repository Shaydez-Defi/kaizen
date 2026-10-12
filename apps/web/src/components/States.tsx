/** Shared page-state components: loading, empty, error, disconnected. */

import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../api/client';
import type { EventStreamStatus } from '../api/events';

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <span className="spinner-dot" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="state-block" data-testid="loading-state">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="state-block empty" data-testid="empty-state">
      <h3>{title}</h3>
      {description ? <p className="muted">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="state-block error" role="alert" data-testid="error-state">
      <h3>Request failed</h3>
      <p>
        <code>{error.code}</code> — {error.message}
      </p>
      {error.issues.length > 0 ? (
        <ul className="issues">
          {error.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Banner shown whenever the live event stream is not open. REST still works
 * (pages keep loading real data), but realtime updates may be delayed — the
 * UI says so instead of implying everything is live.
 */
export function ConnectionBanner({ status }: { status: EventStreamStatus }): JSX.Element | null {
  if (status === 'open') return null;
  const text =
    status === 'connecting'
      ? 'Connecting to the event stream…'
      : status === 'reconnecting'
        ? 'Live updates interrupted — reconnecting. Data shown may be briefly stale.'
        : 'Live updates are disconnected. Data shown may be stale.';
  return (
    <div className={`banner banner-${status === 'closed' ? 'danger' : 'warn'}`} role="status">
      <span className="banner-dot" aria-hidden="true" /> {text}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link to={to} className="back-link">
      ← {children}
    </Link>
  );
}
