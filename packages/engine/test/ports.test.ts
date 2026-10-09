import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { PortAllocator, isPortFree } from '@kaizen/engine';

async function canBind(port: number): Promise<boolean> {
  return isPortFree(port);
}

describe('PortAllocator', () => {
  it('allocates four distinct, bindable ports', async () => {
    const allocator = new PortAllocator();
    const ports = await allocator.allocate();
    const all = [ports.p2p, ports.rpc, ports.ws, ports.prometheus];
    expect(new Set(all).size).toBe(4);
    for (const p of all) {
      expect(await canBind(p)).toBe(true);
    }
  });

  it('never returns the same port twice without release', async () => {
    const allocator = new PortAllocator();
    const a = await allocator.allocate();
    const b = await allocator.allocate();
    const overlap = [a.p2p, a.rpc, a.ws, a.prometheus].filter((p) =>
      [b.p2p, b.rpc, b.ws, b.prometheus].includes(p),
    );
    expect(overlap).toEqual([]);
  });

  it('respects custom ranges', async () => {
    const allocator = new PortAllocator({
      p2p: { start: 41100, end: 41109 },
      rpc: { start: 42100, end: 42109 },
      ws: { start: 43100, end: 43109 },
      prometheus: { start: 44100, end: 44109 },
    });
    const ports = await allocator.allocate();
    expect(ports.p2p).toBeGreaterThanOrEqual(41100);
    expect(ports.p2p).toBeLessThanOrEqual(41109);
    expect(ports.prometheus).toBeGreaterThanOrEqual(44100);
  });

  it('avoids ports occupied by live servers', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(41555, '127.0.0.1', resolve));
    try {
      const allocator = new PortAllocator({
        p2p: { start: 41555, end: 41556 },
        rpc: { start: 42555, end: 42556 },
        ws: { start: 43555, end: 43556 },
        prometheus: { start: 44555, end: 44556 },
      });
      const ports = await allocator.allocate();
      expect(ports.p2p).not.toBe(41555);
      expect(ports.p2p).toBe(41556);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('isPortFree', () => {
  it('reports occupied ports as not free', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(41777, '127.0.0.1', resolve));
    try {
      expect(await isPortFree(41777)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await isPortFree(41777)).toBe(true);
  });
});
