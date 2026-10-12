/** Test-only fixtures: a scripted WebSocket double (never used in prod code). */

type Listener = (ev: unknown) => void;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(url ? this : this);
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no FakeWebSocket instances');
    return ws;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  open(): void {
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Server-side close: the client should schedule a reconnect. */
  serverClose(): void {
    this.closed = true;
    this.onclose?.();
  }

  send(_data: string): void {
    /* client→server not used by the stream */
  }
}

/** JSON response double for fetch(). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function emptyResponse(): Response {
  return new Response('', { status: 200 });
}
