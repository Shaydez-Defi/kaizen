/**
 * WebSocket stream unit tests (scripted socket double): event dispatch,
 * single-socket guarantee, reconnect with backoff, resync notification,
 * and teardown when nobody is listening.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaizenEventStream } from './events';
import { FakeWebSocket } from '../test-utils/fake';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeStream(): KaizenEventStream {
  return new KaizenEventStream('ws://test/api/events', FakeWebSocket as unknown as typeof WebSocket);
}

describe('KaizenEventStream', () => {
  it('connects once no matter how many subscribers', () => {
    const stream = makeStream();
    const off1 = stream.subscribe(() => undefined);
    const off2 = stream.subscribe(() => undefined);
    stream.onStatus(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);
    off1();
    off2();
  });

  it('delivers typed events to every subscriber and ignores garbage frames', () => {
    const stream = makeStream();
    const a: unknown[] = [];
    const b: unknown[] = [];
    stream.subscribe((e) => a.push(e));
    stream.subscribe((e) => b.push(e));
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'hello', version: '0.1.0' });
    ws.message({ type: 'event', name: 'network.created', payload: { networkId: 'net_1' } });
    ws.message('not json {');
    ws.message({ type: 'something-else' });
    expect(a).toEqual([{ name: 'network.created', payload: { networkId: 'net_1' } }]);
    expect(b).toEqual(a);
  });

  it('reconnects with backoff after a drop and fires resync on the NEW socket only', () => {
    const stream = makeStream();
    const events: string[] = [];
    let resyncs = 0;
    stream.subscribe(() => events.push('event'));
    stream.onResync(() => (resyncs += 1));

    const first = FakeWebSocket.last();
    first.open();
    expect(resyncs).toBe(0);

    first.serverClose(); // connection drops
    expect(stream.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(10_000); // past capped backoff
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.open();
    expect(resyncs).toBe(1);
    second.message({ type: 'event', name: 'network.status', payload: { status: 'running' } });
    expect(events).toHaveLength(1);
  });

  it('does not reconnect when nothing is listening', () => {
    const stream = makeStream();
    const off = stream.subscribe(() => undefined);
    FakeWebSocket.last().open();
    off(); // last subscriber leaves
    FakeWebSocket.last().serverClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
    expect(stream.getStatus()).toBe('closed');
  });

  it('close() tears the socket and timers down', () => {
    const stream = makeStream();
    stream.subscribe(() => undefined);
    FakeWebSocket.last().open();
    stream.close();
    expect(FakeWebSocket.last().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(stream.getStatus()).toBe('closed');
  });

  it('reports status transitions to listeners', () => {
    const stream = makeStream();
    const seen: string[] = [];
    stream.onStatus((s) => seen.push(s));
    FakeWebSocket.last().open();
    FakeWebSocket.last().serverClose();
    expect(seen).toEqual(['connecting', 'open', 'reconnecting']);
  });
});
