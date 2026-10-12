/**
 * WebSocket event stream client (T-2.5/E).
 *
 * - single socket per stream (callers subscribe; they never open sockets)
 * - automatic reconnect with capped backoff + jitter
 * - `onResync` fires after every successful RE-connect: the server does not
 *   replay missed events, so consumers must refetch REST state instead of
 *   pretending the gap never happened (never fabricate continuity)
 * - explicit close() and last-unsubscribe teardown; no leaked timers
 */

import type { KaizenEventName } from './types';

export type EventStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type EventListener = (event: { name: KaizenEventName; payload: unknown }) => void;
export type StatusListener = (status: EventStreamStatus) => void;
export type ResyncListener = () => void;

/** Derive the engine event-stream URL from an API base URL ('' = same origin). */
export function eventsWsUrl(baseUrl = ''): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (!trimmed) {
    if (typeof location === 'undefined') return 'ws://127.0.0.1:4310/api/events';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/api/events`;
  }
  // baseUrl is an origin: http(s) → ws(s).
  return `${trimmed.replace(/^http/, 'ws')}/api/events`;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class KaizenEventStream {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly resyncListeners = new Set<ResyncListener>();
  private status: EventStreamStatus = 'closed';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;

  constructor(
    private readonly url: string = eventsWsUrl(),
    private readonly WsImpl: typeof WebSocket = globalThis.WebSocket,
  ) {}

  getStatus(): EventStreamStatus {
    return this.status;
  }

  /** Idempotent: one socket regardless of subscriber count. */
  connect(): void {
    if (this.ws) return;
    this.openSocket();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.statusListeners.size === 0) this.close();
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    // connect() first so the listener is notified by setStatus; only echo
    // the current status if connect() did not produce a transition.
    const before = this.status;
    this.connect();
    if (this.status === before) listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
      if (this.listeners.size === 0 && this.statusListeners.size === 0) this.close();
    };
  }

  /** Fired after each successful reconnect (not the first connect). */
  onResync(listener: ResyncListener): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.setStatus('closed');
  }

  /** Test/teardown helper: fresh backoff + connect allowed again. */
  reset(): void {
    this.close();
    this.attempt = 0;
    this.everConnected = false;
  }

  private openSocket(): void {
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new this.WsImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus('open');
      if (this.everConnected) {
        for (const l of this.resyncListeners) l();
      }
      this.everConnected = true;
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      let msg: { type?: string; name?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return; // never render garbage
      }
      if (msg.type === 'event' && typeof msg.name === 'string') {
        const event = { name: msg.name as KaizenEventName, payload: msg.payload };
        for (const l of this.listeners) l(event);
      }
      // 'hello' only proves the subscription is live (status already 'open').
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; nothing to do (never surfaces as a UI error).
    };
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 && this.statusListeners.size === 0) {
      this.setStatus('closed');
      return; // nobody is watching; do not hold the page open
    }
    this.setStatus('reconnecting');
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    const delay = exp / 2 + Math.random() * (exp / 2); // jitter: 50%..100% of exp
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private setStatus(status: EventStreamStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}
