import { describe, expect, it } from 'vitest';
import {
  assertSafeArgs,
  buildNodeArgs,
  FORBIDDEN_FLAGS,
  httpUrlForPort,
  wsUrlForPort,
} from '@kaizen/engine';

const BASE = {
  name: 'test-node',
  baseDir: '/tmp/kaizen-test/node',
  ports: { p2p: 31001, rpc: 32001, ws: 33001, prometheus: 34001 },
  nodeKeyFile: '/tmp/kaizen-test/node/node.key',
};

describe('buildNodeArgs', () => {
  it('builds a dev-chain single-node argv', () => {
    const args = buildNodeArgs({ ...BASE, chain: 'dev', wellKnownKey: 'alice' });
    expect(args).toEqual([
      '--dev',
      '--alice',
      '--base-path',
      '/tmp/kaizen-test/node',
      '--port',
      '31001',
      '--rpc-port',
      '32001',
      '--ws-port',
      '33001',
      '--prometheus-port',
      '34001',
      '--node-key-file',
      '/tmp/kaizen-test/node/node.key',
      '--no-telemetry',
    ]);
  });

  it('builds a local-spec argv with bootnodes for the dependent node', () => {
    const args = buildNodeArgs({
      ...BASE,
      chain: { specPath: '/tmp/net/chain-spec.json' },
      wellKnownKey: 'bob',
      bootnodes: ['/ip4/127.0.0.1/tcp/31000/p2p/12D3KooWABC'],
    });
    expect(args).toContain('--chain');
    expect(args).toContain('/tmp/net/chain-spec.json');
    expect(args).toContain('--bob');
    expect(args).toContain('--bootnodes');
    expect(args).toContain('/ip4/127.0.0.1/tcp/31000/p2p/12D3KooWABC');
  });

  it('uses --name for nodes without a well-known key', () => {
    const args = buildNodeArgs({ ...BASE, chain: 'dev', validator: true });
    expect(args).toContain('--name');
    expect(args).toContain('test-node');
    expect(args).toContain('--validator');
    expect(args.some((a) => a.startsWith('--alice'))).toBe(false);
  });

  it('NEVER emits --tmp, and always emits --base-path', () => {
    const args = buildNodeArgs({ ...BASE, chain: 'dev', wellKnownKey: 'alice' });
    expect(args).not.toContain('--tmp');
    expect(args).toContain('--base-path');
    // --tmp with --base-path would be a clap-level hard error on the real binary
    expect(args.includes('--tmp') && args.includes('--base-path')).toBe(false);
  });

  it('never emits external/unsafe RPC flags', () => {
    const args = buildNodeArgs({ ...BASE, chain: 'dev', wellKnownKey: 'alice' });
    for (const flag of FORBIDDEN_FLAGS) {
      expect(args).not.toContain(flag);
    }
  });
});

describe('assertSafeArgs', () => {
  it('rejects argv containing forbidden flags', () => {
    for (const flag of FORBIDDEN_FLAGS) {
      expect(() => assertSafeArgs(['--base-path', '/x', flag])).toThrowError(/forbidden flag/);
    }
  });

  it('rejects argv without --base-path', () => {
    expect(() => assertSafeArgs(['--dev', '--alice'])).toThrowError(/base-path is required/);
  });

  it('accepts a valid argv', () => {
    const args = buildNodeArgs({ ...BASE, chain: 'dev', wellKnownKey: 'alice' });
    expect(() => assertSafeArgs(args)).not.toThrow();
  });
});

describe('url helpers', () => {
  it('builds ws/http urls', () => {
    expect(wsUrlForPort(33001)).toBe('ws://127.0.0.1:33001');
    expect(httpUrlForPort(32001)).toBe('http://127.0.0.1:32001');
  });
});
