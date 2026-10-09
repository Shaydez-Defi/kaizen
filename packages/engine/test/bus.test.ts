import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@kaizen/engine';

describe('EventBus', () => {
  it('delivers typed events to subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((name, payload) => {
      seen.push(`${name}:${(payload as { networkId: string }).networkId}`);
    });
    bus.emit('network.status', {
      networkId: 'net_1',
      name: 'alpha',
      status: 'running',
      at: new Date().toISOString(),
    });
    expect(seen).toEqual(['network.status:net_1']);
  });

  it('unsubscribes cleanly', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);
    bus.emit('operation.completed', {
      operationId: 1,
      kind: 'network.create',
      ok: true,
      durationMs: 5,
      at: new Date().toISOString(),
    });
    off();
    bus.emit('operation.completed', {
      operationId: 2,
      kind: 'network.create',
      ok: true,
      durationMs: 5,
      at: new Date().toISOString(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount).toBe(0);
  });

  it('isolates listener failures — a broken listener cannot break emit', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('listener bug');
    });
    bus.subscribe(good);
    expect(() =>
      bus.emit('network.status', {
        networkId: 'net_x',
        name: 'x',
        status: 'running',
        at: new Date().toISOString(),
      }),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
