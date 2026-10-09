/**
 * Port allocation for node processes.
 *
 * Each node needs 4 ports (p2p, HTTP RPC, WS RPC, Prometheus). The allocator
 * probe-binds candidates on 127.0.0.1 to avoid collisions with unrelated
 * processes and reserves ports in-memory for the lifetime of the allocator.
 */

import net from 'node:net';
import { KaizenError } from '../errors';
import type { NodePorts } from '../types';

export interface PortRange {
  start: number;
  end: number;
}

export interface PortAllocatorOptions {
  p2p?: PortRange;
  rpc?: PortRange;
  ws?: PortRange;
  prometheus?: PortRange;
  /** How many candidates to try per service before failing. */
  maxAttempts?: number;
}

const DEFAULT_RANGES = {
  // Kept away from the node defaults (30333/9933/9944/9615) so ad-hoc manual
  // nodes never collide with Kaizen-managed ones.
  p2p: { start: 31000, end: 31999 },
  rpc: { start: 32000, end: 32999 },
  ws: { start: 33000, end: 33999 },
  prometheus: { start: 34000, end: 34999 },
};

/** Returns true if a TCP port can be bound on 127.0.0.1 right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(
  range: PortRange,
  used: Set<number>,
  maxAttempts: number,
): Promise<number> {
  const span = range.end - range.start + 1;
  for (let i = 0; i < Math.min(maxAttempts, span); i++) {
    const port = range.start + ((i * 7919) % span); // stride to spread probes
    if (used.has(port)) continue;
    if (await isPortFree(port)) {
      used.add(port);
      return port;
    }
  }
  throw new KaizenError(
    'PORT_ALLOCATION_FAILED',
    `No free port found in range ${range.start}-${range.end} after ${maxAttempts} attempts`,
    { range },
  );
}

export class PortAllocator {
  private readonly ranges: Record<keyof NodePorts, PortRange>;
  private readonly maxAttempts: number;
  private readonly used = new Set<number>();

  constructor(options: PortAllocatorOptions = {}) {
    this.ranges = {
      p2p: options.p2p ?? DEFAULT_RANGES.p2p,
      rpc: options.rpc ?? DEFAULT_RANGES.rpc,
      ws: options.ws ?? DEFAULT_RANGES.ws,
      prometheus: options.prometheus ?? DEFAULT_RANGES.prometheus,
    };
    this.maxAttempts = options.maxAttempts ?? 200;
  }

  async allocate(): Promise<NodePorts> {
    const [p2p, rpc, ws, prometheus] = await Promise.all([
      findFreePort(this.ranges.p2p, this.used, this.maxAttempts),
      findFreePort(this.ranges.rpc, this.used, this.maxAttempts),
      findFreePort(this.ranges.ws, this.used, this.maxAttempts),
      findFreePort(this.ranges.prometheus, this.used, this.maxAttempts),
    ]);
    return { p2p, rpc, ws, prometheus };
  }

  release(ports: NodePorts): void {
    this.used.delete(ports.p2p);
    this.used.delete(ports.rpc);
    this.used.delete(ports.ws);
    this.used.delete(ports.prometheus);
  }
}
